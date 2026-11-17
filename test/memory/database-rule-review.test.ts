import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { RuleReviewService } from "../../src/memory/rule-review.service.js";
import { createDecisionProcessor } from "../../src/memory/decision.processor.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import type { Config } from "../../src/config/config.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { useTestDatabase } from "../helpers/database.js";
import { loadDevelopmentConfig } from "../../src/development/config.js";

const fixture = useTestDatabase();
const DAY = 86_400_000;
async function seed(database: Database, start: number) {
  for (const id of [start, start + 1, start + 2])
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
      id,
      `owner/r${id}`,
    ]);
  const rule = async (repositoryId: number, paths: string[] = [], status = "ACTIVE"): Promise<string> => {
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,confidence,status,source_fingerprint,approved_at)
       VALUES($1::uuid,1,$2,1,'engineering_rule',$1::text,'rule','reason',$3,'{"pullRequestNumber":1,"commentIds":[1],"commitSha":"merged"}',1,$4,$1::text,'2026-01-01')`,
      [id, repositoryId, { paths }, status],
    );
    return id;
  };
  let pr = 1;
  const review = async (repositoryId = start, headSha = randomUUID()) => {
    return (
      await database.accept(
        {
          deliveryId: randomUUID(),
          installationId: 1,
          repositoryId,
          repository: `owner/r${repositoryId}`,
          cloneUrl: "unused",
          prNumber: pr++,
          title: "test",
          body: "",
          baseSha: "base",
          headSha,
        },
        { event: "pull_request", action: "opened" },
      )
    ).job! as ReviewJob;
  };
  const finding = async (
    job: ReviewJob,
    memoryId: string | null,
    status = "OPEN",
    patch: {
      head?: string;
      path?: string | null;
      line?: number | null;
      side?: string;
      // 字符串表示重复的是哪个 finding。
      repeat?: boolean | string;
      inferred?: boolean;
      binding?: string;
    } = {},
  ) => {
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO review_findings(id,job_id,repository_id,pr_number,head_sha,fingerprint,category,severity,evidence_level,path,line,side,description,evidence,impact,memory_id,status,binding_status,presentation,created_at,inferred_fixed_at)
       VALUES($1,$2,$3,$4,$5,$1,'team_rule','medium','strong',$6,$7,$8,'d','e','i',$9,$10,$11,$12,'2026-10-20',$13)`,
      [
        id,
        job.id,
        job.repositoryId,
        job.prNumber,
        patch.head ?? job.headSha,
        patch.path === undefined ? "src/a.ts" : patch.path,
        patch.line === undefined ? 20 : patch.line,
        patch.side ?? "RIGHT",
        memoryId,
        status,
        patch.binding ?? "bound",
        patch.repeat ? { repeatOf: { id: typeof patch.repeat === "string" ? patch.repeat : "other" } } : {},
        patch.inferred ? "2026-11-01" : null,
      ],
    );
    return id;
  };
  return { rule, review, finding };
}

test("复查：噪声、90 天忽略、沉睡、到期和生效版本；统计仅限本仓库", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  try {
    const s = await seed(database, 91001);
    let now = new Date("2026-11-15T00:00:00Z");
    const service = new RuleReviewService(database, {} as any, new Set(), () => now);
    const memories = new MemoryService(database);
    const project = await s.rule(91001),
      team = await s.rule(91001);
    const pending = await s.rule(91001, [], "CANDIDATE");
    const a = await s.review(),
      b = await s.review(91002);
    for (const status of ["WITHDRAWN", "WITHDRAWN", "WITHDRAWN", "OPEN", "OPEN"]) await s.finding(a, project, status);
    await s.finding(b, project, "WITHDRAWN"); // 项目规则不会汇总其他仓库。
    for (const [job, status, inferred] of [
      [a, "WITHDRAWN", false],
      [a, "OPEN", true],
      [b, "FIXED", true],
      [b, "OPEN", false],
    ] as const)
      await s.finding(job, team, status, { inferred });
    await s.finding(a, team, "WITHDRAWN", { repeat: true });
    await s.finding(a, team, "WITHDRAWN", { binding: "pending" });
    await database.saveReviewMemoryUsage(a, [{ id: team, version: 1 }]);
    await database.saveReviewMemoryUsage(b, [{ id: team, version: 1 }]);
    assert.deepEqual((await memories.list(91001)).find((rule) => rule.id === team)!.usage, {
      provided: 1,
      cited: 2,
      fixed: 0,
      inferredFixed: 1,
      withdrawn: 1,
      exception: 0,
      open: 1,
      lastCitedAt: "2026-10-20T00:00:00.000Z",
    });
    assert.equal((await memories.list(91001)).find((item) => item.id === project)!.usage.cited, 5);
    const queue = () => service.list([91001]);
    const initial = (await queue()).items;
    assert.deepEqual(
      initial.map((item) => item.memory.id),
      [project],
    );
    assert.deepEqual(initial[0]!.reasons, [{ reason: "noisy", cited: 5, withdrawn: 3, withdrawnRatio: 0.6 }]);
    assert.ok(!initial.some((item) => item.memory.id === pending));
    await service.dismiss(project, "noisy", "现行规则先观察一个季度", "maintainer");
    await s.finding(a, project, "WITHDRAWN");
    assert.equal((await queue()).items.length, 0, "依据变化也不能让已忽略原因提前出现");
    now = new Date(now.getTime() + 89 * DAY);
    assert.ok(
      !(await queue()).items
        .find((item) => item.memory.id === project)
        ?.reasons.some((reason) => reason.reason === "noisy"),
    );
    now = new Date(now.getTime() + DAY);
    assert.ok(
      (await queue()).items
        .find((item) => item.memory.id === project)
        ?.reasons.some((reason) => reason.reason === "noisy"),
    );
    const dismissal = (await database.pool.query("SELECT * FROM rule_review_dismissals WHERE memory_id=$1", [project]))
      .rows[0];
    assert.equal(dismissal.note, "现行规则先观察一个季度");
    assert.equal(dismissal.dismissed_by, "maintainer");
    const sleeping = await s.rule(91001);
    await database.pool.query("UPDATE memories SET approved_at=$2,expires_at=$3 WHERE id=$1", [
      sleeping,
      new Date(now.getTime() - 90 * DAY),
      now,
    ]);
    await memories.edit(
      91001,
      sleeping,
      { title: "待确认新名称", scope: { paths: ["missing/**"] } },
      { id: 1, login: "m" },
    );
    const entry = (await queue()).items.find((item) => item.memory.id === sleeping)!;
    assert.equal(entry.memory.version, 1, "候选更新不能遮住当前生效版本");
    assert.deepEqual(
      entry.reasons.map((reason) => reason.reason),
      ["sleeping", "expired"],
    );
    await database.pool.query("UPDATE memories SET approved_at=$2 WHERE id=$1 AND status='ACTIVE'", [
      sleeping,
      new Date(now.getTime() - 89 * DAY),
    ]);
    assert.ok(
      !(await queue()).items
        .find((item) => item.memory.id === sleeping)!
        .reasons.some((reason) => reason.reason === "sleeping"),
    );
  } finally {
    await database.close();
  }
});

test("路径复查：各仓库独立判断、24 小时缓存、truncated 和读取失败不误判", { skip: !fixture.url }, async (t) => {
  const database = new Database(fixture.url!);
  try {
    const s = await seed(database, 92001);
    let now = new Date("2026-02-01");
    let calls = 0,
      tokens = 0,
      truncated = false,
      fail = false;
    const github = {
      installationToken: async () => {
        tokens++;
        return "token";
      },
      defaultBranchTree: async (_token: string, repository: string) => {
        calls++;
        if (fail) throw new Error("tree unavailable");
        return {
          sha: "tree",
          truncated: repository.endsWith("2") && truncated,
          tree: [
            { path: repository.endsWith("2") ? "src/a.ts" : "docs/a.md", type: "blob" },
            { path: "directory", type: "tree" },
          ],
        };
      },
    };
    const service = new RuleReviewService(database, github, new Set(["owner/r92001", "owner/r92002"]), () => now);
    const missing = await s.rule(92002, ["missing/**"]),
      present = await s.rule(92002, ["src/**"]),
      local = await s.rule(92001, ["src/**"]);
    const queue = () => service.list([92001, 92002]);
    assert.equal(calls, 0, "未打开队列不取树");
    let result = await queue();
    assert.deepEqual(result.items.map((item) => item.memory.id).sort(), [missing, local].sort());
    assert.equal(result.items.find((item) => item.memory.id === missing)!.reasons[0]!.reason, "path_invalid");
    assert.equal(calls, 2);
    assert.equal(tokens, 1);
    await queue();
    assert.equal(calls, 2, "24 小时内用缓存");
    now = new Date(now.getTime() + DAY);
    truncated = true;
    result = await queue();
    assert.equal(calls, 4);
    assert.ok(
      !result.items.some((item) => [missing, present].includes(item.memory.id)),
      "截断树无法证明该仓库没有匹配路径",
    );
    assert.deepEqual(result.uncheckedRepositories, ["owner/r92002"]);
    await queue();
    assert.equal(calls, 4, "截断树也缓存，避免重复调用");
    now = new Date(now.getTime() + DAY);
    fail = true;
    const logs = t.mock.method(console, "error", () => {});
    result = await queue();
    assert.equal(result.items.length, 0);
    assert.equal(result.uncheckedRepositories.length, 2);
    assert.equal(logs.mock.callCount(), 2);
  } finally {
    await database.close();
  }
});

test("合并推断：覆盖行才记疑似，不改状态、去重、失败不阻断无人类讨论的提取", { skip: !fixture.url }, async (t) => {
  const database = new Database(fixture.url!);
  try {
    const s = await seed(database, 93001),
      job = await s.review();
    const memory = await s.rule(93001);
    const yes = await s.finding(job, memory),
      no = await s.finding(job, memory, "STILL_VALID", { line: 100 });
    const renamed = await s.finding(job, memory, "NEEDS_CLARIFICATION", { path: "old.ts" });
    const skipped = await Promise.all([
      s.finding(job, memory, "FIXED"),
      s.finding(job, memory, "WITHDRAWN"),
      s.finding(job, memory, "OPEN", { side: "LEFT" }),
      s.finding(job, memory, "OPEN", { repeat: true }),
      s.finding(job, memory, "OPEN", { path: null }),
      s.finding(job, memory, "OPEN", { line: null }),
    ]);
    const failed = await s.finding(job, memory, "OPEN", { head: "fail-head" });
    const forcePushed = await s.finding(job, memory, "OPEN", { head: "force-pushed-head" });
    // 附近改过，但最后一个 head 的 Review 还认作重复：没修好。
    const repeatedAtFinal = await s.finding(job, memory, "OPEN", { line: 19 });
    await s.finding(job, memory, "OPEN", { head: "final", repeat: repeatedAtFinal });
    let calls = 0;
    const github = {
      installationToken: async () => "token",
      getPullRequest: async () => ({ merged: true, merge_commit_sha: "merged", head: { sha: "final" } }),
      getFiles: async () => [],
      getConversationComments: async () => [],
      getReviews: async () => [],
      getReviewComments: async () => [],
      compareFiles: async (_t: string, _r: string, head: string, target: string) => {
        assert.equal(target, "final", "和 PR 最后的 head 比较，不用合并提交");
        calls++;
        if (head === "fail-head") throw new Error("compare unavailable");
        const files = [
          { filename: "src/a.ts", patch: "@@ -18,4 +18,4 @@\n-a\n+b" },
          { filename: "new.ts", previous_filename: "old.ts", patch: "@@ -20 +20 @@\n-a\n+b" },
        ];
        return { status: head === "force-pushed-head" ? "diverged" : "ahead", files };
      },
    } as unknown as GitHubClient;
    const log = t.mock.method(console, "error", () => {});
    const process = createDecisionProcessor({} as Config, database, new MemoryService(database), github, async () => {
      throw new Error("不能启动模型");
    });
    await process({ ...job, headSha: "merged", jobType: "DECISION_EXTRACT" });
    assert.equal(calls, 3, "同一个 finding head 只 compare 一次");
    const rows = (await database.pool.query("SELECT * FROM review_findings WHERE job_id=$1", [job.id])).rows;
    for (const id of [yes, renamed]) {
      assert.equal(rows.find((row) => row.id === id).inferred_fixed_sha, "final");
      assert.ok(rows.find((row) => row.id === id).inferred_fixed_at);
    }
    assert.equal(rows.find((row) => row.id === yes).status, "OPEN");
    for (const id of [no, failed, forcePushed, repeatedAtFinal, ...skipped])
      assert.equal(rows.find((row) => row.id === id).inferred_fixed_at, null);
    assert.equal(log.mock.callCount(), 1);
    const timestamp = rows.find((row) => row.id === yes).inferred_fixed_at;
    await process({ ...job, headSha: "merged", jobType: "DECISION_EXTRACT" });
    assert.deepEqual(
      (await database.pool.query("SELECT inferred_fixed_at FROM review_findings WHERE id=$1", [yes])).rows[0]
        .inferred_fixed_at,
      timestamp,
    );
    const usage = (await new MemoryService(database).list(93001))[0]!.usage;
    assert.equal(usage.inferredFixed, 2);
    assert.equal(usage.fixed, 1);
  } finally {
    await database.close();
  }
});

test("复查 API 沿用仓库维护权限、CSRF、必填理由；列表和统计不跨仓库", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const stores = { sessions: memoryStore<any>(8 * 60 * 60_000, 100), states: memoryStore<number>(60_000, 100) };
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const s = await seed(database, 94001);
    const project = await s.rule(94001),
      foreign = await s.rule(94003),
      team = await s.rule(94002);
    const review = await s.review(),
      other = await s.review(94002);
    for (const job of [review, other]) {
      for (let i = 0; i < 3; i++) await s.finding(job, team, "WITHDRAWN");
      await database.saveReviewMemoryUsage(job, [{ id: team, version: 1 }]);
    }
    const secret = "s".repeat(32);
    const config = {
      development: loadDevelopmentConfig({}),
      githubClientId: "c",
      githubClientSecret: "s",
      githubOAuthCallbackUrl: "http://localhost/auth/github/callback",
      sessionSecret: secret,
      allowedRepositories: new Set(["owner/r94001", "owner/r94002", "owner/r94003"]),
    } as Config;
    const github = {
      hasMaintainerPermission: async (token: string, repo: string) => token === "maintainer" && repo === "owner/r94001",
    } as unknown as GitHubClient;
    server = createServer(createAdminHandler(config, database, github, stores));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    for (const login of ["maintainer", "manager"])
      await stores.sessions.set(login, { id: 1, login, token: login, csrf: "csrf", expiresAt: Date.now() + 60_000 });
    const headers = (login: string) => ({
      cookie: `session=${login}.${createHmac("sha256", secret).update(login).digest("base64url")}`,
      origin: "http://localhost",
      "x-csrf-token": "csrf",
    });
    assert.equal((await fetch(origin + "/api/rule-review")).status, 401);
    let response = await fetch(origin + "/api/rule-review", { headers: headers("maintainer") });
    assert.equal(response.status, 200);
    const projectQueue: any = await response.json();
    assert.deepEqual(
      projectQueue.items.map((item: any) => item.memory.id),
      [project],
    );
    response = await fetch(origin + "/api/rule-review", { headers: headers("manager") });
    const teamQueue: any = await response.json();
    assert.deepEqual(teamQueue.items, []);
    const post = (id: string, user: string, value: unknown, csrf = "csrf") =>
      fetch(origin + `/api/memories/${id}/dismiss-review`, {
        method: "POST",
        headers: { ...headers(user), "x-csrf-token": csrf },
        body: JSON.stringify(value),
      });
    assert.equal((await post(team, "maintainer", { reason: "noisy", note: "hold" })).status, 403);
    assert.equal((await post(foreign, "maintainer", { reason: "sleeping", note: "hold" })).status, 403);
    assert.equal((await post(project, "maintainer", { reason: "sleeping", note: "hold" }, "wrong")).status, 403);
    for (const value of [
      null,
      { reason: "made_up", note: "hold" },
      { reason: "sleeping" },
      { reason: "sleeping", note: "  " },
    ])
      assert.equal((await post(project, "maintainer", value)).status, 422);
    assert.equal((await post(project, "maintainer", { reason: "sleeping", note: "保留观察" })).status, 200);
    assert.equal((await post(team, "manager", { reason: "noisy", note: "先修审查方式" })).status, 403);
    const remaining: any = await (await fetch(origin + "/api/rule-review", { headers: headers("maintainer") })).json();
    assert.equal(remaining.items.length, 0);
    const bootstrap: any = await (await fetch(origin + "/api/bootstrap", { headers: headers("maintainer") })).json();
    assert.ok(bootstrap.memories.every((item: any) => item.repositoryId === 94001));
    assert.ok(!("teams" in bootstrap));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await database.close();
  }
});
