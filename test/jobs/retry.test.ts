import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError, GitHubClient } from "../../src/github/client.js";
import { transient } from "../../src/jobs/runner.js";
import type { Pool } from "pg";
import type { AgentJob } from "../../src/jobs/types.js";
import { JobRepository, retryDelaySeconds } from "../../src/persistence/repositories/job.repository.js";
import { BudgetError, ProviderError, TimeoutError } from "../../src/review/agent.js";
import { remainingBudget } from "../../src/review/review.processor.js";
import { emptyUsage } from "../../src/review/agent.js";

test("能否重试先看错误类型：模型限流 / 过载可以重试，额度用完和参数错误不重试", () => {
  assert.equal(transient(new ProviderError("429 Too Many Requests: rate limit exceeded")), true);
  assert.equal(transient(new ProviderError('{"type":"overloaded_error"}')), true);
  assert.equal(transient(new ProviderError("fetch failed")), true);
  assert.equal(transient(new ProviderError("Upstream request failed")), true, "模型网关间歇返回的上游故障");
  assert.equal(transient(new ProviderError("429 insufficient_quota: You exceeded your current quota")), false);
  assert.equal(transient(new ProviderError("400 invalid request: max_tokens too large")), false);
  assert.equal(transient(new ProviderError()), false, "没有说明的错误不盲目重试");
});

test("GitHub 按状态码判断：429、5xx 和带等待时间的 403（二级限流）重试，其余 403 / 404 不重试", () => {
  assert.equal(transient(new GitHubApiError("/x", 429)), true);
  assert.equal(transient(new GitHubApiError("/x", 502)), true);
  assert.equal(transient(new GitHubApiError("/x", 403, 60)), true);
  assert.equal(transient(new GitHubApiError("/x", 403)), false);
  assert.equal(transient(new GitHubApiError("/repos/o/r500/pulls/1", 404)), false, "路径里的数字不会被误判成 5xx");
});

test("网络错误按错误码判断；预算不足不重试；整次执行超时不重试", () => {
  const network = new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) });
  assert.equal(transient(network), true);
  assert.equal(transient(new Error("x", { cause: Object.assign(new Error("y"), { code: "UND_ERR_SOCKET" }) })), true);
  assert.equal(transient(new BudgetError("预算 500 用完")), false);
  assert.equal(transient(new TimeoutError()), false);
  assert.equal(transient(new ProviderError("Request timed out")), true, "模型服务自己报的超时仍可重试");
  assert.equal(transient(new Error("Workspace head SHA 不匹配")), false);
});

test("超时的任务以 timeout 结束，不回到队列", async () => {
  const writes: unknown[][] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      writes.push(values);
      return { rows: [{ status: values[1] }] };
    },
  };
  const repository = new JobRepository(pool as unknown as Pool);
  // 处理器遇到 TimeoutError 时把任务标成 timeout 再抛出，Runner 按 transient() 决定是否重排。
  const job = { id: "j", status: "timeout", attempt: 1 } as AgentJob;
  const error = new TimeoutError();
  await repository.failJob(job, error, transient(error));
  assert.equal(writes[0]![1], "timeout");
  assert.equal(job.status, "timeout");
});

test("退避：30 秒起翻倍、单次最长 15 分钟；服务方给了等待时间就照它，最长 1 小时", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 10].map((attempt) => retryDelaySeconds(attempt)),
    [30, 60, 120, 240, 900],
  );
  assert.equal(retryDelaySeconds(1, 5), 5);
  assert.equal(retryDelaySeconds(1, 0), 0);
  assert.equal(retryDelaySeconds(1, 99_999), 3600);
});

test("模型错误带上服务方说明，打码并截断", () => {
  const error = new ProviderError(`401 bad key sk-ant-api03-${"a".repeat(90)} ${"x".repeat(500)}`);
  assert.match(error.message, /^模型服务请求失败：401 bad key/);
  assert.doesNotMatch(error.message, /aaaaaaaaaa/);
  assert.ok(error.message.length < 330);
  assert.equal(error.retryable, false);
});

test("GitHub 主限流用尽时按重置时间算等待秒数", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const client = new GitHubClient("1", "");
  const reset = Math.floor(Date.now() / 1000) + 120;
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    })) as typeof fetch;
  const limited = await client.getPullRequest("t", "o/r", 1).catch((error) => error);
  assert.ok(limited instanceof GitHubApiError);
  assert.ok(limited.retryAfterSeconds! >= 118 && limited.retryAfterSeconds! <= 121);
  assert.equal(transient(limited), true);
  globalThis.fetch = (async () =>
    new Response("{}", { status: 403, headers: { "retry-after": "30" } })) as typeof fetch;
  assert.equal(
    ((await client.getPullRequest("t", "o/r", 1).catch((error) => error)) as GitHubApiError).retryAfterSeconds,
    30,
  );
  globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  const denied = (await client.getPullRequest("t", "o/r", 1).catch((error) => error)) as GitHubApiError;
  assert.equal(denied.retryAfterSeconds, undefined);
  assert.equal(transient(denied), false, "权限不足不重试");
});

test("预算按任务累计：重试时扣掉之前尝试用掉的 Token，用完就不再重试", async () => {
  const usage = { ...emptyUsage(), totalTokens: 15_000, unreportedTokens: 3_000 };
  const store = { jobUsage: async () => usage };
  assert.equal(await remainingBudget(store, "j", 20_000), 2_000);
  assert.equal(await remainingBudget(undefined, "j", 20_000), 20_000);
  await assert.rejects(remainingBudget(store, "j", 18_000), BudgetError);
});
