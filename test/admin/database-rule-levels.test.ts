import { loadDevelopmentConfig } from "../../src/development/config.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import type { Session } from "../../src/admin/dto.js";
import type { Config } from "../../src/config/config.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();
test("规则级别编辑与批准按仓库生效，维护权限不变", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const memories = new MemoryService(database);
  const secret = "rule-test-session-secret".repeat(2);
  const origin = "http://localhost";
  const sessions = memoryStore<Session>(60_000, 10);
  const users = ["service", "maintainer", "outsider"];
  for (const [index, login] of users.entries())
    await sessions.set(login, { id: index + 1, login, token: login, csrf: "csrf", expiresAt: Date.now() + 60_000 });
  const config = {
    development: loadDevelopmentConfig({}),
    sessionSecret: secret,
    githubClientId: "id",
    githubClientSecret: "secret",
    githubOAuthCallbackUrl: origin + "/auth/github/callback",
    allowedRepositories: new Set(["org/one", "org/two"]),
    serviceAdmins: new Set(["service"]),
  } as Config;
  const github = {
    hasMaintainerPermission: async (token: string) => token === "maintainer",
  } as unknown as GitHubClient;
  const handler = createAdminHandler(config, database, github, { sessions, states: memoryStore<number>(60_000, 10) });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function request(login: string, path: string, method = "GET", value?: object, csrf = "csrf") {
    const response = await fetch(base + path, {
      method,
      headers: {
        cookie: `session=${login}.${createHmac("sha256", secret).update(login).digest("base64url")}`,
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  async function ok(login: string, path: string, method = "GET", value?: object) {
    const result = await request(login, path, method, value);
    assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result));
    return result.body;
  }
  const actor = { id: 3, login: "maintainer" };
  const seed = async (title: string, repositoryId = 801) => {
    const [id] = await database.insertCandidates({ repositoryId, installationId: 1 } as ReviewJob, [
      {
        type: "engineering_rule",
        title,
        content: title,
        rationale: "人类决定",
        scope: { paths: ["src/**"] },
        source: { pullRequestNumber: 1, commitSha: "source", commentIds: [1] },
        evidence: [],
        confidence: 1,
        uncertainties: [],
      },
    ]);
    await memories.transition(repositoryId, id!, "approve", actor);
    return id!;
  };
  try {
    await database.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name) VALUES(801,1,'org/one'),(802,1,'org/two')",
    );
    const id = await seed("仓库约定");
    const foreign = await seed("其他仓库约定", 802);
    const path = `/api/memories/${id}`;
    let previous = "should";
    for (const level of ["must", "info", "should"]) {
      await ok("maintainer", path, "PATCH", { level });
      assert.equal((await memories.context(801, { text: "" })).full[0]!.level, previous, "批准前仍使用旧版本");
      const saved = await ok("maintainer", path + "/approve", "POST", {});
      assert.equal(saved.level, level);
      assert.equal(saved.repositoryId, 801);
      assert.equal((await memories.context(801, { text: "" })).full[0]!.level, level);
      previous = level;
    }
    assert.equal((await request("outsider", path, "PATCH", { level: "must" })).status, 403);
    assert.equal((await request("service", path, "PATCH", { level: "must" })).status, 403);
    assert.equal((await request("maintainer", path, "PATCH", { level: "must" }, "wrong")).status, 403);
    assert.equal((await request("maintainer", path, "PATCH", { level: "invalid" })).status, 422);
    assert.equal((await request("maintainer", path, "PATCH", { exceptionTo: foreign })).status, 422);
    const bootstrap = await ok("maintainer", "/api/bootstrap");
    assert.ok(!("teams" in bootstrap));
    assert.ok(bootstrap.memories.every((memory: any) => Number.isInteger(memory.repositoryId)));
    for (const endpoint of [
      "/api/teams",
      `/api/repositories/801/promotions/${id}`,
      "/api/repositories/801/team-rules",
      `/api/repositories/801/rule-overrides/${id}`,
    ])
      assert.equal((await request("maintainer", endpoint)).status, 404);
    const removed = await database.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('teams','team_members','team_repositories','rule_overrides')",
    );
    assert.equal(removed.rowCount, 0);
    const columns = await database.pool.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='team_id'",
    );
    assert.equal(columns.rowCount, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});
