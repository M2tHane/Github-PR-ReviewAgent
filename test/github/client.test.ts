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

test("合并 compare 读取文件 patch，默认分支 recursive tree 保留截断标记", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    requests.push(path);
    assert.equal((init!.headers as Record<string, string>).authorization, "Bearer installation-token");
    if (path === "/repos/o/r/compare/old...merged?per_page=1")
      return Response.json({
        status: "ahead",
        files: [{ filename: "new.ts", previous_filename: "old.ts", patch: "@@ -20 +20 @@" }],
      });
    if (path === "/repos/o/r") return Response.json({ default_branch: "release/main" });
    assert.equal(path, "/repos/o/r/git/trees/release%2Fmain?recursive=1");
    return Response.json({ sha: "tree", truncated: true, tree: [{ path: "src/a.ts", type: "blob" }] });
  });
  const client = new GitHubClient("1", "");
  assert.deepEqual(await client.compareFiles("installation-token", "o/r", "old", "merged"), {
    status: "ahead",
    files: [{ filename: "new.ts", previous_filename: "old.ts", patch: "@@ -20 +20 @@" }],
  });
  assert.equal((await client.defaultBranchTree("installation-token", "o/r")).truncated, true);
  assert.equal(requests.length, 3);
});

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

test("App 接入清单翻完安装和仓库页，用 installation token 读仓库，失败明确返回", async (t) => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = new GitHubClient("1", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    requests.push(path);
    const authorization = (init!.headers as Record<string, string>).authorization!;
    if (path.startsWith("/app/")) assert(authorization.startsWith("Bearer ey"), "App API 使用 JWT");
    if (path === "/app/installations?per_page=100&page=1")
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({ id: i + 1, suspended_at: i === 0 ? null : "2026-01-01" })),
      );
    if (path === "/app/installations?per_page=100&page=2") return Response.json([{ id: 101, suspended_at: null }]);
    if (path === "/app/installations/1/access_tokens") return Response.json({ token: "install-1" });
    if (path === "/app/installations/101/access_tokens") return Response.json({ token: "install-101" });
    if (path === "/installation/repositories?per_page=100&page=1") {
      if (authorization === "Bearer install-101")
        return Response.json({ total_count: 1, repositories: [{ id: 200, full_name: "Other/Repo" }] });
      assert.equal(authorization, "Bearer install-1");
      return Response.json({
        total_count: 101,
        repositories: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `Owner/Repo-${i}` })),
      });
    }
    assert.equal(path, "/installation/repositories?per_page=100&page=2");
    assert.equal(authorization, "Bearer install-1");
    return Response.json({ total_count: 101, repositories: [{ id: 101, full_name: "Owner/Last" }] });
  });
  const repositories = await client.listInstalledRepositories();
  assert.equal(repositories.length, 102);
  assert.deepEqual(repositories.at(-2), { id: 101, full_name: "owner/last", installation_id: 1 });
  assert.deepEqual(repositories.at(-1), { id: 200, full_name: "other/repo", installation_id: 101 });
  assert.equal(requests.length, 7);
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 502 }));
  await assert.rejects(
    client.listInstalledRepositories(),
    (error) => error instanceof GitHubApiError && error.status === 502,
  );
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
