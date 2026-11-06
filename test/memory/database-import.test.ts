import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { RuleImportService } from "../../src/memory/import.service.js";
import { RULE_IMPORT_EXAMPLE } from "../../src/memory/import-format.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import type { Config } from "../../src/config/config.js";
import { repository, type Session } from "../../src/admin/dto.js";
import { useTestDatabase } from "../helpers/database.js";
import type { GitHubClient } from "../../src/github/client.js";

const fixture = useTestDatabase();
const actor = { id: 501, login: "importer" };
const markdown = { kind: "markdown" as const, documentName: "rules.md", markdown: RULE_IMPORT_EXAMPLE };
async function setup(id: number) {
  const database = new Database(fixture.url!);
  const result = await database.pool.query(
    "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2) RETURNING *",
    [id, `team/project-${id}`],
  );
  return {
    database,
    target: repository(result.rows[0]),
    service: new RuleImportService(database),
    memories: new MemoryService(database),
  };
}

test("预览无副作用，确认生效和审计；重复/并发导入幂等，编辑仍需确认", { skip: !fixture.url }, async () => {
  const { database, target, service, memories } = await setup(701);
  try {
    const preview = await service.preview(target, actor, markdown);
    assert.equal((await memories.list(target.id)).length, 0);
    const keys = preview.rules.map((rule) => rule.key);
    const [a, b] = await Promise.all([
      service.confirm(target, actor, preview.id, keys),
      service.confirm(target, actor, preview.id, keys),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.imported.length, 2);
    const active = await service.active(target.id);
    assert.equal(active.length, 2);
    assert.equal(active[0]!.confidence, null);
    assert.equal(active[0]!.approvedBy, actor.id);
    assert.equal(active[0]!.source.kind, "markdown_import");
    assert.equal((await database.pool.query("SELECT * FROM memory_audits WHERE actor_id=$1", [actor.id])).rowCount, 2);
    assert.equal((await memories.retrieve(target.id, { paths: ["model/a.ts"], text: "" })).length, 1);
    // Development tasks read this same ACTIVE projection without a candidate-only filter.
    assert.equal(
      (
        await database.pool.query("SELECT id,source FROM memories WHERE repository_id=$1 AND status='ACTIVE'", [
          target.id,
        ])
      ).rowCount,
      2,
    );
    const second = await service.preview(target, actor, markdown);
    assert.ok(second.rules.every((rule) => rule.duplicateId));
    const repeat = await service.confirm(target, actor, second.id, keys);
    assert.equal(repeat.imported.length, 0);
    assert.equal(repeat.skipped.length, 2);
    const newer = await memories.edit(target.id, active[0]!.id, { content: "更新内容" }, actor);
    assert.equal(newer.status, "CANDIDATE");
    assert.equal((await service.active(target.id))[0]!.version, 1);
    await memories.transition(target.id, newer.id, "approve", actor);
    assert.equal((await memories.get(target.id, newer.id))!.confidence, null);
    assert.equal((await memories.get(target.id, newer.id))!.source.kind, "markdown_import");
  } finally {
    await database.close();
  }
});

test("不同预览并发重复导入只产生一份；同名变化需重新预览", { skip: !fixture.url }, async () => {
  const { database, target, service } = await setup(702);
  try {
    const a = await service.preview(target, actor, markdown),
      b = await service.preview(target, actor, markdown);
    const keys = a.rules.map((rule) => rule.key);
    const result = await Promise.all([
      service.confirm(target, actor, a.id, keys),
      service.confirm(target, actor, b.id, keys),
    ]);
    assert.equal(
      result.reduce((sum, item) => sum + item.imported.length, 0),
      2,
    );
    const changed = {
      ...markdown,
      markdown: markdown.markdown.replace("生产数据库使用 MySQL。", "生产数据库使用 MySQL 8。"),
    };
    const before = await service.preview(target, actor, changed);
    assert.ok(before.rules[0]!.sameTitleIds.length);
    await service.confirm(target, actor, before.id, [before.rules[0]!.key]);
    assert.equal((await service.active(target.id)).length, 3);
  } finally {
    await database.close();
  }
});

test("跨项目独立副本、路径调整、来源失效和例外原子关联", { skip: !fixture.url }, async () => {
  const { database, target, service, memories } = await setup(703);
  try {
    const source = repository(
      (
        await database.pool.query(
          "INSERT INTO repositories(id,installation_id,full_name) VALUES(704,2,'team/source') RETURNING *",
        )
      ).rows[0],
    );
    const exceptionDoc = markdown.markdown.replace(
      "## TEAM-002｜金额使用最小货币单位\n\n类型：工程规范",
      "## TEAM-002｜金额使用最小货币单位\n\n类型：例外规则\n例外关联：TEAM-001",
    );
    const original = await service.preview(source, actor, { ...markdown, markdown: exceptionDoc });
    await assert.rejects(service.confirm(source, actor, original.id, ["TEAM-002"]), /同时勾选原规则/);
    assert.equal((await service.active(source.id)).length, 0);
    await service.confirm(source, actor, original.id, ["TEAM-001", "TEAM-002"]);
    const sourceRules = await service.active(source.id);
    const input = {
      kind: "project" as const,
      sourceRepositoryId: source.id,
      rules: sourceRules.map((rule) => ({ id: rule.id, paths: ["target/**"] })),
    };
    const preview = await service.preview(target, actor, input, source);
    const result = await service.confirm(
      target,
      actor,
      preview.id,
      preview.rules.map((rule) => rule.key),
    );
    assert.equal(result.imported.length, 2);
    const copied = await service.active(target.id);
    const copiedException = copied.find((rule) => rule.type === "exception")!;
    assert.ok(copied.some((rule) => rule.id === copiedException.exceptionTo && rule.type !== "exception"));
    assert.ok(copied.every((rule) => rule.source.kind === "project_import" && rule.source.repositoryId === source.id));
    assert.ok(copied.every((rule) => rule.scope.paths![0] === "target/**"));
    const stale = await service.preview(target, actor, input, source);
    const sourceNormal = sourceRules.find((rule) => rule.type !== "exception")!;
    await memories.transition(source.id, sourceNormal.id, "deprecate", actor);
    await assert.rejects(
      service.confirm(
        target,
        actor,
        stale.id,
        stale.rules.map((rule) => rule.key),
      ),
      /来源规则/,
    );
    assert.equal((await service.active(target.id)).length, 2);
    await assert.rejects(
      service.preview(
        target,
        actor,
        { ...input, rules: input.rules.filter((rule) => rule.id !== sourceNormal.id) },
        source,
      ),
      /同时选择/,
    );
  } finally {
    await database.close();
  }
});

test("确认批次失败全部回滚；预览绑定用户/目标/有效期", { skip: !fixture.url }, async () => {
  const { database, target, service } = await setup(705);
  try {
    const preview = await service.preview(target, actor, markdown);
    await assert.rejects(service.previewSource(target.id, 0, preview.id), /预览不存在/);
    await assert.rejects(service.previewSource(701, actor.id, preview.id), /预览不存在/);
    const newRule = await service.preview(target, actor, {
      ...markdown,
      markdown: markdown.markdown.replace("金额使用整数形式的最小货币单位", "金额统一为整数"),
    });
    await service.confirm(target, actor, newRule.id, ["TEAM-002"]);
    await assert.rejects(service.confirm(target, actor, preview.id, ["TEAM-001", "TEAM-002"]), /新增了同名/);
    assert.equal((await service.active(target.id)).length, 1);
    await database.pool.query("UPDATE memory_import_previews SET expires_at=now()-interval '1 second' WHERE id=$1", [
      preview.id,
    ]);
    await assert.rejects(service.confirm(target, actor, preview.id, ["TEAM-001"]), /过期/);
  } finally {
    await database.close();
  }
});

test("导入 API 每次校验 CSRF 和两端权限，不信任客户端来源与状态", { skip: !fixture.url }, async () => {
  const { database, target, service } = await setup(706);
  const secret = "rule-import-test-session-secret-32-bytes";
  const session: Session = { ...actor, token: "test-token", csrf: "test-csrf", expiresAt: Date.now() + 60_000 };
  const store = { get: async () => session, set: async () => true, delete: async () => {} };
  const allowed = new Set([target.fullName, "team/source-api"]);
  const config = {
    githubClientId: "test",
    githubClientSecret: "test",
    sessionSecret: secret,
    githubOAuthCallbackUrl: "http://localhost/auth/github/callback",
  } as Config;
  const github = { hasMaintainerPermission: async (_token: string, name: string) => allowed.has(name) } as GitHubClient;
  const handler = createAdminHandler(config, database, github, {
    sessions: store,
    states: { ...store, get: async () => Date.now() },
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const cookie = `session=test.${createHmac("sha256", secret).update("test").digest("base64url")}`;
  async function request(operation: string, value: unknown, csrf = true) {
    return fetch(`http://127.0.0.1:${port}/api/repositories/${target.id}/rule-import/${operation}`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        "x-csrf-token": csrf ? session.csrf : "wrong",
      },
      body: JSON.stringify(value),
    });
  }
  try {
    assert.equal((await request("preview", markdown, false)).status, 403);
    const previewResponse = await request("preview", {
      ...markdown,
      status: "ACTIVE",
      source: { pullRequestNumber: 999 },
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as any;
    assert.equal(preview.rules[0].source.kind, "markdown_import");
    assert.equal(preview.rules[0].source.pullRequestNumber, undefined);
    allowed.delete(target.fullName);
    assert.equal((await request("confirm", { previewId: preview.id, keys: ["TEAM-001"] })).status, 403);
    allowed.add(target.fullName);
    const source = repository(
      (
        await database.pool.query(
          "INSERT INTO repositories(id,installation_id,full_name) VALUES(707,2,'team/source-api') RETURNING *",
        )
      ).rows[0],
    );
    const original = await service.preview(source, actor, markdown);
    await service.confirm(source, actor, original.id, ["TEAM-001"]);
    const active = await service.active(source.id);
    const input = { kind: "project", sourceRepositoryId: source.id, rules: [{ id: active[0]!.id, paths: ["src/**"] }] };
    const copy = (await (await request("preview", input)).json()) as any;
    allowed.delete(source.fullName);
    assert.equal((await request("confirm", { previewId: copy.id, keys: [active[0]!.id] })).status, 403);
    assert.equal((await request("preview", input)).status, 403);
    assert.equal((await service.active(target.id)).length, 0);
    allowed.add(source.fullName);
    assert.equal((await request("confirm", { previewId: copy.id, keys: [active[0]!.id] })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("例外不能绑定仅历史内容相同的原规则；批内重复原规则可以单独勾选", { skip: !fixture.url }, async () => {
  const { database, target, service, memories } = await setup(708);
  try {
    const normal = markdown.markdown.split("## TEAM-002")[0]!;
    const duplicate = normal.replace("# 团队规则\n", "").replace("TEAM-001", "TEAM-COPY");
    const exception =
      "\n## EXCEPTION｜测试例外\n类型：例外规则\n适用路径：`test/**`\n例外关联：TEAM-COPY\n### 规则内容\n测试允许 SQLite。\n### 制定原因\n测试隔离。\n";
    const preview = await service.preview(target, actor, { ...markdown, markdown: normal + duplicate + exception });
    const result = await service.confirm(target, actor, preview.id, ["TEAM-COPY", "EXCEPTION"]);
    assert.equal(result.imported.length, 2);
    const parent = (await service.active(target.id)).find((rule) => rule.type !== "exception")!;
    const edit = await memories.edit(target.id, parent.id, { content: "另一种已确认要求" }, actor);
    await memories.transition(target.id, edit.id, "approve", actor);
    await assert.rejects(
      service.preview(target, actor, { ...markdown, markdown: normal + duplicate + exception }),
      /未生效/,
    );
    const cycle = normal.replace("类型：工程规范", "类型：例外规则\n例外关联：TEAM-001");
    await assert.rejects(service.preview(target, actor, { ...markdown, markdown: cycle }), /循环/);
  } finally {
    await database.close();
  }
});
