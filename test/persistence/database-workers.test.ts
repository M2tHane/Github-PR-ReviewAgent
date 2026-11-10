import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../../src/persistence/database.js";
import { PersistentRunner } from "../../src/jobs/runner.js";
import { DatabaseSessionStore } from "../../src/admin/session-store.js";
import { createApp } from "../../src/github/webhook/handler.js";
import type { Config } from "../../src/config/config.js";
import type { AgentJob } from "../../src/jobs/types.js";
import { useTestDatabase, waitFor } from "../helpers/database.js";

const fixture = useTestDatabase();
let delivery = 0;

// 两个 Database 实例模拟两台机器上的 Worker，共用同一个库。
async function workers() {
  return [new Database(fixture.url!), new Database(fixture.url!)] as const;
}
function pr(repositoryId: number, prNumber: number, headSha = `head-${prNumber}`) {
  return {
    deliveryId: `workers-${++delivery}`,
    installationId: 1,
    repositoryId,
    repository: `owner/workers-${repositoryId}`,
    cloneUrl: "https://github.com/owner/x.git",
    prNumber,
    title: "t",
    body: "",
    baseSha: "base",
    headSha,
  };
}
const opened = { event: "pull_request", action: "opened" };
async function clear(database: Database, ids: number[]) {
  await database.pool.query("DELETE FROM jobs WHERE repository_id=ANY($1::bigint[])", [ids]);
}

test("多实例领取：同一个 PR 的任务一次只跑一个，同仓库不同 PR 可以并行", { skip: !fixture.url }, async () => {
  const [a, b] = await workers();
  const repo = 9_200_000_001;
  try {
    const first = await a.accept(pr(repo, 1), opened);
    const claimedA = await a.claimNext();
    assert.equal(claimedA?.id, first.job!.id);
    assert.notEqual(claimedA?.leaseToken, undefined);
    // 同一个 PR 合并后的规则抽取排在前面，也要等这个 PR 正在跑的任务结束；同仓库的另一个 PR 不用等。
    const decision = await a.accept(pr(repo, 1), {
      event: "pull_request",
      action: "closed",
      merged: true,
      mergeCommitSha: "merge-1",
    });
    const second = await a.accept(pr(repo, 2), opened);
    assert.equal((await b.claimNext())?.id, second.job!.id, "同仓库的另一个 PR 可以同时领取");
    assert.equal(await b.claimNext(), undefined, "同一个 PR 的下一个任务要等");
    await a.finishJob(claimedA!);
    assert.equal((await b.claimNext())?.id, decision.job!.id, "前一个结束后才轮到");
  } finally {
    await clear(a, [repo]);
    await a.close();
    await b.close();
  }
});

test("同一个 PR 内的 Reply 仍按回复时间一个一个领取", { skip: !fixture.url }, async () => {
  const [a, b] = await workers();
  const repo = 9_200_000_003;
  try {
    const review = await a.accept(pr(repo, 1), opened);
    const finding = {
      path: "src/a.ts",
      line: 2,
      side: "RIGHT",
      category: "correctness",
      severity: "high",
      evidenceLevel: "strong",
      description: "bad",
      evidence: "line",
      impact: "crash",
    } as const;
    const stored = await a.saveFindings(review.job!, [finding], new Set([finding]));
    await a.bindFindings(review.job!, 10, [{ id: 11, body: `<!-- pi-finding:${stored[0]!.id} -->` }]);
    await a.finishJob({ ...review.job!, status: "succeeded" });
    const reply = (sourceCommentId: number, humanReplyCreatedAt: string) =>
      a.acceptReply({
        deliveryId: `workers-reply-${sourceCommentId}`,
        installationId: 1,
        repositoryId: repo,
        repository: `owner/workers-${repo}`,
        prNumber: 1,
        baseSha: "base",
        eventHeadSha: "head-1",
        rootCommentId: 11,
        sourceCommentId,
        sourceCommentUrl: `https://example/reply/${sourceCommentId}`,
        humanActorId: 42,
        humanActorLogin: "human",
        humanReplyBody: "fixed",
        humanReplyCreatedAt,
      });
    // 回复时间早于下面新建的 PR 任务，排序在前。先收到较新的回复。
    const newer = await reply(15, "2021-01-01T00:00:00Z");
    const older = await reply(14, "2020-01-01T00:00:00Z");
    const other = await a.accept(pr(repo, 2), opened);
    const claimed = await a.claimNext();
    assert.equal(claimed?.id, older.job!.id, "先领回复时间早的");
    assert.equal((await b.claimNext())?.id, other.job!.id, "同一个 PR 的下一条回复要等，另一个 PR 不用等");
    assert.equal(await b.claimNext(), undefined);
    await a.finishJob(claimed!);
    assert.equal((await b.claimNext())?.id, newer.job!.id);
  } finally {
    await clear(a, [repo]);
    await a.close();
    await b.close();
  }
});

test("实例失联：租约过期后别的实例接手，旧实例的结果不再写回；失联三次不再重试", { skip: !fixture.url }, async () => {
  const [a, b] = await workers();
  const repo = 9_200_000_011;
  try {
    const accepted = await a.accept(pr(repo, 1), opened);
    const lost = (await a.claimNext())!;
    const expire = () =>
      a.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [accepted.job!.id]);
    // 续租让租约一直有效。
    await a.renewLeases([lost], 60_000);
    assert.equal(await b.claimNext(), undefined);
    await expire();
    const taken = (await b.claimNext())!;
    assert.equal(taken.id, lost.id);
    assert.equal(taken.attempt, 2);
    assert.notEqual(taken.leaseToken, lost.leaseToken);
    await a.finishJob({ ...lost, status: "succeeded" });
    assert.equal((await a.getJob(lost.id))?.status, "running", "旧实例的租约已失效，不能写回结果");
    const stops = await a.renewLeases([lost]);
    assert.deepEqual(
      stops.map((item) => item.reason),
      ["cancelled"],
      "旧实例续租时发现任务已被接手，停止本地会话",
    );
    await expire();
    assert.equal((await a.claimNext())?.attempt, 3);
    await expire();
    assert.equal(await b.recoverExpired(), 1);
    const failed = await a.getJob(lost.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /多次失联/);
  } finally {
    await clear(a, [repo]);
    await a.close();
    await b.close();
  }
});

test("跨实例取消：PR 关闭或有新提交时，正在别的实例上跑的会话会停下", { skip: !fixture.url }, async () => {
  const [a, b] = await workers();
  const repo = 9_200_000_021;
  try {
    await a.accept(pr(repo, 1), opened);
    const running = (await a.claimNext())!;
    const controller = new AbortController();
    a.registerReviewAbort(running, controller);
    await b.accept(pr(repo, 1, "head-new"), { event: "pull_request", action: "synchronize" });
    assert.equal(controller.signal.aborted, false, "B 不能直接中止 A 的会话");
    const stops = await a.renewLeases([running]);
    assert.deepEqual(
      stops.map((item) => item.reason),
      ["superseded"],
    );
    assert.equal(controller.signal.reason, "superseded");
    a.unregisterReviewAbort(running);
    await a.finishJob({ ...running, status: "superseded" });

    const next = (await a.claimNext())!;
    const second = new AbortController();
    a.registerReviewAbort(next, second);
    await b.cancelReview(repo, 1);
    await a.renewLeases([next]);
    assert.equal(second.signal.reason, "cancelled");
    a.unregisterReviewAbort(next);
    // 执行实例崩溃时，已被要求取消的任务直接按取消结束，不再重新排队。
    await a.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [next.id]);
    await b.recoverExpired();
    assert.equal((await a.getJob(next.id))?.status, "cancelled");
  } finally {
    await clear(a, [repo]);
    await a.close();
    await b.close();
  }
});

test("正常停止：正在跑的任务放回队列，不计入尝试次数", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const repo = 9_200_000_031;
  let entered: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  try {
    const accepted = await database.accept(pr(repo, 1), opened);
    const runner = new PersistentRunner(
      database,
      async (job: AgentJob) => {
        const controller = new AbortController();
        database.registerReviewAbort(job, controller);
        entered();
        await new Promise((resolve) => controller.signal.addEventListener("abort", resolve));
        // 和 review.processor 一样：被中止时标成 cancelled 正常返回。
        job.status = "cancelled";
        database.unregisterReviewAbort(job);
      },
      10,
    );
    await runner.start();
    await started;
    await runner.stop();
    const job = await database.getJob(accepted.job!.id);
    assert.equal(job?.status, "queued", "部署重启不会让任务永久停在已取消");
    assert.equal(job?.attempt, 0);
    assert.match(job?.error ?? "", /服务停止/);
  } finally {
    await clear(database, [repo]);
    await database.close();
  }
});

test("并发槽位：不同仓库同时执行；健康检查至少给 PR 任务留一个槽位", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!, 3);
  const repos = [9_200_000_041, 9_200_000_042, 9_200_000_043];
  const running = new Set<string>();
  let peak = 0;
  const release: Array<() => void> = [];
  try {
    for (const id of repos)
      await database.pool.query(
        "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2) ON CONFLICT DO NOTHING",
        [id, `owner/workers-${id}`],
      );
    for (const id of repos)
      await database.enqueueHealth(id, { defaultBranch: "main", headSha: "a".repeat(40) }, "manual");
    await database.accept(pr(repos[0]!, 1), opened);
    const runner = new PersistentRunner(
      database,
      async (job: AgentJob) => {
        running.add(job.id);
        peak = Math.max(peak, running.size);
        await new Promise<void>((resolve) => release.push(resolve));
        running.delete(job.id);
      },
      10,
      { concurrency: 3 },
    );
    await runner.start();
    await waitFor(async () => running.size === 3);
    const types = (
      await database.pool.query(
        "SELECT job_type FROM jobs WHERE status='running' AND repository_id=ANY($1::bigint[])",
        [repos],
      )
    ).rows.map((row) => row.job_type);
    assert.deepEqual(types.sort(), ["HEALTH_AUDIT", "HEALTH_AUDIT", "PR_REVIEW"], "三个槽位里健康检查最多占两个");
    while (release.length) release.shift()!();
    await waitFor(async () => {
      while (release.length) release.shift()!();
      const left = await database.pool.query(
        "SELECT count(*)::int n FROM jobs WHERE status IN ('queued','running') AND repository_id=ANY($1::bigint[])",
        [repos],
      );
      return left.rows[0].n === 0;
    });
    await runner.stop();
    assert.equal(peak, 3);
  } finally {
    await clear(database, repos);
    await database.close();
  }
});

test("登录会话存在数据库：多个实例共用，ID 只存哈希、内容加密", { skip: !fixture.url }, async () => {
  const [a, b] = await workers();
  try {
    const secret = "s".repeat(32);
    const storeA = new DatabaseSessionStore<{ token: string }>(a.pool, "session", 60_000, 2, secret);
    const storeB = new DatabaseSessionStore<{ token: string }>(b.pool, "session", 60_000, 2, secret);
    assert.equal(await storeA.set("session-id-1", { token: "gho_maintainer_token" }), true);
    assert.deepEqual(await storeB.get("session-id-1"), { token: "gho_maintainer_token" }, "另一个实例也能读到");
    const raw = JSON.stringify((await a.pool.query("SELECT * FROM admin_sessions")).rows);
    assert.doesNotMatch(raw, /session-id-1|gho_maintainer_token/);
    assert.equal(await storeA.set("session-id-2", { token: "t2" }), true);
    assert.equal(await storeA.set("session-id-3", { token: "t3" }), false, "超过数量上限拒绝");
    const rotated = new DatabaseSessionStore<{ token: string }>(a.pool, "session", 60_000, 2, "x".repeat(32));
    assert.equal(await rotated.get("session-id-1"), undefined, "换了 SESSION_SECRET 后旧会话失效");
    await storeB.delete("session-id-1");
    assert.equal(await storeA.get("session-id-1"), undefined);
    await a.pool.query("UPDATE admin_sessions SET expires_at=now()-interval '1 second'");
    assert.equal(await storeA.get("session-id-2"), undefined, "过期的读不到");
    assert.equal(await storeA.set("session-id-4", { token: "t4" }), true, "过期的不占名额");
  } finally {
    await a.pool.query("DELETE FROM admin_sessions");
    await a.close();
    await b.close();
  }
});

test("探针：healthz 看进程，readyz 看数据库和是否在停止", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const { server } = createApp({ webhookMaxBytes: 1000, queueCapacity: 1 } as Config, database);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const get = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`).then((r) => r.status);
  try {
    assert.equal(await get("/healthz"), 200);
    assert.equal(await get("/readyz"), 200);
    database.stopReviews();
    assert.equal(await get("/readyz"), 503);
    assert.equal(await get("/healthz"), 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});
