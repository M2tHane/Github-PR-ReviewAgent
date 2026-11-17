import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { Config } from "../../src/config/config.js";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { RuleImportService } from "../../src/memory/import.service.js";
import { RULE_IMPORT_EXAMPLE } from "../../src/memory/import-format.js";
import { repository, type Session } from "../../src/admin/dto.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import { loadDevelopmentConfig } from "../../src/development/config.js";
import type { ReviewJob, RulesSyncJob } from "../../src/jobs/types.js";
import type { GitHubClient, RulesSyncPullRequest } from "../../src/github/client.js";
import { createRulesSyncProcessor, type RulesSyncGitHub } from "../../src/rules-sync/processor.js";
import { RULES_PATH, SYNC_MARKER } from "../../src/rules-sync/content.js";
import { useTestDatabase } from "../helpers/database.js";
import { seedTeamRule } from "../helpers/team-rule.js";

const fixture = useTestDatabase();
const actor = { id: 1, login: "maintainer" };
const config = {
  allowedRepositories: new Set<string>(),
  githubOAuthCallbackUrl: "https://service/auth/github/callback",
} as Config;

class FakeGitHub implements RulesSyncGitHub {
  base = "base";
  commits = new Map<string, Record<string, string>>([["base", { "AGENTS.md": "# 已有说明\n" }]]);
  parents: string[] = [];
  branches = new Map<string, string>();
  prs: RulesSyncPullRequest[] = [];
  writes: string[] = [];
  interrupt: "before-pr" | "after-pr" | undefined;
  installationToken = async () => "token";
  repositorySnapshot = async () => ({ defaultBranch: "main", headSha: this.base });
  rulesSyncFile = async (_t: string, _r: string, sha: string, path: string) => this.commits.get(sha)![path] ?? null;
  rulesSyncBranch = async (_t: string, _r: string, branch: string) => this.branches.get(branch) ?? null;
  findRulesSyncPullRequest = async (_t: string, _r: string, _s: AbortSignal, branch?: string) =>
    this.prs.find((pr) => (branch ? pr.head.ref === branch : pr.state === "open"));
  developmentCommitTree = async (_t: string, _r: string, sha: string) => sha;
  createDevelopmentCommit: RulesSyncGitHub["createDevelopmentCommit"] = async (_t, _r, base, changes) => {
    this.writes.push("commit");
    this.parents.push(base.sha);
    const sha = randomUUID(),
      files = { ...this.commits.get(base.sha)! };
    for (const change of changes) files[change.path] = change.content!;
    this.commits.set(sha, files);
    return sha;
  };
  createDevelopmentBranch: RulesSyncGitHub["createDevelopmentBranch"] = async (_t, _r, branch, sha) => {
    assert.ok(!this.branches.has(branch));
    this.writes.push("branch");
    this.branches.set(branch, sha);
  };
  updateDevelopmentBranch: RulesSyncGitHub["updateDevelopmentBranch"] = async (_t, _r, branch, sha) => {
    assert.ok(this.branches.has(branch));
    this.writes.push("advance");
    this.branches.set(branch, sha);
    this.prs
      .filter((pr) => pr.head.ref === branch)
      .forEach((pr) => {
        pr.head.sha = sha;
      });
  };
  createDevelopmentPullRequest: RulesSyncGitHub["createDevelopmentPullRequest"] = async (_t, repository, input) => {
    const stop = this.interrupt;
    this.interrupt = undefined;
    if (stop === "before-pr")
      throw Object.assign(new Error("connection interrupted before PR"), { code: "ECONNRESET" });
    const number = this.prs.length + 1,
      sha = this.branches.get(input.head)!;
    this.writes.push("pr");
    this.prs.push({
      number,
      state: "open",
      body: input.body,
      html_url: `https://github.com/${repository}/pull/${number}`,
      head: { sha, ref: input.head, repo: { full_name: repository } },
      user: { login: "pi-review[bot]", type: "Bot" },
    });
    if (stop === "after-pr") throw Object.assign(new Error("response lost after PR"), { code: "ECONNRESET" });
    return { number, head: { sha } };
  };
  updateRulesSyncPullRequest: RulesSyncGitHub["updateRulesSyncPullRequest"] = async (_t, _r, number, body) => {
    this.writes.push("body");
    this.prs.find((pr) => pr.number === number)!.body = body;
  };
}
async function setup(id: number) {
  const db = new Database(fixture.url!);
  const name = `sync/project-${id}`;
  config.allowedRepositories.add(name);
  await db.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [id, name]);
  const memories = new MemoryService(db),
    github = new FakeGitHub(),
    process = createRulesSyncProcessor(config, db, github);
  const seed = async (title = "项目规则") =>
    (
      await db.insertCandidates({ repositoryId: id, installationId: 1 } as ReviewJob, [
        {
          type: "engineering_rule",
          title,
          content: `${title}正文`,
          rationale: "团队已经确认的理由",
          scope: { paths: ["src/**"] },
          source: { pullRequestNumber: 1, commitSha: "sha", commentIds: [] },
          evidence: [],
          confidence: 1,
          uncertainties: [],
        },
      ])
    )[0]!;
  const enqueue = () => db.pool.query("SELECT enqueue_rules_sync($1)", [id]);
  const queued = async () =>
    (
      await db.pool.query("SELECT * FROM jobs WHERE repository_id=$1 AND job_type='RULES_SYNC' AND status='queued'", [
        id,
      ])
    ).rows;
  const enable = () => db.pool.query("UPDATE repositories SET rules_sync_enabled=true WHERE id=$1", [id]);
  const run = async () => {
    const job = await db.claimNext();
    assert.equal(job?.jobType, "RULES_SYNC");
    await process(job as RulesSyncJob);
    await db.finishJob(job!);
    return job as RulesSyncJob;
  };
  return { db, memories, github, process, seed, enqueue, queued, enable, run };
}

test("开启后确认项目规则 → 一次入队、一 PR；确认新版本追加提交；无变化零写；合并后记无变化", {
  skip: !fixture.url,
}, async () => {
  const { db, memories, github, seed, queued, enable, run, enqueue } = await setup(1101);
  try {
    const id = await seed();
    assert.equal((await queued()).length, 0);
    await enable();
    await memories.transition(1101, id, "approve", actor);
    await Promise.all(Array.from({ length: 12 }, enqueue));
    assert.equal((await queued()).length, 1);
    await run();
    assert.deepEqual(github.writes, ["commit", "branch", "pr"]);
    let files = github.commits.get(github.prs[0]!.head.sha)!;
    assert.match(files[RULES_PATH]!, /项目规则正文/);
    assert.match(files["AGENTS.md"]!, /^# 已有说明\n/);
    assert.equal(files["AGENTS.md"]!.split(RULES_PATH).length, 2);
    assert.equal(files["CLAUDE.md"], undefined);
    assert.ok(github.prs[0]!.body!.endsWith(SYNC_MARKER));
    const firstHead = github.prs[0]!.head.sha;
    await memories.edit(1101, id, { content: "修改后的规则正文" }, actor);
    assert.equal((await queued()).length, 0, "待确认版本不触发");
    await memories.transition(1101, id, "approve", actor);
    await run();
    assert.equal(github.prs.length, 1);
    assert.equal(github.branches.size, 1);
    assert.equal(github.parents[1], firstHead);
    assert.deepEqual(github.writes.slice(3), ["commit", "advance"]);
    files = github.commits.get(github.prs[0]!.head.sha)!;
    assert.match(files[RULES_PATH]!, /修改后的规则正文/);
    github.writes = [];
    await enqueue();
    await run();
    assert.deepEqual(github.writes, []);
    github.base = github.prs[0]!.head.sha;
    github.prs[0]!.state = "closed";
    await enqueue();
    await run();
    assert.deepEqual(github.writes, []);
    const result = (await db.pool.query("SELECT rules_sync_status,rules_sync_pr_url FROM repositories WHERE id=1101"))
      .rows[0];
    assert.equal(result.rules_sync_status, "unchanged");
    assert.equal(result.rules_sync_pr_url, null);
  } finally {
    await db.close();
  }
});

for (const interruption of ["before-pr", "after-pr"] as const)
  test(`提交后中断恢复 ${interruption}：复用分支、提交和 PR`, { skip: !fixture.url }, async () => {
    const { db, github, enable, process, run } = await setup(interruption === "before-pr" ? 1102 : 1103);
    try {
      await enable();
      github.interrupt = interruption;
      const job = (await db.claimNext()) as RulesSyncJob;
      await assert.rejects(process(job), /interrupted|response lost/);
      assert.equal(
        (await db.pool.query("SELECT rules_sync_status FROM repositories WHERE id=$1", [job.repositoryId])).rows[0]
          .rules_sync_status,
        "failed",
      );
      await db.pool.query("SELECT enqueue_rules_sync($1)", [job.repositoryId]);
      await db.failJob(job, new Error("connection interrupted"), true);
      assert.equal(
        (await db.pool.query("SELECT id FROM jobs WHERE repository_id=$1 AND status='queued'", [job.repositoryId]))
          .rowCount,
        1,
      );
      await db.pool.query("UPDATE jobs SET next_run_at=now() WHERE id=$1", [job.id]);
      await run();
      assert.equal(github.branches.size, 1);
      assert.equal(github.prs.length, 1);
      assert.equal(github.parents.length, 1);
    } finally {
      await db.close();
    }
  });

test("仓库规则批准、级别更新、导入、替代、停用与删除触发；其他仓库和关闭项目不入队", {
  skip: !fixture.url,
}, async () => {
  const { db, memories, seed, enable } = await setup(1104);
  try {
    await db.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name) VALUES(1105,1,'sync/off'),(1106,1,'sync/on')",
    );
    await enable();
    await db.pool.query("UPDATE repositories SET rules_sync_enabled=true WHERE id=1106");
    const count = async () =>
      (
        await db.pool.query(
          "SELECT repository_id::int id,count(*)::int n FROM jobs WHERE job_type='RULES_SYNC' AND status='queued' GROUP BY repository_id ORDER BY repository_id",
        )
      ).rows;
    const clear = () => db.pool.query("UPDATE jobs SET status='succeeded' WHERE job_type='RULES_SYNC'");
    await clear();
    const team = await seedTeamRule(db, 1104);
    assert.deepEqual(await count(), [{ id: 1104, n: 1 }]);
    await clear();
    await seedTeamRule(db, 1105);
    assert.deepEqual(await count(), [], "同步关闭的仓库不入队");
    await memories.edit(1104, team.id, { content: "仓库新正文", level: "info" }, actor);
    assert.deepEqual(await count(), []);
    await memories.transition(1104, team.id, "approve", actor);
    assert.deepEqual(await count(), [{ id: 1104, n: 1 }]);
    assert.equal((await memories.context(1104, { text: "" })).full.find((rule) => rule.id === team.id)?.level, "info");
    await clear();
    await memories.transition(1104, team.id, "deprecate", actor);
    assert.deepEqual(await count(), [{ id: 1104, n: 1 }]);
    await clear();
    const rule = await seed("要被替代的规则");
    await memories.transition(1104, rule, "approve", actor);
    await clear();
    const replacement = await seed("替代规则");
    await memories.supersede(1104, rule, replacement, actor);
    assert.deepEqual(await count(), [{ id: 1104, n: 1 }]);
    await clear();
    await memories.transition(1104, replacement, "deprecate", actor);
    assert.deepEqual(await count(), [{ id: 1104, n: 1 }]);
    await clear();
    const imports = new RuleImportService(db),
      target = repository((await db.pool.query("SELECT * FROM repositories WHERE id=1104")).rows[0]);
    const preview = await imports.preview(target, actor, {
      kind: "markdown",
      documentName: "rules.md",
      markdown: RULE_IMPORT_EXAMPLE,
    });
    await imports.confirm(
      target,
      actor,
      preview.id,
      preview.rules.map((rule) => rule.key),
    );
    assert.deepEqual(await count(), [{ id: 1104, n: 1 }]);
    await clear();
    const other = repository((await db.pool.query("SELECT * FROM repositories WHERE id=1106")).rows[0]);
    const otherPreview = await imports.preview(other, actor, {
      kind: "markdown",
      documentName: "rules.md",
      markdown: RULE_IMPORT_EXAMPLE,
    });
    const imported = await imports.confirm(
      other,
      actor,
      otherPreview.id,
      otherPreview.rules.map((rule) => rule.key),
    );
    assert.deepEqual(await count(), [{ id: 1106, n: 1 }]);
    await clear();
    await db.pool.query("DELETE FROM memories WHERE id=ANY($1::uuid[])", [imported.imported]);
    assert.deepEqual(await count(), [{ id: 1106, n: 1 }]);
  } finally {
    await db.pool.query("UPDATE jobs SET status='succeeded' WHERE job_type='RULES_SYNC'");
    await db.close();
  }
});

test("规则同步在同仓库串行；运行期间的变更继续入队；关闭开关和旧租约阻止写入", { skip: !fixture.url }, async () => {
  const { db, enable, enqueue, process, github } = await setup(1107);
  try {
    await enable();
    const job = (await db.claimNext()) as RulesSyncJob;
    await enqueue();
    await enqueue();
    assert.equal(await db.claimNext(), undefined);
    await db.pool.query("UPDATE repositories SET rules_sync_enabled=false WHERE id=1107");
    await process(job);
    assert.equal(job.status, "cancelled");
    assert.deepEqual(github.writes, []);
    await db.finishJob(job);
    const next = (await db.claimNext()) as RulesSyncJob;
    await process(next);
    await db.finishJob(next);
    assert.deepEqual(github.writes, []);
    await enable();
    const stale = (await db.claimNext()) as RulesSyncJob;
    await db.pool.query("UPDATE jobs SET lease_token=$2 WHERE id=$1", [stale.id, randomUUID()]);
    await process(stale);
    assert.deepEqual(github.writes, []);
    await db.pool.query("UPDATE jobs SET status='cancelled' WHERE id=$1", [stale.id]);
  } finally {
    await db.close();
  }
});

test("仓库维护者设置开关/立即同步，CSRF 和维护权限沿用；非法开关返回 422", { skip: !fixture.url }, async () => {
  const { db } = await setup(1108);
  const sessions = memoryStore<Session>(60_000, 10),
    secret = "sync-session-secret".repeat(3),
    origin = "http://localhost";
  await sessions.set("user", { ...actor, token: "token", csrf: "csrf", expiresAt: Date.now() + 60_000 });
  let allowed = true;
  const cfg = {
    ...config,
    development: loadDevelopmentConfig({}),
    sessionSecret: secret,
    githubClientId: "id",
    githubClientSecret: "secret",
    githubOAuthCallbackUrl: origin + "/auth/github/callback",
  } as Config;
  const handler = createAdminHandler(
    cfg,
    db,
    { hasMaintainerPermission: async () => allowed } as unknown as GitHubClient,
    { sessions, states: memoryStore<number>(60_000, 10) },
  );
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/repositories/1108`;
  const request = (suffix: string, method: string, value?: unknown, csrf = "csrf") =>
    fetch(url + suffix, {
      method,
      headers: {
        cookie: `session=user.${createHmac("sha256", secret).update("user").digest("base64url")}`,
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  try {
    assert.equal((await request("", "PATCH", { rulesSyncEnabled: true }, "wrong")).status, 403);
    allowed = false;
    assert.equal((await request("/rules-sync", "POST")).status, 403);
    allowed = true;
    // 新用户避免前一次拒绝的权限缓存；授权检查依旧使用真实 handler。
    await sessions.set("user", {
      id: 2,
      login: "second-maintainer",
      token: "maintainer-token",
      csrf: "csrf",
      expiresAt: Date.now() + 60_000,
    });
    assert.equal((await request("", "PATCH", { rulesSyncEnabled: "yes" })).status, 422);
    const response = await request("", "PATCH", { rulesSyncEnabled: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).rulesSyncEnabled, true);
    const first = await (await request("/rules-sync", "POST")).json(),
      second = await (await request("/rules-sync", "POST")).json();
    assert.equal(first.jobId, second.jobId);
    assert.ok(first.jobId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
