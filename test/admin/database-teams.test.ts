import { loadDevelopmentConfig } from "../../src/development/config.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { MemoryRepository } from "../../src/persistence/repositories/memory.repository.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import type { Session } from "../../src/admin/dto.js";
import type { Config } from "../../src/config/config.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { RULE_IMPORT_EXAMPLE } from "../../src/memory/import-format.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();
test("团队管理、规则生命周期、提升和项目覆盖的数据库与 API 闭环", { skip: !fixture.url }, async (t) => {
  const database = new Database(fixture.url!);
  const memories = new MemoryService(database);
  const repositoryMemories = new MemoryRepository(database.pool);
  const secret = "team-test-session-secret".repeat(2);
  const origin = "http://localhost";
  const sessions = memoryStore<Session>(60_000, 10);
  const users = ["service", "teamadmin", "maintainer", "member", "outsider"];
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
  let teamId: string, otherTeam: string, sourceId: string, ruleId: string;
  try {
    await database.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name) VALUES(801,1,'org/one'),(802,1,'org/two')",
    );
    await t.test("服务管理员建团队、划入仓库、指定管理员；成员角色不扩大权限；写操作要求 CSRF", async () => {
      assert.equal((await request("maintainer", "/api/teams", "POST", { name: "无权建团队" })).status, 403);
      assert.equal((await request("service", "/api/teams", "POST", { name: "CSRF" }, "wrong")).status, 403);
      teamId = (await ok("service", "/api/teams", "POST", { name: "平台团队" })).id;
      otherTeam = (await ok("service", "/api/teams", "POST", { name: "其他团队" })).id;
      assert.equal((await request("service", "/api/teams", "POST", { name: "平台团队" })).status, 409);
      await ok("service", `/api/teams/${teamId}`, "PATCH", { name: "共享平台团队" });
      await ok("service", `/api/teams/${teamId}/repositories`, "PUT", { repositoryIds: [801] });
      await ok("service", `/api/teams/${otherTeam}/repositories`, "PUT", { repositoryIds: [801] });
      await ok("service", `/api/teams/${teamId}/members`, "PUT", { login: "TeamAdmin", role: "admin" });
      await ok("teamadmin", `/api/teams/${teamId}/members`, "PUT", { login: "Member", role: "member" });
      const team = (await ok("teamadmin", "/api/teams")).teams[0];
      assert.equal(team.canManage, true);
      assert.deepEqual(team.members, [
        { login: "teamadmin", role: "admin" },
        { login: "member", role: "member" },
      ]);
      assert.equal(
        (await request("teamadmin", `/api/teams/${teamId}/members`, "PUT", { login: "member", role: "admin" })).status,
        403,
      );
      assert.equal(
        (await request("teamadmin", `/api/teams/${teamId}/members`, "DELETE", { login: "teamadmin" })).status,
        403,
      );
      assert.equal(
        (await request("teamadmin", `/api/teams/${teamId}/repositories`, "PUT", { repositoryIds: [802] })).status,
        403,
      );
      assert.equal(
        (await request("member", `/api/teams/${teamId}/members`, "PUT", { login: "extra", role: "member" })).status,
        403,
      );
      assert.equal((await request("member", `/api/teams/${teamId}/memories`)).status, 403);
      assert.deepEqual((await ok("member", "/api/bootstrap")).memories, []);
    });
    await t.test("ACTIVE 项目规则提升为团队候选；团队管理员批准原子替代，审计完整且不进入 Review 召回", async () => {
      sourceId = await seed("必须处理数据库错误");
      assert.equal((await memories.get(801, sourceId))!.level, "should");
      const promoted = await ok("maintainer", `/api/repositories/801/promotions/${sourceId}`, "POST", { teamId });
      ruleId = promoted.id;
      assert.equal(promoted.repositoryId, null);
      assert.equal(promoted.installationId, null);
      assert.equal(promoted.teamId, teamId);
      assert.equal(promoted.status, "CANDIDATE");
      assert.deepEqual(promoted.source, { kind: "promotion", repositoryId: 801, memoryId: sourceId, version: 1 });
      assert.equal((await repositoryMemories.promote(801, sourceId, teamId, actor)).id, ruleId);
      for (const login of ["maintainer", "member", "outsider"]) {
        assert.equal((await request(login, `/api/memories/${ruleId}`, "PATCH", { level: "must" })).status, 403);
        for (const action of ["approve", "reject", "deprecate", "supersede"])
          assert.equal((await request(login, `/api/memories/${ruleId}/${action}`, "POST", {})).status, 403);
      }
      await ok("teamadmin", `/api/memories/${ruleId}`, "PATCH", { level: "must" });
      const approved = await ok("teamadmin", `/api/memories/${ruleId}/approve`, "POST", {});
      assert.equal(approved.status, "ACTIVE");
      assert.equal(approved.level, "must");
      assert.equal(approved.supersedes, sourceId);
      const original = (await memories.get(801, sourceId))!;
      assert.equal(original.status, "SUPERSEDED");
      assert.equal(original.supersededBy, ruleId);
      const audits = (
        await database.pool.query("SELECT memory_id,action FROM memory_audits WHERE memory_id=ANY($1::uuid[])", [
          [sourceId, ruleId],
        ])
      ).rows;
      assert.ok(audits.some((row) => row.memory_id === ruleId && row.action === "promote"));
      assert.ok(audits.some((row) => row.memory_id === ruleId && row.action === "supersede-new"));
      assert.ok(audits.some((row) => row.memory_id === sourceId && row.action === "supersede-old"));
      assert.deepEqual((await memories.retrieveForReview(801, { paths: ["src/main.ts"], text: "" })).memories, []);
      assert.equal((await ok("maintainer", "/api/repositories/801/team-rules")).memories[0].id, ruleId);
      assert.equal((await ok("teamadmin", "/api/bootstrap")).memories[0].id, ruleId);
    });
    await t.test("团队规则版本编辑、忽略、批准、历史和级别；项目例外可关联所属团队规则", async () => {
      assert.equal((await request("teamadmin", `/api/memories/${ruleId}`, "PATCH", { level: "invalid" })).status, 422);
      await ok("teamadmin", `/api/memories/${ruleId}`, "PATCH", { level: "info" });
      assert.equal((await ok("maintainer", `/api/memories/${ruleId}`)).level, "must");
      assert.equal((await ok("maintainer", "/api/repositories/801/team-rules")).memories[0].level, "must");
      await ok("teamadmin", `/api/memories/${ruleId}/reject`, "POST", {});
      assert.equal((await memories.get({ teamId }, ruleId))!.level, "must");
      await ok("teamadmin", `/api/memories/${ruleId}`, "PATCH", { level: "should" });
      await ok("service", `/api/memories/${ruleId}/approve`, "POST", {});
      assert.equal((await memories.get({ teamId }, ruleId))!.version, 3);
      assert.equal((await ok("teamadmin", `/api/memories/${ruleId}`)).versions.length, 3);
      const exceptionId = await seed("项目特殊例外");
      await ok("maintainer", `/api/memories/${exceptionId}`, "PATCH", {
        type: "exception",
        exceptionTo: ruleId,
        scope: { paths: ["src/test/**"] },
      });
      await ok("maintainer", `/api/memories/${exceptionId}/approve`, "POST", {});
      assert.equal((await memories.get(801, exceptionId))!.exceptionTo, ruleId);
      const foreign = await seed("其他仓库例外", 802);
      assert.equal(
        (await request("maintainer", `/api/memories/${foreign}`, "PATCH", { type: "exception", exceptionTo: ruleId }))
          .status,
        422,
      );
    });
    await t.test("覆盖要求理由与所属团队；取消、移出团队立即移除覆盖且重新加入不复活", async () => {
      const path = `/api/repositories/801/rule-overrides/${ruleId}`;
      assert.equal((await request("maintainer", path, "PUT", { action: "disable", reason: " " })).status, 422);
      assert.equal(
        (
          await request("maintainer", `/api/repositories/802/rule-overrides/${ruleId}`, "PUT", {
            action: "disable",
            reason: "不属于该团队",
          })
        ).status,
        422,
      );
      assert.equal(
        (await request("teamadmin", path, "PUT", { action: "disable", reason: "没有仓库权限" })).status,
        403,
      );
      await ok("maintainer", path, "PUT", { action: "level", level: "info", reason: "项目迁移期间只作参考" });
      assert.equal((await ok("maintainer", "/api/repositories/801/team-rules")).overrides[0].level, "info");
      assert.equal((await request("maintainer", path, "DELETE", { reason: " " })).status, 422);
      assert.equal((await ok("maintainer", "/api/repositories/801/team-rules")).overrides.length, 1);
      await ok("maintainer", path, "DELETE", { reason: "迁移完成，恢复团队默认规则" });
      const removalAudit = (
        await database.pool.query("SELECT * FROM memory_audits WHERE memory_id=$1 AND action='override-remove'", [
          ruleId,
        ])
      ).rows[0];
      assert.equal(removalAudit.before_value.reason, "项目迁移期间只作参考");
      assert.deepEqual(removalAudit.after_value, { repositoryId: 801, reason: "迁移完成，恢复团队默认规则" });
      assert.equal(removalAudit.actor_login, "maintainer");
      assert.deepEqual((await ok("maintainer", "/api/repositories/801/team-rules")).overrides, []);
      await ok("maintainer", path, "PUT", { action: "disable", reason: "此项目不使用关系数据库" });
      await ok("service", `/api/teams/${teamId}/repositories`, "PUT", { repositoryIds: [] });
      assert.deepEqual((await ok("maintainer", "/api/repositories/801/team-rules")).overrides, []);
      assert.deepEqual((await ok("maintainer", "/api/repositories/801/team-rules")).memories, []);
      await ok("service", `/api/teams/${teamId}/repositories`, "PUT", { repositoryIds: [801] });
      assert.deepEqual((await ok("maintainer", "/api/repositories/801/team-rules")).overrides, []);
    });
    await t.test("提升批准重新核对来源版本和团队归属，不修改已变化的原规则", async () => {
      const old = await seed("提升后变化的项目规则");
      const candidate = await repositoryMemories.promote(801, old, teamId, actor);
      await memories.edit(801, old, { content: "新版本" }, actor);
      await memories.transition(801, old, "approve", actor);
      await assert.rejects(memories.transition({ teamId }, candidate.id, "approve", actor), /版本已不再生效/);
      assert.equal((await memories.get({ teamId }, candidate.id))!.status, "CANDIDATE");
      const newer = await repositoryMemories.promote(801, old, otherTeam, actor);
      await ok("service", `/api/teams/${otherTeam}/repositories`, "PUT", { repositoryIds: [] });
      await assert.rejects(memories.transition({ teamId: otherTeam }, newer.id, "approve", actor), /已不属于/);
      await assert.rejects(repositoryMemories.promote(802, old, teamId, actor), /只能提升到/);
    });
    await t.test("团队 Markdown 预览与确认复用导入、幂等与审计，团队内替代和停用", async () => {
      const path = `/api/teams/${teamId}/rule-import`;
      const input = { kind: "markdown", documentName: "rules.md", markdown: RULE_IMPORT_EXAMPLE };
      assert.equal((await request("maintainer", path + "/preview", "POST", input)).status, 403);
      const preview = await ok("teamadmin", path + "/preview", "POST", input);
      const selection = { previewId: preview.id, keys: preview.rules.map((rule: any) => rule.key) };
      const result = await ok("teamadmin", path + "/confirm", "POST", selection);
      assert.equal(result.imported.length, 2);
      assert.deepEqual(await ok("teamadmin", path + "/confirm", "POST", selection), result);
      for (const id of result.imported) assert.equal((await memories.get({ teamId }, id))!.status, "ACTIVE");
      const replacement = result.imported[0];
      await ok("teamadmin", `/api/memories/${replacement}`, "PATCH", { level: "info" });
      await ok("teamadmin", `/api/memories/${ruleId}/supersede`, "POST", { candidateId: replacement });
      assert.equal((await memories.get({ teamId }, ruleId))!.supersededBy, replacement);
      await ok("teamadmin", `/api/memories/${replacement}/deprecate`, "POST", {});
      assert.equal((await memories.get({ teamId }, replacement))!.status, "DEPRECATED");
      assert.equal(
        (
          await database.pool.query(
            "SELECT count(*)::int count FROM memory_audits WHERE memory_id=ANY($1::uuid[]) AND action='import'",
            [result.imported],
          )
        ).rows[0].count,
        2,
      );
    });
    await t.test("删除团队级联删除规则、版本、覆盖、成员、归属与预览，保留其他团队", async () => {
      await ok("maintainer", `/api/repositories/801/rule-overrides/${ruleId}`, "PUT", {
        action: "disable",
        reason: "历史规则仍可记录项目决定",
      });
      assert.equal((await request("teamadmin", `/api/teams/${teamId}`, "DELETE")).status, 403);
      await ok("service", `/api/teams/${teamId}`, "DELETE");
      for (const table of ["memories", "rule_overrides", "team_members", "team_repositories", "memory_import_previews"])
        assert.equal(
          (await database.pool.query(`SELECT 1 FROM ${table} WHERE team_id=$1`, [teamId])).rowCount,
          0,
          table,
        );
      assert.equal((await database.pool.query("SELECT 1 FROM teams WHERE id=$1", [otherTeam])).rowCount, 1);
      assert.equal((await memories.get(801, sourceId))!.status, "SUPERSEDED");
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});
