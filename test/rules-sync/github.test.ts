import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubClient } from "../../src/github/client.js";
import { SYNC_MARKER } from "../../src/rules-sync/content.js";
const signal = new AbortController().signal;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
test("翻页查 PR，同时检查作者是本 App 的 Bot、分支前缀、标记及 head 仓库；按分支查已关闭 PR", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url);
    requests.push(path.pathname + path.search);
    if (path.pathname === "/app") return Response.json({ slug: "pi-review" });
    // 真实 GitHub 上 App 开的 PR 没有 performed_via_github_app，只能按作者账号认。
    const own = {
      number: 3,
      state: "open",
      body: SYNC_MARKER,
      head: { ref: "pi-review/rules-33333333", sha: "sha", repo: { full_name: "o/r" } },
      user: { login: "Pi-Review[bot]", type: "Bot" },
      performed_via_github_app: null,
    };
    if (path.searchParams.has("head")) {
      assert.equal(path.searchParams.get("state"), "all");
      assert.equal(path.searchParams.get("head"), "o:pi-review/rules-33333333");
      return Response.json([{ ...own, state: "closed" }]);
    }
    if (path.searchParams.get("page") === "1")
      return Response.json([
        { ...own, number: 1, user: { login: "pi-review[bot]", type: "User" } },
        { ...own, number: 2, user: { login: "other-app[bot]", type: "Bot" } },
        { ...own, body: "not a sync PR" },
        { ...own, head: { ...own.head, ref: "user/rules" } },
        { ...own, head: { ...own.head, repo: { full_name: "other/fork" } } },
        ...Array.from({ length: 95 }, () => ({ ...own, body: "ordinary PR" })),
      ]);
    return Response.json([own]);
  });
  const client = new GitHubClient("1", privateKey);
  assert.equal((await client.findRulesSyncPullRequest("token", "o/r", signal))?.number, 3);
  assert.equal(
    (await client.findRulesSyncPullRequest("token", "o/r", signal, "pi-review/rules-33333333"))?.state,
    "closed",
  );
  assert.equal(requests.filter((path) => path === "/app").length, 1, "App 账号只查一次");
  assert.equal(requests.filter((path) => path.includes("/issues/")).length, 0);
});
test("缺文件只认 Contents 的 404；大文件读 blob；分支推进 force=false", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.includes("/git/refs/")) {
      assert.deepEqual(JSON.parse(String(init.body)), { sha: "new", force: false });
      return Response.json({});
    }
    if (path.endsWith("/missing.md")) return Response.json({}, { status: 404 });
    if (path.endsWith("/git/blobs/blob"))
      return Response.json({ encoding: "base64", content: Buffer.from("大文件全文").toString("base64") });
    if (path.endsWith("/dir")) return Response.json({ type: "dir" });
    return Response.json({ type: "file", encoding: "none", sha: "blob" });
  });
  const client = new GitHubClient("1", "");
  assert.equal(await client.rulesSyncFile("token", "o/r", "sha", "missing.md", signal), null);
  assert.equal(await client.rulesSyncFile("token", "o/r", "sha", ".pi-review/rules.md", signal), "大文件全文");
  await assert.rejects(client.rulesSyncFile("token", "o/r", "sha", "dir", signal), /不是普通文件/);
  await client.updateDevelopmentBranch("token", "o/r", "pi-review/rules-branch", "new", signal);
});
