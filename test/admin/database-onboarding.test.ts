import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { Database } from "../../src/persistence/database.js";
import { RepositoryAccess } from "../../src/config/repository-access.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import { createApp } from "../../src/github/webhook/handler.js";
import { useTestDatabase } from "../helpers/database.js";
import type { Session } from "../../src/admin/dto.js";
import type { Config } from "../../src/config/config.js";
import { loadDevelopmentConfig } from "../../src/development/config.js";
import { publishReview } from "../../src/review/review.publisher.js";
import { emptyUsage } from "../../src/review/agent.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const fixture = useTestDatabase();

test("仓库接入跨实例刷新，保留配置基线，移出拦截 Webhook、管理授权与发布", { skip: !fixture.url }, async (t) => {
  const first = new Database(fixture.url!),
    second = new Database(fixture.url!);
  t.after(async () => {
    await first.close();
    await second.close();
  });
  const config = {
    processRole: "edge",
    development: loadDevelopmentConfig({}),
    allowedRepositories: new Set(["owner/configured"]),
    serviceAdmins: new Set(["admin"]),
    webhookSecret: "secret",
    webhookMaxBytes: 100_000,
    port: 0,
    githubClientId: "client",
    githubClientSecret: "secret",
    sessionSecret: "a".repeat(32),
    githubOAuthCallbackUrl: "http://localhost/auth/github/callback",
  } as Config;
  const otherConfig = { ...config, processRole: "worker" as const, allowedRepositories: new Set(["owner/configured"]) };
  const access = new RepositoryAccess(config, first.pool),
    otherAccess = new RepositoryAccess(otherConfig, second.pool);
  const originalSet = config.allowedRepositories,
    otherSet = otherConfig.allowedRepositories;
  await first.pool.query(
    "INSERT INTO repositories(id,installation_id,full_name,revoked_at) VALUES(9001,8,'Owner/Configured',NULL),(9003,8,'Owner/Revoked',now())",
  );
  await access.refresh();
  await otherAccess.refresh();
  let discoveries = 0,
    checks = 0;
  const github: any = {
    listInstalledRepositories: async () => {
      discoveries++;
      return [
        { id: 9001, installation_id: 8, full_name: "Owner/Configured" },
        { id: 9002, installation_id: 8, full_name: "Owner/New" },
        { id: 9003, installation_id: 8, full_name: "Owner/Revoked" },
      ];
    },
    hasMaintainerPermission: async () => {
      checks++;
      return true;
    },
  };
  const sessions = memoryStore<Session>(60_000, 100);
  const cookie = (id: string) =>
    `session=${id}.${createHmac("sha256", config.sessionSecret!).update(id).digest("base64url")}`;
  for (const login of ["Admin", "viewer"])
    await sessions.set(login, {
      id: login === "Admin" ? 1 : 2,
      login,
      token: "token",
      csrf: login,
      expiresAt: Date.now() + 60_000,
    });
  const handler = createAdminHandler(
    config,
    first,
    github,
    { sessions, states: memoryStore<number>(60_000, 100) },
    undefined,
    access,
  );
  const server = createApp(config, first, handler, github).server;
  const otherServer = createApp(
    otherConfig,
    second,
    createAdminHandler(
      otherConfig,
      second,
      github,
      { sessions, states: memoryStore<number>(60_000, 100) },
      undefined,
      otherAccess,
    ),
    github,
  ).server;
  for (const item of [server, otherServer]) {
    await new Promise<void>((resolve) => item.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => item.close(() => resolve())));
  }
  const origin = (item: typeof server) => `http://127.0.0.1:${(item.address() as any).port}`;
  const request = (
    path: string,
    {
      login = "Admin",
      method = "GET",
      value,
      csrf = login,
      instance = server,
    }: { login?: string; method?: string; value?: unknown; csrf?: string; instance?: typeof server } = {},
  ) =>
    fetch(origin(instance) + path, {
      method,
      headers: { cookie: cookie(login), origin: "http://localhost", "x-csrf-token": csrf },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const change = (id: number, allowed: unknown, login = "Admin", csrf = login) =>
    request(`/api/repository-onboarding/${id}`, { method: "PUT", value: { allowed }, login, csrf });
  const webhook = async (pr: number) => {
    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 8 },
      repository: { id: 9002, full_name: "Owner/New" },
      pull_request: {
        number: pr,
        title: "review",
        body: "",
        state: "open",
        draft: false,
        base: { sha: "a".repeat(40) },
        head: { sha: "b".repeat(40), repo: { full_name: "Owner/New" } },
      },
    });
    return fetch(origin(otherServer) + "/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`,
      },
      body: payload,
    });
  };
  assert.equal((await request("/api/repository-onboarding", { login: "viewer" })).status, 403);
  assert.equal(discoveries, 0, "非服务管理员不读取 App 清单");
  assert.equal((await change(9002, true, "viewer")).status, 403);
  const listing = await request("/api/repository-onboarding");
  assert.equal(listing.status, 200);
  const rows = (await listing.json()) as any[];
  assert.deepEqual(
    rows.map((r) => [r.fullName, r.allowed, r.source]),
    [
      ["owner/configured", true, "config"],
      ["owner/new", false, null],
      ["owner/revoked", false, null],
    ],
  );
  assert(rows[2].revokedAt, "远端清单不能清除本地撤销状态");
  assert.equal((await change(9002, true, "Admin", "wrong")).status, 403);
  assert.equal((await change(9001, false)).status, 409);
  assert.equal((await change(9001, true)).status, 200);
  assert.equal((await change(9003, true)).status, 409);
  assert.equal((await change(9999, true)).status, 404);
  assert.equal((await change(9002, "true")).status, 422);
  assert.equal((await webhook(1)).status, 200);
  assert.equal((await first.pool.query("SELECT count(*)::int n FROM jobs WHERE repository_id=9002")).rows[0].n, 0);
  const added = await change(9002, true);
  assert.equal(added.status, 200);
  const value = (await added.json()) as any;
  assert.deepEqual([value.allowed, value.source, value.allowedBy], [true, "admin", "Admin"]);
  assert(value.allowedAt);
  assert.equal(config.allowedRepositories, originalSet);
  assert(config.allowedRepositories.has("owner/new"));
  assert(!otherConfig.allowedRepositories.has("owner/new"));
  await otherAccess.refresh();
  assert.equal(otherConfig.allowedRepositories, otherSet);
  assert(otherSet.has("owner/new"));
  const queued = await webhook(2);
  assert.equal(queued.status, 202);
  const { jobId } = (await queued.json()) as any;
  assert(jobId);
  const list = await request("/api/repositories", { instance: otherServer });
  assert(((await list.json()) as any[]).some((r) => r.id === 9002));
  assert.equal(
    (await request("/api/repositories/9002", { method: "PATCH", value: { enabled: true }, instance: otherServer }))
      .status,
    200,
  );
  assert.equal(checks, 2, "列表和详情共用同一用户、仓库的权限结果");
  assert.equal((await change(9002, false)).status, 200);
  assert(!originalSet.has("owner/new"));
  await otherAccess.refresh();
  assert(!otherSet.has("owner/new"));
  assert(otherSet.has("owner/configured"));
  assert.equal((await webhook(3)).status, 200);
  assert.equal((await first.pool.query("SELECT count(*)::int n FROM jobs WHERE repository_id=9002")).rows[0].n, 1);
  const removed = await request("/api/repositories", { instance: otherServer });
  assert(!((await removed.json()) as any[]).some((r) => r.id === 9002));
  assert.equal((await request(`/api/jobs/${jobId}`, { instance: otherServer })).status, 403);
  // 已开始的任务持有同一个配置对象，发布检查立即读到更新后的白名单。
  const job = {
    id: jobId,
    repositoryId: 9002,
    repository: "Owner/New",
    prNumber: 2,
    headSha: "b".repeat(40),
    status: "running",
  } as ReviewJob;
  const result = { summary: "done", findings: [], coverage: [], limitations: [] };
  let posted = false;
  await publishReview(
    otherConfig,
    {
      getPullRequest: async () => ({ state: "open", draft: false, head: { sha: job.headSha } }),
      createReview: async () => {
        posted = true;
      },
    } as any,
    second,
    job,
    "token",
    new AbortController(),
    { result, model: "test", durationMs: 0, usage: emptyUsage() },
    [],
    result,
  );
  assert.equal(job.status, "superseded");
  assert.equal(posted, false);
  const last = await request("/api/repository-onboarding");
  const entry = ((await last.json()) as any[]).find((r) => r.id === 9002);
  assert.deepEqual([entry.allowed, entry.managedAllowed, entry.allowedBy], [false, false, "Admin"]);
  await first.pool.query("UPDATE repositories SET allowed=true,revoked_at=now() WHERE id=9003");
  await otherAccess.refresh();
  assert(!otherSet.has("owner/revoked"));
});
