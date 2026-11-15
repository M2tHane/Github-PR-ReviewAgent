import assert from "node:assert/strict";
import test from "node:test";
import { api, setCsrf } from "../../frontend/api/client.js";
import { usageText, usageTotal } from "../../frontend/format.js";

test("admin API preserves JSON, CSRF, error and abort behavior", async (t) => {
  const requests: { path: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    return new Response(requests.length === 3 ? JSON.stringify({ error: "保存失败" }) : JSON.stringify({ ok: true }), {
      status: requests.length === 3 ? 403 : 200,
      headers: { "content-type": "application/json" },
    });
  });
  setCsrf("session-token");
  const controller = new AbortController();
  assert.deepEqual(await api("/api/bootstrap", { signal: controller.signal }), { ok: true });
  assert.deepEqual(await api("/api/repositories/1", { method: "PATCH", body: "{}" }), { ok: true });
  await assert.rejects(api("/api/memories/1/approve", { method: "POST", body: "{}" }), /保存失败/);
  assert.equal(requests[0]?.path, "/api/bootstrap");
  assert.equal(requests[0]?.init.signal, controller.signal);
  assert.equal((requests[0]?.init.headers as Record<string, string>)["x-csrf-token"], undefined);
  assert.equal((requests[1]?.init.headers as Record<string, string>)["x-csrf-token"], "session-token");
  assert.equal((requests[2]?.init.headers as Record<string, string>)["content-type"], "application/json");
});

test("formats complete agent usage with readable component labels", () => {
  const usage = { input: 1_234, cacheRead: 2_345, cacheWrite: 3_456, output: 4_567, totalTokens: 11_602 };
  assert.equal(usageText(usage), "新输入\u00a01,234 · 缓存读取\u00a02,345 · 缓存写入\u00a03,456 · 输出\u00a04,567");
  assert.equal(usageTotal(usage), 11_602);
});

test("shows em dashes when usage has no readable fields", () => {
  assert.equal(usageText({ usage: {} }), "新输入\u00a0— · 缓存读取\u00a0— · 缓存写入\u00a0— · 输出\u00a0—");
  assert.equal(usageTotal({ usage: {} }), undefined);
});

test("falls back to legacy input and output columns", () => {
  const legacy = { usage: {}, usage_input_tokens: 120, usage_output_tokens: 80 };
  assert.equal(usageText(legacy), "新输入\u00a0120 · 缓存读取\u00a0— · 缓存写入\u00a0— · 输出\u00a080");
  assert.equal(usageTotal(legacy), 200);
});

test("formats large usage numbers with thousands separators", () => {
  assert.equal(
    usageText({ input: 3_340_000, cacheRead: 0, cacheWrite: 0, output: 3_340_000 }),
    "新输入\u00a03,340,000 · 缓存读取\u00a00 · 缓存写入\u00a00 · 输出\u00a03,340,000",
  );
});
