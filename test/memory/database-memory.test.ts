import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { Database } from "../../src/persistence/database.js";
import { PersistentRunner } from "../../src/jobs/runner.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import type { DecisionProposal } from "../../src/memory/types.js";
import type { ReplyResult } from "../../src/reply/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { createServer } from "node:http";
import { createAdminHandler } from "../../src/admin/handler.js";
import type { Config } from "../../src/config/config.js";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emptyUsage } from "../../src/review/agent.js";
import { groupFindings } from "../../src/review/presentation.js";
import { GitHubApiError, type GitHubClient } from "../../src/github/client.js";
import { createDecisionProcessor } from "../../src/memory/decision.processor.js";
import { createApp } from "../../src/github/webhook/handler.js";
import { useTestDatabase, waitFor } from "../helpers/database.js";
import type { Finding } from "../../src/review/types.js";

const fixture = useTestDatabase();

test("规则使用统计：提供、引用结局、重试、跨版本和任务清理", { skip: !fixture.url }, async (t) => {
  const database = new Database(fixture.url!);
  const service = new MemoryService(database);
  const repositoryId = 9_000_000_010;
  const actor = { id: 42, login: "maintainer" };
  const zero = {
    provided: 0,
    cited: 0,
    fixed: 0,
    inferredFixed: 0,
    withdrawn: 0,
    exception: 0,
    open: 0,
    lastCitedAt: null,
  };
  const source = { repositoryId, installationId: 1, repository: "owner/memory-usage", prNumber: 1 } as ReviewJob;
  let prNumber = 1;
  const review = async (repo = repositoryId) => {
    const job = (
      await database.accept(
        {
          deliveryId: randomUUID(),
          installationId: 1,
          repositoryId: repo,
          repository: `owner/memory-usage-${repo}`,
          cloneUrl: "url",
          prNumber: prNumber++,
          title: "",
          body: "",
          baseSha: "base",
          headSha: randomUUID(),
        },
        { event: "pull_request", action: "opened" },
      )
    ).job! as ReviewJob;
    job.status = "running";
    await database.finishJob(job);
    return job;
  };
  try {
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
      repositoryId,
      source.repository,
    ]);
    const ids = await database.insertCandidates(
      source,
      ["被引用的规则", "提供但未引用", "从未提供"].map((title) => ({
        type: "engineering_rule",
        title,
        content: title,
        rationale: "人类已确认",
        scope: { paths: ["src/**"] },
        source: { pullRequestNumber: 1, commitSha: "merged", commentIds: [1] },
        evidence: [],
        confidence: 1,
        uncertainties: [],
      })),
    );
    for (const id of ids) await service.transition(repositoryId, id, "approve", actor);
    const firstId = ids[0]!;
    const usage = async (id = firstId) => (await service.list(repositoryId)).find((memory) => memory.id === id)!.usage;
    const finding = (description: string, version = 1, extra: Partial<Finding> = {}): Finding => ({
      path: "src/a.ts",
      line: 1,
      side: "RIGHT",
      category: "team_rule",
      severity: "medium",
      evidenceLevel: "strong",
      description,
      evidence: "evidence",
      impact: "impact",
      memory: { id: firstId, version, source: {} },
      ...extra,
    });

    await t.test("未提供全零；两条规则提供一次，只有一条被撤回意见引用；重试和删除", async () => {
      for (const id of ids) assert.deepEqual(await usage(id), zero);
      const job = await review();
      const recalled = (await service.context(repositoryId, { paths: ["src/a.ts"], text: "" })).full.filter(
        (memory) => memory.id !== ids[2],
      );
      await database.saveReviewMemoryUsage(job, recalled);
      const withdrawn = finding("被撤回的意见");
      const [stored] = await database.saveFindings(job, [withdrawn], new Set());
      const citedAt = "2025-01-01T00:00:00.000Z";
      await database.pool.query("UPDATE review_findings SET status='WITHDRAWN',created_at=$2 WHERE id=$1", [
        stored!.id,
        citedAt,
      ]);
      const expected = { ...zero, provided: 1, cited: 1, withdrawn: 1, lastCitedAt: citedAt };
      assert.deepEqual(await usage(), expected);
      assert.deepEqual(await usage(ids[1]), { ...zero, provided: 1 });
      assert.deepEqual(await usage(ids[2]), zero);
      await database.saveReviewMemoryUsage(job, recalled);
      await database.saveFindings(job, [withdrawn], new Set());
      assert.deepEqual(await usage(), expected, "同一 Review 重试不重复计数");
      const rows = (await database.pool.query("SELECT * FROM review_memory_usage WHERE job_id=$1", [job.id])).rows;
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.memory_version === 1 && Number(row.repository_id) === repositoryId));
      await database.pool.query("DELETE FROM jobs WHERE id=$1", [job.id]);
      assert.equal(
        (await database.pool.query("SELECT * FROM review_memory_usage WHERE job_id=$1", [job.id])).rowCount,
        0,
      );
      for (const id of ids) assert.deepEqual(await usage(id), zero, "任务删除后提供和引用统计一起消失");
    });

    await t.test("按规则 ID 汇总版本；排除 pending、repeatOf 和非 PR Review；仓库隔离且无 30 天窗口", async () => {
      const old = await review();
      await database.saveReviewMemoryUsage(old, [{ id: firstId, version: 1 }]);
      const [fixed] = await database.saveFindings(old, [finding("旧版已修复")], new Set());
      await database.pool.query("UPDATE review_findings SET status='FIXED',created_at='2025-01-01' WHERE id=$1", [
        fixed!.id,
      ]);
      await service.edit(repositoryId, firstId, { content: "第二版规则" }, actor);
      await service.transition(repositoryId, firstId, "approve", actor);
      const latest = await review();
      await database.saveReviewMemoryUsage(latest, [{ id: firstId, version: 2 }]);
      const statuses = ["WITHDRAWN", "EXCEPTION_PENDING", "OPEN", "STILL_VALID", "NEEDS_CLARIFICATION"];
      const findings = statuses.map((status) => finding(status, 2));
      const stored = await database.saveFindings(latest, findings, new Set());
      const citedAt = "2025-02-01T00:00:00.000Z";
      for (const [index, value] of stored.entries())
        await database.pool.query("UPDATE review_findings SET status=$2,created_at=$3 WHERE id=$1", [
          value.id,
          statuses[index],
          citedAt,
        ]);
      await database.pool.query("UPDATE review_findings SET binding_status='incomplete' WHERE id=$1", [stored[0]!.id]);
      const pending = finding("未发布", 2, { line: 2 });
      await database.saveFindings(latest, [pending], new Set([pending]));
      await database.saveFindings(
        latest,
        [finding("重复", 2, { line: 3, repeatOf: { id: fixed!.id, title: "旧版已修复" } })],
        new Set(),
      );
      const foreign = await review(repositoryId + 1);
      await database.saveReviewMemoryUsage(foreign, [{ id: firstId, version: 2 }]);
      await database.saveFindings(foreign, [finding("外仓意见", 2)], new Set());
      for (const type of ["REPLY_HANDLE", "HEALTH_AUDIT"]) {
        const other = await review();
        await database.pool.query(
          `UPDATE jobs SET job_type=$2,pr_number=CASE WHEN $2='HEALTH_AUDIT' THEN NULL ELSE pr_number END,
           base_sha=CASE WHEN $2='HEALTH_AUDIT' THEN NULL ELSE base_sha END,delivery_id=NULL WHERE id=$1`,
          [other.id, type],
        );
        await database.saveReviewMemoryUsage(other, [{ id: firstId, version: 2 }]);
        await database.saveFindings(other, [finding(`${type} 的意见`, 2)], new Set());
      }
      assert.deepEqual(await usage(), {
        provided: 2,
        cited: 6,
        fixed: 1,
        inferredFixed: 0,
        withdrawn: 1,
        exception: 1,
        open: 3,
        lastCitedAt: citedAt,
      });
      const active = (await service.list(repositoryId, "ACTIVE")).find((memory) => memory.id === firstId)!;
      assert.equal(active.version, 2);
      assert.equal(active.activeVersion, 2);
      assert.deepEqual(await service.list(repositoryId, "CANDIDATE"), []);
      assert.ok(
        !(await service.context(repositoryId, { paths: ["src/a.ts"], text: "" })).full.some(
          (memory) => "usage" in memory,
        ),
        "展示统计不进入召回和模型输入",
      );
    });
  } finally {
    await database.close();
  }
});

test("Memory 生命周期、版本、幂等和 Scope/仓库隔离", { skip: !fixture.url }, async () => {
  const repositoryId = 9_000_000_005;
  const database = new Database(fixture.url!);
  const service = new MemoryService(database);
  const actor = { id: 42, login: "maintainer" };
  const job = {
    id: "00000000-0000-4000-8000-000000000005",
    deliveryId: "memory-source",
    jobType: "DECISION_EXTRACT",
    installationId: 1,
    repositoryId,
    repository: "owner/memory-test",
    cloneUrl: "url",
    prNumber: 8,
    title: "",
    body: "",
    baseSha: "base",
    headSha: "merged",
    status: "running",
  } satisfies ReviewJob;
  const proposal: DecisionProposal = {
    type: "coding_convention",
    title: "DTO Optional",
    content: "Public DTO fields do not use Optional",
    rationale: "Stable serialization",
    scope: { paths: ["backend/**/dto/**"], languages: ["java"] },
    source: { pullRequestNumber: 8, commitSha: "merged", commentIds: [10] },
    evidence: [
      { kind: "human_comment", reference: "10", detail: "decision" },
      { kind: "code", reference: "backend/a/dto/X.java:2", detail: "change" },
    ],
    confidence: 0.9,
    uncertainties: [],
  };
  await database.pool.query(
    "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/memory-test') ON CONFLICT DO NOTHING",
    [repositoryId],
  );
  try {
    const ids = await database.insertCandidates(job, [proposal]);
    assert.equal(ids.length, 1);
    assert.deepEqual(await database.insertCandidates(job, [proposal]), []);
    const id = ids[0]!;
    assert.equal(await service.get(repositoryId + 1, id), undefined);
    assert.equal((await service.transition(repositoryId, id, "approve", actor)).status, "ACTIVE");
    assert.equal(
      (await service.retrieve(repositoryId, { paths: ["backend/a/dto/X.java"], text: "Optional DTO" })).length,
      1,
    );
    assert.equal(
      (await service.retrieve(repositoryId, { paths: ["frontend/X.java"], text: "Optional DTO" })).length,
      0,
    );
    const edited = await service.edit(repositoryId, id, { content: "Public DTO fields never use Optional" }, actor);
    assert.equal(edited.version, 2);
    assert.equal(edited.status, "CANDIDATE");
    assert.equal(
      (await service.retrieve(repositoryId, { paths: ["backend/a/dto/X.java"], text: "Optional DTO" }))[0]?.version,
      1,
    );
    assert.equal((await service.list(repositoryId))[0]?.activeVersion, 1);
    await service.transition(repositoryId, id, "reject", actor);
    assert.equal((await service.get(repositoryId, id))?.version, 1);
    assert.equal((await service.list(repositoryId, "ACTIVE"))[0]?.version, 1);
    const nextEdit = await service.edit(
      repositoryId,
      id,
      { content: "DTO fields use ordinary nullable values" },
      actor,
    );
    assert.equal(nextEdit.version, 3);
    assert.equal((await service.transition(repositoryId, id, "approve", actor)).status, "ACTIVE");
    const versions = await database.pool.query("SELECT version,status FROM memories WHERE id=$1 ORDER BY version", [
      id,
    ]);
    assert.deepEqual(
      versions.rows.map((row) => [row.version, row.status]),
      [
        [1, "SUPERSEDED"],
        [2, "REJECTED"],
        [3, "ACTIVE"],
      ],
    );
    const second = await database.insertCandidates({ ...job, prNumber: 9, headSha: "merged-2" }, [
      {
        ...proposal,
        title: "New DTO rule",
        content: "Use plain nullable DTO fields",
        source: { pullRequestNumber: 9, commitSha: "merged-2", commentIds: [11] },
      },
    ]);
    await service.transition(repositoryId, second[0]!, "approve", actor);
    await service.edit(repositoryId, second[0]!, { content: "Use ordinary nullable fields for public DTOs" }, actor);
    const exception = await database.insertCandidates({ ...job, prNumber: 10, headSha: "merged-3" }, [
      {
        ...proposal,
        type: "exception",
        content: "Scoped exception",
        relation: { exceptionTo: id },
        source: { pullRequestNumber: 10, commitSha: "merged-3", commentIds: [12] },
      },
    ]);
    await assert.rejects(service.supersede(repositoryId, id, exception[0]!, actor), /例外必须保留原规则/);
    assert.equal((await service.get(repositoryId, id))?.status, "ACTIVE");
    assert.equal((await service.supersede(repositoryId, id, second[0]!, actor)).status, "ACTIVE");
    assert.equal(
      (
        await database.pool.query("SELECT count(*)::int count FROM memories WHERE id=$1 AND status='ACTIVE'", [
          second[0],
        ])
      ).rows[0].count,
      1,
    );
    assert.equal((await service.get(repositoryId, id))?.status, "SUPERSEDED");
    assert.equal((await service.transition(repositoryId, second[0]!, "deprecate", actor)).status, "DEPRECATED");
    assert.equal((await service.retrieve(repositoryId, { paths: ["backend/a/dto/X.java"], text: "DTO" })).length, 0);
  } finally {
    await database.pool.query(
      "DELETE FROM memory_audits WHERE memory_id IN (SELECT id FROM memories WHERE repository_id=$1)",
      [repositoryId],
    );
    await database.pool.query("DELETE FROM memories WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
    await database.close();
  }
});

test("批准候选按关系原子替代生效规则，记录审计并保留例外约束", { skip: !fixture.url }, async (t) => {
  const database = new Database(fixture.url!);
  const service = new MemoryService(database);
  const repositoryId = 9_000_000_008;
  const actor = { id: 42, login: "maintainer" };
  const job = {
    repositoryId,
    installationId: 1,
    repository: "owner/approve-relations",
    prNumber: 1,
  } as ReviewJob;
  const proposal: DecisionProposal = {
    type: "engineering_rule",
    title: "rule",
    content: "rule",
    rationale: "confirmed decision",
    scope: { paths: ["src/**"] },
    source: { pullRequestNumber: 1, commitSha: "merged", commentIds: [1] },
    evidence: [
      { kind: "human_comment", reference: "1", detail: "decision" },
      { kind: "code", reference: "src/a.ts:1", detail: "change" },
    ],
    confidence: 1,
    uncertainties: [],
  };
  const seed = async (title: string, patch: Partial<DecisionProposal> = {}, target = job) =>
    (await database.insertCandidates(target, [{ ...proposal, title, content: title, ...patch }]))[0]!;
  const audits = async (id: string) =>
    (
      await database.pool.query(
        "SELECT action,before_value,after_value,actor_id,actor_login FROM memory_audits WHERE memory_id=$1",
        [id],
      )
    ).rows;
  try {
    await database.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/approve-relations'),($2,1,'owner/other-relations')",
      [repositoryId, repositoryId + 1],
    );
    await t.test("ACTIVE 关系目标与候选自身旧版本同时替代，双向关联和审计完整", async () => {
      const oldId = await seed("待替代原规则");
      await service.transition(repositoryId, oldId, "approve", actor);
      const candidateId = await seed("替代规则", { relation: { supersedes: oldId } });
      const approved = await service.transition(repositoryId, candidateId, "approve", actor);
      assert.equal(approved.status, "ACTIVE");
      assert.equal(approved.supersedes, oldId);
      assert.equal(approved.approvedBy, actor.id);
      assert.ok(approved.approvedAt);
      const old = (await service.get(repositoryId, oldId))!;
      assert.equal(old.status, "SUPERSEDED");
      assert.equal(old.supersededBy, candidateId);
      const oldAudit = (await audits(oldId)).find((row) => row.action === "supersede-old")!;
      assert.equal(oldAudit.before_value.status, "ACTIVE");
      assert.equal(oldAudit.after_value.status, "SUPERSEDED");
      assert.equal(oldAudit.after_value.supersededBy, candidateId);
      const [newAudit] = await audits(candidateId);
      assert.equal(newAudit.action, "supersede-new");
      assert.equal(newAudit.before_value.status, "CANDIDATE");
      assert.equal(newAudit.after_value.status, "ACTIVE");
      assert.equal(newAudit.after_value.supersedes, oldId);
      assert.equal(Number(newAudit.actor_id), actor.id);
      assert.equal(newAudit.actor_login, actor.login);

      // 已有生效版本的两条规则：目标的新候选不能遮住仍生效的旧版。
      const revisedId = await seed("已有生效版的替代规则");
      await service.transition(repositoryId, revisedId, "approve", actor);
      await service.edit(repositoryId, revisedId, { content: "待批准的修订" }, actor);
      await service.edit(repositoryId, candidateId, { content: "原规则的待批准修订" }, actor);
      await database.pool.query("UPDATE memories SET supersedes=$2 WHERE id=$1 AND status='CANDIDATE'", [
        revisedId,
        candidateId,
      ]);
      const revision = await service.transition(repositoryId, revisedId, "approve", actor);
      assert.equal(revision.version, 2);
      assert.equal(revision.supersedes, candidateId);
      const versions = (
        await database.pool.query(
          "SELECT id,version,status,superseded_by FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id,version",
          [[candidateId, revisedId]],
        )
      ).rows;
      assert.equal(versions.find((row) => row.id === candidateId && row.version === 1).status, "SUPERSEDED");
      assert.equal(versions.find((row) => row.id === candidateId && row.version === 1).superseded_by, revisedId);
      assert.equal(versions.find((row) => row.id === candidateId && row.version === 2).status, "CANDIDATE");
      assert.equal(versions.find((row) => row.id === revisedId && row.version === 1).status, "SUPERSEDED");
      assert.equal(versions.filter((row) => row.status === "ACTIVE").length, 1);
    });
    await t.test("目标已停用时普通批准，关系保留且不改原规则", async () => {
      const oldId = await seed("停用的原规则");
      await service.transition(repositoryId, oldId, "approve", actor);
      await service.transition(repositoryId, oldId, "deprecate", actor);
      const candidateId = await seed("原规则已停用的候选", { relation: { supersedes: oldId } });
      const oldBefore = await service.get(repositoryId, oldId);
      const auditBefore = await audits(oldId);
      const approved = await service.transition(repositoryId, candidateId, "approve", actor);
      assert.equal(approved.status, "ACTIVE");
      assert.equal(approved.supersedes, oldId);
      assert.deepEqual(await service.get(repositoryId, oldId), oldBefore);
      assert.deepEqual(await audits(oldId), auditBefore);
      assert.deepEqual(
        (await audits(candidateId)).map((row) => row.action),
        ["approve"],
      );
    });
    await t.test("跨仓库替代关系不修改其他仓库", async () => {
      const foreignId = await seed("外仓原规则", {}, { ...job, repositoryId: repositoryId + 1 });
      await service.transition(repositoryId + 1, foreignId, "approve", actor);
      const candidateId = await seed("外仓关系候选", { relation: { supersedes: foreignId } });
      assert.equal((await service.transition(repositoryId, candidateId, "approve", actor)).status, "ACTIVE");
      assert.equal((await service.get(repositoryId + 1, foreignId))!.status, "ACTIVE");
      assert.deepEqual(
        (await audits(candidateId)).map((row) => row.action),
        ["approve"],
      );
    });
    await t.test("指向自身时仍按普通新版本批准，规则 ID 大小写不改变判断", async () => {
      const id = await seed("自身关系规则");
      await service.transition(repositoryId, id, "approve", actor);
      await service.edit(repositoryId, id, { content: "新版本" }, actor);
      await database.pool.query("UPDATE memories SET supersedes=id WHERE id=$1 AND status='CANDIDATE'", [id]);
      const approved = await service.transition(repositoryId, id.toUpperCase(), "approve", actor);
      assert.equal(approved.version, 2);
      assert.equal(approved.status, "ACTIVE");
      assert.deepEqual((await audits(id)).map((row) => row.action).sort(), ["approve", "approve", "edit"]);
    });
    await t.test("例外不能批准为其依赖原规则的替代，失败时状态与审计均不改变", async () => {
      const oldId = await seed("例外依赖原规则");
      await service.transition(repositoryId, oldId, "approve", actor);
      const exceptionId = await seed("不能替代原规则的例外", {
        type: "exception",
        relation: { exceptionTo: oldId, supersedes: oldId },
      });
      const auditBefore = await audits(oldId);
      await assert.rejects(service.transition(repositoryId, exceptionId, "approve", actor), /例外必须保留原规则/);
      assert.equal((await service.get(repositoryId, oldId))!.status, "ACTIVE");
      assert.equal((await service.get(repositoryId, exceptionId))!.status, "CANDIDATE");
      assert.deepEqual(await audits(oldId), auditBefore);
      assert.deepEqual(await audits(exceptionId), []);
    });
  } finally {
    await database.close();
  }
});

test("提取器只带相关生效规则，逐条丢弃并保存替代、例外和冲突关系", { skip: !fixture.url }, async (t) => {
  const database = new Database(fixture.url!);
  const service = new MemoryService(database);
  const repositoryId = 9_000_000_006;
  const actor = { id: 42, login: "maintainer" };
  await mkdir("work", { recursive: true });
  const root = await mkdtemp(resolve("work/decision-memory-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  const log = t.mock.method(console, "info", () => {});
  try {
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(root, "a.ts"), "export const value = 1;\n");
    git("add", "a.ts");
    git("commit", "-qm", "merged snapshot");
    const headSha = git("rev-parse", "HEAD");
    const job: ReviewJob = {
      id: randomUUID(),
      deliveryId: "decision-memory",
      jobType: "DECISION_EXTRACT",
      installationId: 1,
      repositoryId,
      repository: "owner/decision-memory",
      cloneUrl: root,
      prNumber: 3,
      title: "旧标题",
      body: "旧正文",
      baseSha: headSha,
      headSha,
      status: "running",
    };
    const proposal: DecisionProposal = {
      type: "engineering_rule",
      title: "提取候选",
      content: "新的明确工程决定",
      rationale: "人类已确认",
      scope: { paths: ["*.ts"] },
      source: { pullRequestNumber: 3, commitSha: headSha, commentIds: [11] },
      evidence: [
        { kind: "human_comment", reference: "11", detail: "人类讨论正文" },
        { kind: "code", reference: "a.ts:1", detail: "最终代码依据" },
      ],
      confidence: 0.9,
      uncertainties: ["仍需维护者确认"],
    };
    await database.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/decision-memory'),($2,1,'owner/other-memory')",
      [repositoryId, repositoryId + 1],
    );
    const seed = async (title: string, scope: DecisionProposal["scope"], target = job) => {
      const [id] = await database.insertCandidates(target, [
        {
          ...proposal,
          title,
          content: title,
          scope,
          source: { ...proposal.source, commitSha: "seed" },
        },
      ]);
      return id!;
    };
    const matchingId = await seed("范围命中", { paths: ["*.ts"] });
    const globalId = await seed("全局规则", {});
    const outsideId = await seed("范围不命中", { paths: ["other/**"] });
    const pendingId = await seed("未批准候选", {});
    const deprecatedId = await seed("已废弃规则", {});
    const otherId = await seed("其他仓库", {}, { ...job, repositoryId: repositoryId + 1 });
    for (const id of [matchingId, globalId, outsideId, deprecatedId]) {
      await service.transition(repositoryId, id, "approve", actor);
    }
    await service.transition(repositoryId, deprecatedId, "deprecate", actor);
    await service.transition(repositoryId + 1, otherId, "approve", actor);
    await service.edit(repositoryId, matchingId, { title: "待批准的新标题" }, actor);

    const github = {
      installationToken: async () => "token",
      getPullRequest: async () => ({
        merged: true,
        merge_commit_sha: headSha,
        head: { sha: headSha },
        title: "变更标题",
        body: "变更说明",
      }),
      getFiles: async () => [{ filename: "a.ts" }],
      getConversationComments: async () => [
        {
          id: 11,
          html_url: "https://example/11",
          body: "确认这个工程决定",
          user: { login: "maintainer", type: "User" },
        },
      ],
      getReviews: async () => [],
      getReviewComments: async () => [],
    } as unknown as GitHubClient;
    const config = { modelProvider: "p", modelName: "m", modelApiKey: "k", agentTimeoutMs: 1000 } as Config;
    const retrieve = t.mock.method(service, "context");
    let output = JSON.stringify([
      { ...proposal, title: 42 },
      { ...proposal, relation: { exceptionTo: outsideId } },
      proposal,
    ]);
    const process = createDecisionProcessor(config, database, service, github, async (input) => {
      const prompt = input.prompt as { existingRules: Array<Record<string, unknown>> };
      assert.deepEqual(prompt.existingRules.map((rule) => rule.id).sort(), [matchingId, globalId].sort());
      for (const rule of prompt.existingRules) {
        assert.deepEqual(
          Object.keys(rule).sort(),
          [
            "id",
            "version",
            "type",
            "title",
            "content",
            "rationale",
            "scope",
            "exceptionTo",
            "supersedes",
            "repositoryId",
            "level",
          ].sort(),
        );
        assert.equal(rule.version, 1);
      }
      assert.equal(prompt.existingRules.find((rule) => rule.id === matchingId)?.title, "范围命中");
      assert.match(input.systemPrompt!, /existingRules/);
      assert.match(input.systemPrompt!, /同一个决定/);
      assert.doesNotMatch(input.systemPrompt!, /duplicateOf/);
      return { text: output, durationMs: 1, model: "m", usage: emptyUsage() };
    });
    const extracted = async () =>
      (
        await database.pool.query(
          "SELECT * FROM memories WHERE repository_id=$1 AND source->>'commitSha'=$2 ORDER BY title",
          [repositoryId, headSha],
        )
      ).rows;
    await process(job);
    assert.deepEqual(retrieve.mock.calls[0]!.arguments, [
      repositoryId,
      { paths: ["a.ts"], text: "变更标题\n变更说明" },
    ]);
    assert.equal((await extracted()).length, 1, "三条中只有合格候选保存");
    const event = JSON.parse(log.mock.calls[0]!.arguments[0]);
    assert.equal(event.event, "decisions_extracted");
    assert.equal(event.candidateCount, 1);
    assert.equal(event.discardedCount, 2);
    assert.deepEqual(event.discardedReasons, { invalid_structure: 1, unknown_rule: 1 });
    assert.ok(!log.mock.calls[0]!.arguments[0].includes(proposal.content), "日志不记录候选正文");

    output = JSON.stringify([
      { ...proposal, title: "冲突", content: "可能冲突的决定", relation: { conflictsWith: [matchingId, globalId] } },
      { ...proposal, title: "例外", type: "exception", content: "局部例外决定", relation: { exceptionTo: matchingId } },
      { ...proposal, title: "替代", content: "替代决定", relation: { supersedes: globalId } },
      { ...proposal, title: "未关联例外", type: "exception", content: "待关联的局部例外" },
      { ...proposal, relation: { duplicateOf: matchingId } },
      ...[pendingId, otherId].map((id) => ({ ...proposal, relation: { supersedes: id } })),
    ]);
    await process(job);
    const rows = await extracted();
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.status === "CANDIDATE"));
    assert.deepEqual(rows.find((row) => row.title === "冲突")?.uncertainties, [
      ...proposal.uncertainties,
      `可能与现有规则「范围命中」冲突（${matchingId}）`,
      `可能与现有规则「全局规则」冲突（${globalId}）`,
    ]);
    assert.equal(rows.find((row) => row.title === "例外")?.exception_to, matchingId);
    assert.equal(rows.find((row) => row.title === "替代")?.supersedes, globalId);
    assert.equal(rows.find((row) => row.title === "未关联例外")?.exception_to, null);
    assert.deepEqual(JSON.parse(log.mock.calls[1]!.arguments[0]).discardedReasons, {
      duplicate_relation: 1,
      unknown_rule: 2,
    });
    await process(job);
    assert.equal((await extracted()).length, 5, "同一来源重跑仍幂等");
    output = "{}";
    await assert.rejects(process(job), /输出必须是数组/);
    assert.equal((await extracted()).length, 5, "非数组失败没有写入候选");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
