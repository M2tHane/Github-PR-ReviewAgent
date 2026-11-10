import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startModelProxy, type ProxyHooks } from "../../src/pi/model-proxy.js";
import { BudgetError, requestTokenBudget } from "../../src/pi/types.js";

// 替身上游：按到达顺序交给 handler 回应，记录请求次数。
async function fakeUpstream(t: test.TestContext, handler: (response: ServerResponse, index: number) => void) {
  let count = 0;
  const server = createServer((request, response) => {
    const index = count++;
    request.resume();
    request.on("end", () => handler(response, index));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => count };
}

async function proxyFor(t: test.TestContext, url: string, retry?: ProxyHooks["retry"], delays = [1, 1]) {
  const calls = { retry: 0, answered: [] as boolean[] };
  const proxy = await startModelProxy(
    url,
    "real-key",
    {
      prepare: async (body) => body,
      retry: async (body, answered) => {
        calls.retry++;
        calls.answered.push(answered);
        return retry ? retry(body, answered) : body;
      },
      rejected: () => undefined,
    },
    delays,
  );
  t.after(() => proxy.close());
  const send = (signal?: AbortSignal) =>
    fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ max_tokens: 100 }),
      signal,
    });
  return { proxy, calls, send };
}

const reply = (response: ServerResponse, status: number, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ status }));
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("输入预留：没有比例时按字节数；有比例时按 1.25 倍估算，但不超过字节数", () => {
  const context = { messages: [{ role: "user", content: "订单导出 order export ".repeat(200) }] };
  const bytes = Buffer.byteLength(JSON.stringify(context));
  const plain = requestTokenBudget(context, 100_000);
  assert.deepEqual(plain, { maxTokens: 16_384, reservedTokens: bytes + 1024 + 16_384, bytes });
  for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.deepEqual(requestTokenBudget(context, 100_000, [], invalid), plain);
  const calibrated = requestTokenBudget(context, 100_000, [], 0.2);
  assert.equal(calibrated.reservedTokens, Math.ceil(bytes * 0.2 * 1.25) + 1024 + 16_384);
  assert(calibrated.reservedTokens < plain.reservedTokens);
  assert.deepEqual(requestTokenBudget(context, 100_000, [], 3), plain, "比例异常大时不超过字节数算法");
  // 剩余预算按估算判断：字节数算法拒绝的请求，按比例估算后可以发送。
  assert.throws(() => requestTokenBudget(context, bytes, []), BudgetError);
  assert.ok(requestTokenBudget(context, bytes, [], 0.2).maxTokens > 0);
});

test("上游网络错误或 503 时重试同一请求，成功后照常转发", async (t) => {
  const upstream = await fakeUpstream(t, (response, index) => {
    if (index === 0) return void response.socket?.destroy();
    if (index === 1) return reply(response, 503);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const { calls, send } = await proxyFor(t, upstream.url);
  const response = await send();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(upstream.count(), 3);
  assert.equal(calls.retry, 2);
  assert.deepEqual(calls.answered, [false, true], "连接断开算结果未知，503 算上游明确没处理");
});

test("连续 3 次 429：重试 2 次后把最后一次的上游响应交给 Pi", async (t) => {
  const upstream = await fakeUpstream(t, (response) => reply(response, 429));
  const { send } = await proxyFor(t, upstream.url);
  const response = await send();
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { status: 429 });
  assert.equal(upstream.count(), 3);
});

test("剩余预算不够重新预留时不重试，Pi 收到上游的原错误", async (t) => {
  const upstream = await fakeUpstream(t, (response) => reply(response, 503));
  const { calls, send } = await proxyFor(t, upstream.url, async () => {
    throw new BudgetError();
  });
  const response = await send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 503 });
  assert.equal(upstream.count(), 1);
  assert.equal(calls.retry, 1);
});

test("Retry-After 超过 10 秒不在会话里等，原样返回；不超过时按它等", async (t) => {
  const long = await fakeUpstream(t, (response) => reply(response, 429, { "retry-after": "30" }));
  const longProxy = await proxyFor(t, long.url);
  const response = await longProxy.send();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(long.count(), 1);
  assert.equal(longProxy.calls.retry, 0);

  const short = await fakeUpstream(t, (response, index) => reply(response, index ? 200 : 503, { "retry-after": "0" }));
  // 默认等待设得很长：按 Retry-After: 0 立即重试才能在测试时限内完成。
  const shortProxy = await proxyFor(t, short.url, undefined, [60_000, 60_000]);
  assert.equal((await shortProxy.send()).status, 200);
  assert.equal(short.count(), 2);
});

test("已开始转发响应后上游中断：不重试", async (t) => {
  const upstream = await fakeUpstream(t, (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"partial":true}\n\n');
    setTimeout(() => response.socket?.destroy(), 50);
  });
  const { calls, send } = await proxyFor(t, upstream.url);
  const response = await send();
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  await pause(100);
  assert.equal(upstream.count(), 1);
  assert.equal(calls.retry, 0);
});

test("等待重试期间被取消：立刻结束，不再发请求", async (t) => {
  const upstream = await fakeUpstream(t, (response) => reply(response, 503));
  // Pi 进程被结束（取消或超时）时连接断开。
  const first = await proxyFor(t, upstream.url, undefined, [500, 500]);
  const controller = new AbortController();
  const pending = first.send(controller.signal).catch((error) => error);
  while (!upstream.count()) await pause(10);
  controller.abort();
  assert((await pending) instanceof Error);
  await pause(700);
  assert.equal(upstream.count(), 1);
  assert.equal(first.calls.retry, 0);

  // 会话结束时关闭代理，正在等待的请求一起结束。
  const second = await proxyFor(t, upstream.url, undefined, [5_000, 5_000]);
  const waiting = second.send().catch((error) => error);
  while (upstream.count() < 2) await pause(10);
  const started = Date.now();
  await second.proxy.close();
  await waiting;
  assert(Date.now() - started < 1_000, `关闭用时 ${Date.now() - started}ms`);
  assert.equal(upstream.count(), 2);
  assert.equal(second.calls.retry, 0);
});
