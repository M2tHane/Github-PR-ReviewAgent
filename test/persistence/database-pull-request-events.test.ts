import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../../src/persistence/database.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();
let delivery = 0;

function pr(repositoryId: number, headSha: string) {
  return {
    deliveryId: `pr-events-${++delivery}`,
    installationId: 1,
    repositoryId,
    repository: `owner/pr-events-${repositoryId}`,
    cloneUrl: "https://github.com/owner/x.git",
    prNumber: 1,
    title: "t",
    body: "",
    baseSha: "base",
    headSha,
  };
}
const at = (minute: number) => `2026-11-09T08:${String(minute).padStart(2, "0")}:00.000Z`;
const event = (action: string, minute?: number, extra: object = {}) => ({
  event: "pull_request",
  action,
  ...(minute === undefined ? {} : { eventAt: at(minute) }),
  ...extra,
});

async function jobs(database: Database, repositoryId: number) {
  return (
    await database.pool.query(
      "SELECT job_type,target_sha,status,cancel_requested FROM jobs WHERE repository_id=$1 ORDER BY created_at",
      [repositoryId],
    )
  ).rows;
}
async function clear(database: Database, repositoryId: number) {
  await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM pull_request_events WHERE repository_id=$1", [repositoryId]);
}

test("迟到的旧 synchronize 不顶掉新 head 的 Review，也不为旧 head 建任务", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const repo = 9_300_000_001;
  try {
    assert.equal((await database.accept(pr(repo, "head-new"), event("synchronize", 2))).kind, "accepted");
    const old = await database.accept(pr(repo, "head-old"), event("synchronize", 1));
    assert.equal(old.kind, "stale");
    assert.equal(old.job, undefined);
    assert.deepEqual(
      (await jobs(database, repo)).map((row) => [row.target_sha, row.status]),
      [["head-new", "queued"]],
    );
    // 运行中的新 head 任务也不会被要求取消。
    const running = (await database.claimNext())!;
    assert.equal(running.headSha, "head-new");
    assert.equal((await database.accept(pr(repo, "head-older"), event("opened", 0))).kind, "stale");
    assert.equal((await jobs(database, repo))[0].cancel_requested, null);
    // 同一秒的事件照常处理：不能排序时保持原来的行为。
    assert.equal((await database.accept(pr(repo, "head-same"), event("synchronize", 2))).kind, "accepted");
    assert.equal((await jobs(database, repo))[0].cancel_requested, "superseded");
  } finally {
    await clear(database, repo);
    await database.close();
  }
});

test("迟到的旧 closed 不取消重新打开后的 Review；合并事件迟到也照常抽取规则", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const repo = 9_300_000_002;
  try {
    await database.accept(pr(repo, "head-a"), event("reopened", 5));
    assert.equal((await database.accept(pr(repo, "head-a"), event("closed", 4, { merged: false }))).kind, "stale");
    assert.deepEqual(
      (await jobs(database, repo)).map((row) => row.status),
      ["queued"],
    );
    // 合并是终态：时间早于已记录的事件也要建规则抽取任务。
    const merged = await database.accept(
      pr(repo, "head-a"),
      event("closed", 3, { merged: true, mergeCommitSha: "merge-sha" }),
    );
    assert.equal(merged.kind, "accepted");
    assert.deepEqual(
      (await jobs(database, repo)).map((row) => [row.job_type, row.status]),
      [
        ["PR_REVIEW", "cancelled"],
        ["DECISION_EXTRACT", "queued"],
      ],
    );
  } finally {
    await clear(database, repo);
    await database.close();
  }
});

test("转草稿、关闭这类取消：旧事件不取消，新事件照常取消", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const repo = 9_300_000_003;
  try {
    await database.accept(pr(repo, "head-a"), event("ready_for_review", 10));
    const running = (await database.claimNext())!;
    const controller = new AbortController();
    database.registerReviewAbort(running, controller);
    await database.cancelReview(repo, 1, at(9));
    assert.equal(controller.signal.aborted, false);
    assert.equal((await jobs(database, repo))[0].cancel_requested, null);
    await database.cancelReview(repo, 1, at(11));
    assert.equal(controller.signal.reason, "cancelled");
    assert.equal((await jobs(database, repo))[0].cancel_requested, "cancelled");
    database.unregisterReviewAbort(running);
  } finally {
    await clear(database, repo);
    await database.close();
  }
});

test("没有快照时间的事件按原来的规则处理", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const repo = 9_300_000_004;
  try {
    await database.accept(pr(repo, "head-new"), event("synchronize", 2));
    assert.equal((await database.accept(pr(repo, "head-old"), event("synchronize"))).kind, "accepted");
    assert.deepEqual(
      (await jobs(database, repo)).map((row) => [row.target_sha, row.status]),
      [
        ["head-new", "superseded"],
        ["head-old", "queued"],
      ],
    );
  } finally {
    await clear(database, repo);
    await database.close();
  }
});
