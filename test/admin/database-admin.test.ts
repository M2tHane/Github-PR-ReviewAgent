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
import { sanitizeSession, type RecordedSession } from "../../src/pi/session-record.js";
import { groupFindings } from "../../src/review/presentation.js";
import { GitHubApiError } from "../../src/github/client.js";
import { createApp } from "../../src/github/webhook/handler.js";
import { useTestDatabase, waitFor } from "../helpers/database.js";

const fixture = useTestDatabase();

test("OAuth state、Session、CSRF 与跨仓库 Maintainer 权限", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const allowedId = 9_000_000_006;
  const deniedId = 9_000_000_007;
  const cleanup = async () => {
    await database.pool.query(
      "DELETE FROM reply_publications WHERE finding_id IN (SELECT id FROM review_findings WHERE repository_id=ANY($1::bigint[]))",
      [[allowedId, deniedId]],
    );
    await database.pool.query("DELETE FROM review_findings WHERE repository_id=ANY($1::bigint[])", [
      [allowedId, deniedId],
    ]);
    await database.pool.query("DELETE FROM jobs WHERE repository_id=ANY($1::bigint[])", [[allowedId, deniedId]]);
    await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=ANY($1::bigint[])", [
      [allowedId, deniedId],
    ]);
    await database.pool.query(
      "DELETE FROM memory_audits WHERE memory_id IN (SELECT id FROM memories WHERE repository_id=ANY($1::bigint[]))",
      [[allowedId, deniedId]],
    );
    await database.pool.query("DELETE FROM memories WHERE repository_id=ANY($1::bigint[])", [[allowedId, deniedId]]);
    await database.pool.query("DELETE FROM repositories WHERE id=ANY($1::bigint[])", [[allowedId, deniedId]]);
  };
  await cleanup();
  await database.pool.query(
    "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/allowed'),($2,1,'owner/denied')",
    [allowedId, deniedId],
  );
  const proposal: DecisionProposal = {
    type: "engineering_rule",
    title: "rule",
    content: "content",
    rationale: "reason",
    scope: {},
    source: { pullRequestNumber: 1, commitSha: "merged", commentIds: [1] },
    evidence: [
      { kind: "human_comment", reference: "1", detail: "yes" },
      { kind: "code", reference: "x:1", detail: "change" },
    ],
    confidence: 1,
    uncertainties: [],
  };
  const makeJob = (repositoryId: number, repository: string, suffix: string) =>
    ({
      id: `00000000-0000-4000-8000-0000000000${suffix}`,
      deliveryId: `auth-${suffix}`,
      jobType: "DECISION_EXTRACT",
      installationId: 1,
      repositoryId,
      repository,
      cloneUrl: "url",
      prNumber: 1,
      title: "",
      body: "",
      baseSha: "base",
      headSha: "merged",
      status: "running",
    }) satisfies ReviewJob;
  const allowedMemory = (await database.insertCandidates(makeJob(allowedId, "owner/allowed", "06"), [proposal]))[0]!;
  const deniedMemory = (
    await database.insertCandidates(makeJob(deniedId, "owner/denied", "07"), [
      { ...proposal, source: { ...proposal.source, pullRequestNumber: 2 } },
    ])
  )[0]!;
  const { id: _id, status: _status, jobType: _type, ...reviewInput } = makeJob(allowedId, "owner/allowed", "08");
  const review = (await database.accept(reviewInput, { event: "pull_request", action: "opened" })).job!;
  const deniedReview = (
    await database.accept(
      { ...reviewInput, repositoryId: deniedId, repository: "owner/denied", deliveryId: "auth-denied-report" },
      { event: "pull_request", action: "opened" },
    )
  ).job!;
  const finding = {
    path: "src/a.ts",
    line: 2,
    side: "RIGHT",
    category: "correctness",
    severity: "high",
    evidenceLevel: "strong",
    description: "shared mutation",
    evidence: "writes shared list",
    impact: "ordering changes",
    suggestion: "copy before sorting",
  } as const;
  const grouped = groupFindings(
    [finding, { ...finding, path: "src/b.ts", description: "mutable list escapes" }],
    [[0, 1]],
    [{ title: "排序修改共享状态", reason: "查询返回内部列表。", fix: "查询返回快照并在副本上排序。" }],
  );
  const stored = await database.saveFindings(review, grouped, new Set(grouped));
  await database.saveReviewResult(review, {
    summary: "full audit retained",
    findings: stored,
    coverage: ["private-audit-scope"],
    limitations: [],
  });
  const config = {
    appId: "1",
    privateKey: "key",
    webhookSecret: "secret",
    allowedRepositories: new Set(["owner/allowed", "owner/denied"]),
    databaseUrl: fixture.url!,
    modelProvider: "test",
    modelName: "test",
    modelApiKey: "test",
    port: 0,
    webhookMaxBytes: 1000,
    queueCapacity: 1,
    agentTimeoutMs: 1000,
    githubClientId: "client",
    githubClientSecret: "client-secret",
    githubOAuthCallbackUrl: "http://127.0.0.1/callback",
    sessionSecret: "a".repeat(32),
    vulnerabilityScan: false,
    sastScan: false,
    semgrepPath: "semgrep",
    workerConcurrency: 1,
    dataRetentionDays: 0,
    revokedDataGraceDays: 0,
  } satisfies Config;
  let hasAccess = true;
  const github = {
    exchangeOAuthCode: async () => "user-token",
    getUser: async () => ({ id: 42, login: "maintainer" }),
    hasMaintainerPermission: async (_token: string, repository: string) => hasAccess && repository === "owner/allowed",
  };
  const server = createServer(createAdminHandler(config, database, github as any));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    let response = await fetch(`${origin}/api/memories/${allowedMemory}/approve`, { method: "POST" });
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/auth/github`, { redirect: "manual" });
    const location = response.headers.get("location")!;
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    response = await fetch(`${origin}/auth/github/callback?code=ok&state=wrong`, {
      headers: { cookie: stateCookie },
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    response = await fetch(`${origin}/auth/github/callback?code=ok&state=${state}`, {
      headers: { cookie: stateCookie },
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    const sessionCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("session="))!
      .split(";", 1)[0]!;
    response = await fetch(`${origin}/api/session`, { headers: { cookie: sessionCookie } });
    const session = (await response.json()) as { csrf: string };
    const memberEndpoint = `${origin}/api/repositories/${allowedId}/notification-members`;
    const memberHeaders = { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf };
    assert.equal((await fetch(memberEndpoint)).status, 401);
    assert.equal(
      (
        await fetch(memberEndpoint, {
          method: "PUT",
          headers: { cookie: sessionCookie },
          body: JSON.stringify({ githubLogin: "Alice", wecomUserId: "zhangsan" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/repositories/${deniedId}/notification-members`, {
          headers: memberHeaders,
        })
      ).status,
      403,
    );
    for (const method of ["PUT", "DELETE"]) {
      assert.equal(
        (
          await fetch(
            `${origin}/api/repositories/${deniedId}/notification-members${method === "DELETE" ? "/alice" : ""}`,
            {
              method,
              headers: memberHeaders,
              ...(method === "PUT" ? { body: JSON.stringify({ githubLogin: "alice", wecomUserId: "wrong" }) } : {}),
            },
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await fetch(memberEndpoint, {
          method: "PUT",
          headers: memberHeaders,
          body: JSON.stringify({ githubLogin: "Alice", wecomUserId: "@all" }),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(memberEndpoint, {
          method: "PUT",
          headers: memberHeaders,
          body: JSON.stringify({ githubLogin: "Alice", wecomUserId: "zhangsan", repositoryId: deniedId }),
        })
      ).status,
      422,
    );
    response = await fetch(memberEndpoint, {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ githubLogin: "Alice", wecomUserId: "zhangsan" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { githubLogin: "alice", wecomUserId: "zhangsan" });
    response = await fetch(memberEndpoint, { headers: memberHeaders });
    assert.deepEqual(await response.json(), {
      members: [{ githubLogin: "alice", wecomUserId: "zhangsan" }],
      configured: false,
    });
    assert.equal(
      (
        await fetch(memberEndpoint, {
          method: "PUT",
          headers: memberHeaders,
          body: JSON.stringify({ githubLogin: "ALICE", wecomUserId: "new-user" }),
        })
      ).status,
      200,
    );
    response = await fetch(memberEndpoint, { headers: memberHeaders });
    assert.deepEqual(((await response.json()) as any).members, [{ githubLogin: "alice", wecomUserId: "new-user" }]);
    hasAccess = false;
    assert.equal((await fetch(memberEndpoint, { headers: memberHeaders })).status, 403);
    assert.equal((await fetch(`${memberEndpoint}/alice`, { method: "DELETE", headers: memberHeaders })).status, 403);
    hasAccess = true;
    assert.equal((await fetch(`${memberEndpoint}/alice`, { method: "DELETE", headers: memberHeaders })).status, 200);
    response = await fetch(memberEndpoint, { headers: memberHeaders });
    assert.deepEqual(((await response.json()) as any).members, []);
    response = await fetch(`${origin}/api/memories/${allowedMemory}/approve`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": "wrong" },
    });
    assert.equal(response.status, 403);
    response = await fetch(`${origin}/api/memories/${allowedMemory}/approve`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf },
    });
    assert.equal(response.status, 200);
    response = await fetch(`${origin}/api/memories/${deniedMemory}/reject`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf },
    });
    assert.equal(response.status, 403);
    response = await fetch(`${origin}/api/bootstrap`, { headers: { cookie: sessionCookie } });
    const bootstrap: any = await response.json();
    assert.equal(bootstrap.repositories.length, 1);
    assert.equal(bootstrap.repositories[0].id, allowedId);
    assert.equal(bootstrap.memories.length, 1);
    assert.equal(bootstrap.memories[0].id, allowedMemory);
    assert.equal(bootstrap.jobs, undefined, "任务列表不再随首屏下发");
    assert(!JSON.stringify(bootstrap).includes("private-audit-scope"));
    // 执行过程：列表和详情只带摘要；单条接口返回时间线，原始记录可下载；权限跟随任务所属仓库。
    const t0 = Date.parse("2026-11-09T10:00:00Z");
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const raw = [
      { type: "session", version: 3, id: "s", timestamp: at(0), cwd: "/tmp/workspace" },
      {
        type: "message",
        id: "a",
        timestamp: at(1000),
        message: { role: "user", content: [{ type: "text", text: "审查此 PR" }] },
      },
      {
        type: "message",
        id: "b",
        timestamp: at(3000),
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "内部思考" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "go test ./service" } },
          ],
          usage: { totalTokens: 1200 },
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "c",
        timestamp: at(213_000),
        message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const recorded: RecordedSession = {
      id: randomUUID(),
      status: "succeeded",
      startedAt: new Date(t0),
      durationMs: 215_000,
      timings: {
        models: [{ startedAt: t0 + 1000, durationMs: 2000 }],
        tools: { c1: { startedAt: t0 + 3000, name: "bash", durationMs: 210_000 } },
      },
      ...sanitizeSession(raw),
    };
    const sessionId = await database.saveAgentSession({ jobId: review.id, role: "general_review" }, recorded);
    const deniedSession = await database.saveAgentSession(
      { jobId: deniedReview.id, role: "general_review" },
      { ...recorded, id: randomUUID() },
    );
    response = await fetch(`${origin}/api/agent-sessions/${sessionId}`, { headers: { cookie: sessionCookie } });
    assert.equal(response.status, 200);
    const sessionDetail = (await response.json()) as any;
    assert.deepEqual(
      sessionDetail.timeline.map((step: any) => [step.kind, step.title, step.durationMs ?? null]),
      [
        ["input", "任务输入", null],
        ["model", "调用 bash", 2000],
        ["tool", "bash go test ./service", 210_000],
      ],
    );
    assert.equal(sessionDetail.content, undefined);
    response = await fetch(`${origin}/api/agent-sessions/${sessionId}/raw`, { headers: { cookie: sessionCookie } });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /attachment; filename="agent-session-general_review-/,
    );
    const downloaded = await response.text();
    assert.equal(downloaded, recorded.content);
    assert(downloaded.includes("go test ./service") && !downloaded.includes("内部思考"), "思考过程不保存");
    for (const path of [`/api/agent-sessions/${deniedSession}`, `/api/agent-sessions/${deniedSession}/raw`]) {
      response = await fetch(`${origin}${path}`, { headers: { cookie: sessionCookie } });
      assert.equal(response.status, 403, path);
    }
    response = await fetch(`${origin}/api/agent-sessions/not-a-uuid`, { headers: { cookie: sessionCookie } });
    assert.equal(response.status, 404);
    // 运行中的记录：超过 2 分钟没更新按已中断展示；正常的显示进行中的服务步骤。
    const live = await database.saveAgentSession(
      { jobId: review.id, role: "general_review" },
      { ...recorded, id: randomUUID(), status: "running", startedAt: new Date(Date.now() - 10_000), durationMs: 1000 },
    );
    await database.pool.query("UPDATE agent_sessions SET events=$2 WHERE id=$1", [
      live,
      { clone: { name: "准备工作区", startedAt: Date.now() - 9000 } },
    ]);
    response = await fetch(`${origin}/api/agent-sessions/${live}`, { headers: { cookie: sessionCookie } });
    const liveDetail = (await response.json()) as any;
    assert.equal(liveDetail.status, "running");
    assert(liveDetail.duration_ms >= 10_000, "进行中按当前时间计算耗时");
    const clone = liveDetail.timeline.find((step: any) => step.kind === "service");
    assert.equal(clone.title, "准备工作区");
    assert.equal(clone.error, false);
    await database.pool.query("UPDATE agent_sessions SET updated_at=now()-interval '3 minutes' WHERE id=$1", [live]);
    response = await fetch(`${origin}/api/agent-sessions/${live}`, { headers: { cookie: sessionCookie } });
    assert.equal(((await response.json()) as any).status, "interrupted");
    await database.pool.query("DELETE FROM agent_sessions WHERE id=$1", [live]);
    response = await fetch(`${origin}/api/jobs`, { headers: { cookie: sessionCookie } });
    const jobPage = (await response.json()) as any;
    assert.deepEqual([jobPage.total, jobPage.page, jobPage.pageSize], [1, 1, 20]);
    const jobs = jobPage.items as any[];
    assert.equal(jobs.length, 1);
    assert.deepEqual(
      jobs[0].agent_sessions.map((item: any) => [item.id, item.role, item.steps, item.content]),
      [[sessionId, "general_review", 2, undefined]],
    );
    assert.equal(jobs[0].report_available, true);
    assert.equal(jobs[0].finding_count, 1);
    assert(!JSON.stringify(jobs).includes("private-audit-scope"));
    // 筛选和翻页在数据库里做；无权限仓库的任务既不出现也不计数。
    const jobList = async (query: string) => {
      const result = await fetch(`${origin}/api/jobs?${query}`, { headers: { cookie: sessionCookie } });
      return { status: result.status, body: (await result.json()) as any };
    };
    for (const [query, total, items] of [
      [`type=PR_REVIEW&status=${jobs[0].status}`, 1, 1],
      ["type=HEALTH_AUDIT", 0, 0],
      ["status=failed,timeout,uncertain", 0, 0],
      [`repositoryId=${allowedId}`, 1, 1],
      [`repositoryId=${deniedId}`, 0, 0],
      ["page=2&pageSize=1", 1, 0],
    ] as const) {
      const listed = await jobList(query);
      assert.deepEqual([listed.status, listed.body.total, listed.body.items.length], [200, total, items], query);
    }
    for (const query of ["status=bogus", "type=OTHER", "repositoryId=abc", "page=0", "pageSize=101", "pageSize=1.5"])
      assert.equal((await jobList(query)).status, 422, query);
    assert.equal((await fetch(`${origin}/api/overview`)).status, 401);
    response = await fetch(`${origin}/api/overview`, { headers: { cookie: sessionCookie } });
    const overview = (await response.json()) as any;
    assert.deepEqual([overview.attention, overview.reviewsThisWeek], [0, 1]);
    assert.deepEqual(
      overview.latestReviews.map((item: any) => [item.id, item.finding_count, item.review_result]),
      [[review.id, 1, undefined]],
    );
    assert.equal(overview.quality.findings, 0, "还没发布到 GitHub 的意见不计入");
    assert(!JSON.stringify(overview).includes("private-audit-scope"));
    // 需要排查的任务只数近 7 天；意见按回复后的状态统计。
    const oldFailure = randomUUID(),
      newFailure = randomUUID();
    await database.pool.query(
      `INSERT INTO jobs(id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,status,created_at)
       VALUES($1,'PR_REVIEW',$3,1,'owner/allowed',7,'old','base','failed',now()-interval '8 days'),
             ($2,'REPLY_HANDLE',$3,1,'owner/allowed',7,'new','base','uncertain',now())`,
      [oldFailure, newFailure, allowedId],
    );
    await database.pool.query("UPDATE review_findings SET status='FIXED',binding_status='bound' WHERE id=$1", [
      stored[0]!.id,
    ]);
    response = await fetch(`${origin}/api/overview`, { headers: { cookie: sessionCookie } });
    const counted = (await response.json()) as any;
    assert.deepEqual([counted.attention, counted.reviewsThisWeek], [1, 1]);
    assert.deepEqual([counted.quality.findings, counted.quality.fixed, counted.quality.open], [1, 1, 0]);
    assert.equal((await jobList("status=failed,timeout,uncertain")).body.total, 2);
    assert.deepEqual(
      (await jobList("status=failed,timeout,uncertain&pageSize=1&page=2")).body.items.map((item: any) => item.id),
      [oldFailure],
    );
    await database.pool.query("DELETE FROM jobs WHERE id=ANY($1::uuid[])", [[oldFailure, newFailure]]);
    await database.pool.query("UPDATE review_findings SET status='OPEN',binding_status='pending' WHERE id=$1", [
      stored[0]!.id,
    ]);
    response = await fetch(`${origin}/api/jobs/${review.id}`, { headers: { cookie: sessionCookie } });
    assert.equal(response.status, 200);
    const detail = (await response.json()) as any;
    assert.deepEqual(detail.finding_statuses, [{ id: stored[0]!.id, status: "OPEN" }]);
    assert.deepEqual(
      detail.agent_sessions.map((item: any) => item.id),
      [sessionId],
    );
    assert.equal(detail.review_result.findings[0].candidates.length, 2);
    assert.equal(detail.review_result.findings[0].relatedLocations[0].path, "src/b.ts");
    response = await fetch(`${origin}/api/jobs/${deniedReview.id}`, { headers: { cookie: sessionCookie } });
    assert.equal(response.status, 403);
    response = await fetch(`${origin}/api/findings?jobId=${review.id}`, { headers: { cookie: sessionCookie } });
    const findings = (await response.json()) as any;
    assert.equal(findings.items?.length, 1);
    assert.equal(findings.items[0].presentation.candidates.length, 2);
    assert.equal(findings.nextCursor, null);
    response = await fetch(`${origin}/api/findings?jobId=${deniedReview.id}`, { headers: { cookie: sessionCookie } });
    assert.deepEqual(await response.json(), { items: [], nextCursor: null });
    response = await fetch(`${origin}/api/findings?jobId=invalid`, { headers: { cookie: sessionCookie } });
    assert.equal(response.status, 422);
    const [repeat] = await database.saveFindings(
      review,
      [{ ...finding, path: "src/repeat.ts", repeatOf: { id: stored[0]!.id, title: "旧问题" } }],
      new Set(),
    );
    response = await fetch(`${origin}/api/findings?repositoryId=${allowedId}`, { headers: { cookie: sessionCookie } });
    let listed = (await response.json()) as any;
    assert(!listed.items.some((item: any) => item.id === repeat!.id), "讨论列表不重复列出之前提过的问题");
    response = await fetch(`${origin}/api/findings?jobId=${review.id}`, { headers: { cookie: sessionCookie } });
    listed = await response.json();
    assert(
      listed.items.some((item: any) => item.id === repeat!.id),
      "单次审查仍能拿到全部问题",
    );
    response = await fetch(`${origin}/api/overview`, { headers: { cookie: sessionCookie } });
    assert.equal(((await response.json()) as any).quality.findings, 0, "之前提过的问题不重复计入意见数");
    await database.pool.query("DELETE FROM review_findings WHERE id=$1", [repeat!.id]);
    const extra = Array.from({ length: 53 }, (_, i) => ({ ...finding, path: `src/page-${i}.ts` }));
    await database.saveFindings(review, extra, new Set(extra));
    for (let i = 0; i < 3; i++) {
      const replyJob = randomUUID();
      await database.pool.query(
        "INSERT INTO jobs(id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,status) VALUES($1,'REPLY_HANDLE',$2,1,'owner/allowed',1,'head','base','succeeded')",
        [replyJob, allowedId],
      );
      await database.pool.query(
        "INSERT INTO reply_publications(source_comment_id,job_id,finding_id,status,created_at) VALUES($1,$2,$3,'published','2026-09-15T00:00:00.000002Z')",
        [8000 + i, replyJob, stored[0]!.id],
      );
    }
    await database.pool.query(
      "UPDATE review_findings SET created_at='2026-09-15T00:00:00.000001Z' WHERE repository_id=$1",
      [allowedId],
    );
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let firstCursor = "";
    do {
      const query = new URLSearchParams({ jobId: review.id, repositoryId: String(allowedId), limit: "7" });
      if (cursor) query.set("cursor", cursor);
      response = await fetch(`${origin}/api/findings?${query}`, { headers: { cookie: sessionCookie } });
      assert.equal(response.status, 200);
      const page: any = await response.json();
      assert(page.items.length <= 7);
      assert(page.items.length > 0);
      for (const item of page.items) {
        const key = item.id + ":" + (item.source_comment_id ?? "root");
        assert(!seen.has(key), "跨页重复");
        seen.add(key);
        assert.equal(Number(item.repository_id), allowedId);
      }
      cursor = page.nextCursor;
      firstCursor ||= cursor ?? "";
      pages++;
      assert(pages < 20);
    } while (cursor);
    assert.equal(seen.size, 56, "同时间、多回复分页不能遗漏");
    hasAccess = false;
    response = await fetch(
      `${origin}/api/findings?jobId=${review.id}&repositoryId=${allowedId}&cursor=${firstCursor}`,
      { headers: { cookie: sessionCookie } },
    );
    assert.deepEqual(await response.json(), { items: [], nextCursor: null }, "旧游标不能绕过撤销的权限");
    hasAccess = true;
    for (const query of ["limit=0", "limit=51", "cursor=garbage", "repositoryId=oops", `cursor=${firstCursor}`]) {
      response = await fetch(`${origin}/api/findings?${query}`, { headers: { cookie: sessionCookie } });
      assert.equal(response.status, 422);
    }
    response = await fetch(`${origin}/api/findings?repositoryId=${deniedId}`, { headers: { cookie: sessionCookie } });
    assert.deepEqual(await response.json(), { items: [], nextCursor: null });
    await database.pool.query("DELETE FROM reply_publications WHERE finding_id=$1", [stored[0]!.id]);
    for (const patch of [
      null,
      [],
      { status: "ACTIVE" },
      { source: {} },
      { title: " " },
      { scope: [] },
      { scope: { owner: ["foreign"] } },
    ]) {
      response = await fetch(`${origin}/api/memories/${allowedMemory}`, {
        method: "PATCH",
        headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf },
        body: JSON.stringify(patch),
      });
      assert.equal(response.status, 422);
    }
    response = await fetch(`${origin}/api/repositories/${allowedId}`, {
      method: "PATCH",
      headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(response.status, 200);
    const paused = await database.accept(
      {
        deliveryId: "paused-delivery",
        installationId: 1,
        repositoryId: allowedId,
        repository: "owner/allowed",
        cloneUrl: "url",
        prNumber: 3,
        title: "",
        body: "",
        baseSha: "base",
        headSha: "head",
      },
      { event: "pull_request", action: "opened" },
    );
    assert.equal(paused.job, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await database.close();
  }
});
