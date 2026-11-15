import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError, GitHubClient } from "../../src/github/client.js";
import { transient } from "../../src/jobs/runner.js";

function hangingFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
}

test("GitHub 请求挂住时按上限超时并可重试，调用方主动取消不算超时", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const client = new GitHubClient("1", "", 20);

  globalThis.fetch = hangingFetch();
  const timedOut = await client.getPullRequest("token", "o/r", 1).then(
    () => undefined,
    (error: Error) => error,
  );
  assert.match(timedOut!.message, /GitHub 请求超时：\/repos\/o\/r\/pulls\/1/);
  assert.equal(transient(timedOut!), true);

  const controller = new AbortController();
  const pending = client.healthChecks("token", "o/r", "sha", controller.signal);
  controller.abort(new Error("cancelled by job"));
  await assert.rejects(pending, /cancelled by job/);

  globalThis.fetch = (async () => new Response("{}", { status: 502 })) as typeof fetch;
  await assert.rejects(
    client.getPullRequest("token", "o/r", 1),
    (error) => error instanceof GitHubApiError && error.status === 502,
  );
});

test("标签任务查询发起人的仓库权限，只接受 write、maintain、admin", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const client = new GitHubClient("1", "");
  for (const permission of ["write", "maintain", "admin", "read", "triage", "none"]) {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://api.github.com/repos/o/r/collaborators/alice/permission");
      assert.equal((init!.headers as Record<string, string>).authorization, "Bearer token");
      return new Response(JSON.stringify({ permission }));
    }) as typeof fetch;
    assert.equal(
      await client.hasWritePermission("token", "o/r", "alice"),
      ["write", "maintain", "admin"].includes(permission),
    );
  }
});

test("开发发布核对仅匹配本 App 的 issue/评论，忽略人类、其他 App 和 PR", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const client = new GitHubClient("123", "");
  const marker = "<!-- pi-dev-task:task -->";
  const entries = [
    { id: 1, number: 1, body: marker, user: { type: "User" }, performed_via_github_app: null },
    { id: 2, number: 2, body: marker, user: { type: "Bot" }, performed_via_github_app: { id: 456 } },
    { id: 3, number: 3, body: marker, user: { type: "Bot" }, performed_via_github_app: { id: 123 }, pull_request: {} },
    { id: 4, number: 4, body: marker, user: { type: "Bot" }, performed_via_github_app: { id: 123 } },
  ];
  globalThis.fetch = (async (url) => {
    const address = String(url);
    if (address.includes("/comments?")) return new Response(JSON.stringify(entries.filter((e) => !e.pull_request)));
    assert.match(address, /issues\?state=all&sort=created&direction=desc&per_page=100$/);
    return new Response(JSON.stringify(entries));
  }) as typeof fetch;
  const signal = new AbortController().signal;
  assert.equal((await client.findDevelopmentIssue("token", "o/r", marker, signal))!.number, 4);
  assert.equal((await client.findDevelopmentComment("token", "o/r", 4, marker, signal))!.id, 4);
  assert.equal(await client.findDevelopmentIssue("token", "o/r", "missing", signal), undefined);
});

test("开发评论核对读过第十页，避免长线程重复发评论", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let requests = 0;
  globalThis.fetch = (async (url) => {
    requests++;
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return new Response(
      JSON.stringify(
        page <= 10
          ? Array.from({ length: 100 }, (_, i) => ({
              id: page * 100 + i,
              body: "human",
              user: { type: "User" },
              performed_via_github_app: null,
            }))
          : [
              {
                id: 1101,
                body: "<!-- pi-dev:task:reply -->",
                user: { type: "Bot" },
                performed_via_github_app: { id: 123 },
              },
            ],
      ),
    );
  }) as typeof fetch;
  const found = await new GitHubClient("123", "").findDevelopmentComment(
    "token",
    "o/r",
    1,
    "<!-- pi-dev:task:reply -->",
    new AbortController().signal,
  );
  assert.equal(found!.id, 1101);
  assert.equal(requests, 11);
});
