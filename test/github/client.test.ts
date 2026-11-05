import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError, GitHubClient } from "../../src/github/client.js";
import { transient } from "../../src/jobs/runner.js";

function hangingFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
}

test("GitHub 请求挂住时按上限超时并可重试，调用方主动取消不算超时", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const client = new GitHubClient("1", "", 20);

  globalThis.fetch = hangingFetch();
  const timedOut = await client.getPullRequest("token", "o/r", 1).then(() => undefined, (error: Error) => error);
  assert.match(timedOut!.message, /GitHub 请求超时：\/repos\/o\/r\/pulls\/1/);
  assert.equal(transient(timedOut!), true);

  const controller = new AbortController();
  const pending = client.healthChecks("token", "o/r", "sha", controller.signal);
  controller.abort(new Error("cancelled by job"));
  await assert.rejects(pending, /cancelled by job/);

  globalThis.fetch = (async () => new Response("{}", { status: 502 })) as typeof fetch;
  await assert.rejects(client.getPullRequest("token", "o/r", 1), (error) => error instanceof GitHubApiError && error.status === 502);
});
