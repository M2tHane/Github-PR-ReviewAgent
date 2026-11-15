import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { MaintainerPermissionCache } from "../../src/admin/permission-cache.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import type { Session } from "../../src/admin/dto.js";

const user: Session = { id: 1, login: "Alice", token: "user-token", csrf: "csrf", expiresAt: Date.now() + 3_600_000 };

test("权限缓存复用并发查询，按用户、仓库隔离，失败不缓存，退出时尚未返回的查询不会重新填入缓存", async () => {
  let now = 0,
    calls = 0;
  let pending = Promise.withResolvers<boolean>();
  const cache = new MaintainerPermissionCache(
    {
      hasMaintainerPermission: async () => {
        calls++;
        return pending.promise;
      },
    },
    () => now,
  );
  const first = cache.check(user, "Owner/Repo"),
    same = cache.check({ ...user, login: "alice" }, "owner/repo");
  assert.equal(calls, 1);
  cache.clear(user);
  pending.resolve(true);
  assert.equal(await first, true);
  assert.equal(await same, true);
  await cache.check(user, "owner/repo");
  assert.equal(calls, 2);
  await cache.check({ ...user, login: "bob" }, "owner/repo");
  await cache.check(user, "owner/other");
  assert.equal(calls, 4);
  now = 5 * 60_000;
  pending = Promise.withResolvers<boolean>();
  const failed = cache.check(user, "owner/repo");
  pending.reject(new Error("GitHub unavailable"));
  await assert.rejects(failed, /unavailable/);
  pending = Promise.withResolvers<boolean>();
  pending.resolve(false);
  assert.equal(await cache.check(user, "owner/repo"), false);
  assert.equal(calls, 6);
});

test("列表和单仓库授权共享 5 分钟正缓存、1 分钟负缓存，退出登录后重新查询", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const config: any = {
    development: { timeoutMs: 1000 },
    allowedRepositories: new Set(["owner/repo"]),
    sessionSecret: "x".repeat(32),
    githubOAuthCallbackUrl: "http://localhost/callback",
  };
  const row = { id: 1, installation_id: 1, full_name: "Owner/Repo", revoked_at: null, enabled: true };
  const db: any = { pool: { query: async () => ({ rows: [row] }) } };
  let allowed = true,
    calls = 0;
  const github: any = {
    hasMaintainerPermission: async () => {
      calls++;
      return allowed;
    },
  };
  const sessions = memoryStore<Session>(3_600_000, 100);
  await sessions.set("first", user);
  const cookie = (id: string) =>
    `session=${id}.${createHmac("sha256", config.sessionSecret).update(id).digest("base64url")}`;
  const server = createServer(
    createAdminHandler(config, db, github, { sessions, states: memoryStore<number>(60_000, 100) }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let sessionId = "first";
  const request = (path: string, method = "GET") =>
    fetch(origin + path, {
      method,
      headers: { cookie: cookie(sessionId), origin: "http://localhost", "x-csrf-token": "csrf" },
      ...(method === "PATCH" ? { body: "{}" } : {}),
    });
  for (let i = 0; i < 4; i++) {
    assert.equal((await request("/api/repositories")).status, 200);
    assert.equal((await request("/api/repositories/1", "PATCH")).status, 200);
  }
  assert.equal(calls, 1);
  allowed = false;
  now += 5 * 60_000 - 1;
  assert.equal((await request("/api/repositories/1", "PATCH")).status, 200);
  assert.equal(calls, 1);
  now++;
  assert.equal((await request("/api/repositories/1", "PATCH")).status, 403);
  assert.equal(calls, 2);
  allowed = true;
  now += 60_000 - 1;
  assert.deepEqual(await (await request("/api/repositories")).json(), []);
  assert.equal(calls, 2);
  now++;
  assert.equal((await request("/api/repositories/1", "PATCH")).status, 200);
  assert.equal(calls, 3);
  assert.equal((await request("/auth/logout", "POST")).status, 204);
  assert.equal((await request("/api/repositories")).status, 401);
  await sessions.set("second", user);
  sessionId = "second";
  assert.equal((await request("/api/repositories")).status, 200);
  assert.equal(calls, 4);
  config.allowedRepositories.clear();
  assert.deepEqual(await (await request("/api/repositories")).json(), []);
  assert.equal((await request("/api/repositories/1", "PATCH")).status, 403);
  assert.equal(calls, 4, "白名单移出立即生效，不被正缓存绕过");
});

test("重新登录到另一 edge 时不会继承旧会话的权限缓存", async () => {
  let calls = 0;
  const github = {
    hasMaintainerPermission: async () => {
      calls++;
      return true;
    },
  };
  const first = new MaintainerPermissionCache(github),
    second = new MaintainerPermissionCache(github);
  await first.check(user, "owner/repo");
  await second.check(user, "owner/repo");
  first.clear(user); // 退出请求只到达第一个实例，共享会话存储已删除旧会话。
  await second.check({ ...user, csrf: "new-login-session" }, "owner/repo");
  assert.equal(calls, 3);
});
