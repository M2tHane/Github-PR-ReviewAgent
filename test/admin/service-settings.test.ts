import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import * as admin from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import { SettingsValidationError } from "../../src/config/service-settings.js";

// 登录两个人：admin 在 SERVICE_ADMINS 里，viewer 只维护一个仓库，stranger 什么仓库都不维护。
test("服务设置接口：管理员可以改，仓库维护者只读，没有仓库权限的人看不到", async () => {
  const repos = [
    {
      id: 1,
      installation_id: 1,
      full_name: "owner/repo",
      enabled: true,
      include_paths: [],
      exclude_paths: [],
      output_language: "zh",
      budget_tokens: 1000,
      health_schedule: "off",
    },
  ];
  const db: any = {
    pool: { query: async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM repositories") ? repos : [] }) },
  };
  let login = "";
  const github: any = {
    exchangeOAuthCode: async () => "token",
    getUser: async () => ({ id: login.length, login }),
    hasMaintainerPermission: async (token: string) => token !== "stranger",
  };
  github.exchangeOAuthCode = async () => login.toLowerCase();
  const updates: Array<[Record<string, unknown>, string]> = [];
  const settings: any = {
    list: async () => ({ settings: [], audits: [] }),
    update: async (changes: Record<string, unknown>, actor: string) => {
      if ("BAD" in changes) throw new SettingsValidationError("BAD：不能修改");
      updates.push([changes, actor]);
      return { settings: [], audits: [] };
    },
  };
  const config: any = {
    githubClientId: "client",
    githubClientSecret: "secret",
    githubOAuthCallbackUrl: "http://localhost/auth/github/callback",
    sessionSecret: "a".repeat(32),
    serviceAdmins: new Set(["admin"]),
  };
  const stores = { sessions: memoryStore<any>(60_000, 100), states: memoryStore<number>(60_000, 100) };
  const server = createServer(admin.createAdminHandler(config, db, github, stores, settings));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const signIn = async (name: string) => {
    login = name;
    const start = await fetch(origin + "/auth/github", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const callback = await fetch(origin + `/auth/github/callback?code=ok&state=${state}`, {
      redirect: "manual",
      headers: { cookie: start.headers.getSetCookie()[0]!.split(";")[0]! },
    });
    const cookie = callback.headers.getSetCookie()[0]!.split(";")[0]!;
    const { csrf } = (await (await fetch(origin + "/api/session", { headers: { cookie } })).json()) as any;
    return {
      get: () => fetch(origin + "/api/service-settings", { headers: { cookie } }),
      put: (value: unknown) =>
        fetch(origin + "/api/service-settings", {
          method: "PUT",
          headers: { cookie, "x-csrf-token": csrf, origin: "http://localhost", "content-type": "application/json" },
          body: JSON.stringify(value),
        }),
    };
  };
  try {
    const owner = await signIn("Admin");
    const view: any = await (await owner.get()).json();
    assert.equal(view.canEdit, true, "用户名不区分大小写");
    assert(view.definitions.length > 10);
    assert.equal(view.definitions[0].read, undefined, "不把函数发给页面");
    assert.equal((await owner.put({ values: { AGENT_TIMEOUT_MS: 600_000 }, reset: ["MODEL_NAME"] })).status, 200);
    assert.deepEqual(updates, [[{ AGENT_TIMEOUT_MS: 600_000, MODEL_NAME: undefined }, "Admin"]]);
    assert.equal((await owner.put({ values: { BAD: 1 } })).status, 422);
    assert.equal((await owner.put({ values: [] })).status, 422);

    const viewer = await signIn("viewer");
    const readOnly: any = await (await viewer.get()).json();
    assert.equal(readOnly.canEdit, false);
    assert.equal(readOnly.adminsConfigured, true);
    assert.equal((await viewer.put({ values: { AGENT_TIMEOUT_MS: 600_000 } })).status, 403);

    const stranger = await signIn("stranger");
    assert.equal((await stranger.get()).status, 403);
    assert.equal(updates.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
