import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Database } from "../../src/persistence/database.js";
import { NotificationRepository } from "../../src/persistence/repositories/notification.repository.js";
import { loadWecomConfig } from "../../src/notifications/config.js";
import { NotificationWorker } from "../../src/notifications/worker.js";
import { WecomClient } from "../../src/notifications/wecom.js";
import { useTestDatabase } from "../helpers/database.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { NotificationMemberRepository } from "../../src/persistence/repositories/notification-member.repository.js";
import { GitHubApiError } from "../../src/github/client.js";

const fixture = useTestDatabase();
let nextRepo = 91000;
async function setup(t: TestContext) {
  const repositoryId = ++nextRepo;
  const repository = `owner/notifications-${repositoryId}`;
  const wecom = loadWecomConfig({
    WECOM_WEBHOOK_URL: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${randomUUID()}`,
  })!;
  const db = new Database(fixture.url!, 1, wecom.channel);
  t.after(() => db.close());
  await db.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
    repositoryId,
    repository,
  ]);
  const members = new NotificationMemberRepository(db.pool);
  await members.save(repositoryId, { githubLogin: "alice", wecomUserId: "zhangsan" });
  const config = { allowedRepositories: new Set([repository]) };
  const makeJob = async (partial = false, published = true) => {
    const id = randomUUID();
    const { job } = await db.accept(
      {
        deliveryId: id,
        installationId: 1,
        repositoryId,
        repository,
        cloneUrl: `https://github.com/${repository}.git`,
        prNumber: ++nextRepo,
        title: "stale webhook title",
        body: "private review details",
        baseSha: "base",
        headSha: "head123456",
      },
      { event: "pull_request", action: "opened" },
    );
    assert(job);
    job.status = partial ? "partial" : "running";
    job.reviewId = 123;
    job.reviewUrl = `https://github.com/${repository}/pull/${job.prNumber}#pullrequestreview-123`;
    await db.beginPublication(job, id);
    if (published) await db.finishPublication(job, "published");
    return job;
  };
  const pr = {
    number: 1,
    title: "current PR title",
    body: "private body",
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    base: { sha: "base" },
    head: { sha: "head123456" },
    user: { id: 77, login: "Alice" },
  };
  const github = { installationToken: async () => "fake-token", getPullRequest: async () => pr };
  const messages: any[] = [];
  const client = new WecomClient(wecom.webhookUrl, async (_url, init) => {
    messages.push(JSON.parse(init!.body as string));
    return Response.json({ errcode: 0 });
  });
  const worker = (sender = client) =>
    new NotificationWorker(config, wecom, new NotificationRepository(db.pool), github, sender);
  const row = async (job: ReviewJob) =>
    (await db.pool.query("SELECT * FROM review_notifications WHERE job_id=$1", [job.id])).rows[0];
  const ready = async (job: ReviewJob) => {
    await db.pool.query("UPDATE review_notifications SET next_run_at=now()-interval '1 second' WHERE job_id=$1", [
      job.id,
    ]);
    await db.pool.query("UPDATE notification_channels SET last_attempt_at=now()-interval '1 minute' WHERE channel=$1", [
      wecom.channel,
    ]);
  };
  return { db, members, wecom, repositoryId, makeJob, pr, github, messages, worker, row, ready, config };
}

test("仓库隔离：同一 GitHub 作者在不同仓库使用不同成员 ID，禁止跨仓库兜底", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const first = await s.makeJob();
  const otherRepositoryId = ++nextRepo;
  const otherRepository = `owner/notifications-${otherRepositoryId}`;
  s.config.allowedRepositories.add(otherRepository);
  const accepted = await s.db.accept(
    {
      deliveryId: randomUUID(),
      installationId: 1,
      repositoryId: otherRepositoryId,
      repository: otherRepository,
      cloneUrl: `https://github.com/${otherRepository}.git`,
      prNumber: 1,
      title: "t",
      body: "",
      baseSha: "base",
      headSha: "head123456",
    },
    { event: "pull_request", action: "opened" },
  );
  await s.members.save(otherRepositoryId, { githubLogin: "alice", wecomUserId: "lisi" });
  const second = accepted.job!;
  second.reviewId = 124;
  second.reviewUrl = `https://github.com/${otherRepository}/pull/1`;
  await s.db.beginPublication(second, randomUUID());
  await s.db.finishPublication(second, "published");
  await s.worker().tick();
  await s.ready(second);
  await s.worker().tick();
  assert.equal((await s.row(first)).status, "sent");
  assert.equal((await s.row(second)).status, "sent");
  const firstMessage = s.messages.find((message) => message.markdown.content.includes(first.repository));
  const secondMessage = s.messages.find((message) => message.markdown.content.includes(otherRepository));
  assert(firstMessage.markdown.content.startsWith("<@zhangsan>\n"));
  assert(secondMessage.markdown.content.startsWith("<@lisi>\n"));
  const missing = await s.makeJob();
  await s.members.remove(s.repositoryId, "alice");
  await s.ready(missing);
  await s.worker().tick();
  assert.equal((await s.row(missing)).last_error, "author_mapping_missing");
  assert.equal(s.messages.length, 2);
  await s.members.save(s.repositoryId, { githubLogin: "bob", wecomUserId: "wangwu" });
  const absentAuthor = await s.makeJob();
  await s.worker().tick();
  assert.equal((await s.row(absentAuthor)).last_error, "author_mapping_missing");
  assert.equal(s.messages.length, 2);
  await s.members.save(s.repositoryId, { githubLogin: "alice", wecomUserId: "updated-user" });
  const updated = await s.makeJob();
  await s.worker().tick();
  assert.equal((await s.row(updated)).status, "sent");
  assert(s.messages[2].markdown.content.startsWith("<@updated-user>\n"));
});

test("GitHub 限流遵守等待时间；明确失权不重试；读取期间停用仓库不发送", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob();
  s.github.getPullRequest = async () => {
    throw new GitHubApiError("/pulls/1", 403, 600);
  };
  await s.worker().tick();
  let row = await s.row(job);
  assert.equal(row.status, "pending");
  assert(new Date(row.next_run_at).getTime() - new Date(row.updated_at).getTime() >= 600_000);
  await s.ready(job);
  s.github.getPullRequest = async () => {
    throw new GitHubApiError("/pulls/1", 403);
  };
  await s.worker().tick();
  row = await s.row(job);
  assert.equal(row.status, "failed");
  assert.equal(row.last_error, "github_access_denied");
  const next = await s.makeJob();
  s.github.getPullRequest = async () => {
    await s.db.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [s.repositoryId]);
    return s.pr;
  };
  await s.worker().tick();
  assert.equal((await s.row(next)).status, "cancelled");
  assert.equal(s.messages.length, 0);
});

test("服务停止中止活动的 GitHub 读取并等待通知退出，不发群消息", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const github = {
    installationToken: s.github.installationToken,
    getPullRequest: async (
      _token: string,
      _repo: string,
      _number: number,
      signal?: AbortSignal,
    ): Promise<typeof s.pr> => {
      started();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
    },
  };
  const sender = new WecomClient(s.wecom.webhookUrl, async () => {
    throw new Error("must not send");
  });
  const worker = new NotificationWorker(s.config, s.wecom, new NotificationRepository(s.db.pool), github, sender);
  t.after(() => worker.stop());
  worker.start();
  await reading;
  await worker.stop();
  assert.equal((await s.row(job)).status, "pending");
  assert.equal((await s.row(job)).attempt, 1);
});

test("通知持久化：仅发布成功入队，重复完成只保留一条，未配置时不补发历史审查", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob(false, false);
  assert.equal(await s.row(job), undefined);
  await s.db.finishPublication(job, "uncertain");
  assert.equal(await s.row(job), undefined);
  await s.db.finishPublication(job, "published");
  await s.db.finishPublication(job, "published");
  assert.equal((await s.row(job)).attempt, 0);
  const unconfigured = new Database(fixture.url!);
  try {
    const disabled = await s.makeJob(false, false);
    await unconfigured.finishPublication(disabled, "published");
    assert.equal(await s.row(disabled), undefined);
  } finally {
    await unconfigured.close();
  }
});

test("通知端到端：按 PR 作者关联 ID、发送链接，不带审查细节，部分结果明确说明", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob(true);
  await s.worker().tick();
  assert.equal((await s.row(job)).status, "sent");
  assert(s.messages[0].markdown.content.startsWith("<@zhangsan>\n"));
  assert.match(s.messages[0].markdown.content, /部分检查未完成/);
  assert(s.messages[0].markdown.content.includes(`/pull/${job.prNumber}`));
  assert(s.messages[0].markdown.content.includes("current PR title"));
  assert(!s.messages[0].markdown.content.includes("stale webhook title"));
  await s.worker().tick();
  assert.equal(s.messages.length, 1);
  assert.equal(
    (await s.db.pool.query("SELECT status FROM review_publications WHERE job_id=$1", [job.id])).rows[0].status,
    "published",
  );
});

test("多实例：投递期间其他连接无法发送，同一个群共享限速，换群不投递旧队列", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const first = await s.makeJob();
  const second = await s.makeJob();
  let sent = 0;
  const client = new WecomClient(s.wecom.webhookUrl, async () => {
    sent++;
    await s.worker().tick();
    assert.equal(s.messages.length, 0);
    return Response.json({ errcode: 0 });
  });
  await Promise.all([s.worker(client).tick(), s.worker(client).tick()]);
  assert.equal(sent, 1);
  await s.worker().tick();
  assert.equal(s.messages.length, 0);
  assert.deepEqual([(await s.row(first)).status, (await s.row(second)).status].sort(), ["pending", "sent"]);
  const pending = (await s.row(first)).status === "pending" ? first : second;
  await s.ready(pending);
  const other = { ...s.wecom, channel: "other-channel" };
  await new NotificationWorker(s.config, other, new NotificationRepository(s.db.pool), s.github, client).tick();
  assert.equal(sent, 1);
  await s.worker().tick();
  assert.equal((await s.row(pending)).status, "sent");
});

test("通知失败：缺少关联明确失败，不回退 GitHub 发布，不 @ 所有人", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob();
  s.pr.user.login = "unmapped";
  await s.worker().tick();
  assert.equal((await s.row(job)).last_error, "author_mapping_missing");
  assert.equal((await s.row(job)).status, "failed");
  assert.equal(s.messages.length, 0);
  assert.equal(
    (await s.db.pool.query("SELECT status FROM review_publications WHERE job_id=$1", [job.id])).rows[0].status,
    "published",
  );
});

test("过期通知：新 head、Draft、关闭、仓库停用和撤销均取消", { skip: !fixture.url }, async (t) => {
  for (const change of ["head", "draft", "closed", "disabled", "revoked", "allowlist"]) {
    const s = await setup(t);
    const job = await s.makeJob();
    if (change === "head") s.pr.head.sha = "new-head";
    if (change === "draft") s.pr.draft = true;
    if (change === "closed") s.pr.state = "closed";
    if (change === "allowlist") s.config.allowedRepositories.clear();
    if (change === "disabled")
      await s.db.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [s.repositoryId]);
    if (change === "revoked")
      await s.db.pool.query("UPDATE repositories SET revoked_at=now() WHERE id=$1", [s.repositoryId]);
    await s.worker().tick();
    assert.equal((await s.row(job)).status, "cancelled", change);
    assert.equal(s.messages.length, 0, change);
  }
});

test("明确限流：只重试通知，跨实例保留次数，最多三次", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob();
  let calls = 0;
  const limited = new WecomClient(s.wecom.webhookUrl, async () => {
    calls++;
    return Response.json({ errcode: 45009 });
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await s.ready(job);
    await s.worker(limited).tick();
    assert.equal((await s.row(job)).attempt, attempt);
    assert.equal((await s.row(job)).status, attempt < 3 ? "pending" : "failed");
  }
  await s.ready(job);
  await s.worker(limited).tick();
  assert.equal(calls, 3);
});

test("网络响应丢失和进程中断保留 uncertain，新实例不重发", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const lost = await s.makeJob();
  let calls = 0;
  const failing = new WecomClient(s.wecom.webhookUrl, async () => {
    calls++;
    throw new Error("socket lost");
  });
  await s.worker(failing).tick();
  await s.worker(failing).tick();
  assert.equal((await s.row(lost)).status, "uncertain");
  assert.equal(calls, 1);
  const crashed = await s.makeJob();
  await s.db.pool.query("UPDATE review_notifications SET status='sending' WHERE job_id=$1", [crashed.id]);
  await s.worker().tick();
  assert.equal((await s.row(crashed)).status, "uncertain");
  assert.equal(s.messages.length, 0);
});

test("发送前 GitHub 读取失败可重试，停止后不再投递，任务删除级联清理通知", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const job = await s.makeJob();
  s.github.getPullRequest = async () => {
    throw new Error("read failed");
  };
  await s.worker().tick();
  assert.equal((await s.row(job)).status, "pending");
  assert.equal((await s.row(job)).last_error, "github_lookup_failed");
  const stopped = s.worker();
  await stopped.stop();
  await s.ready(job);
  await stopped.tick();
  assert.equal((await s.row(job)).attempt, 1);
  await s.db.pool.query("DELETE FROM jobs WHERE id=$1", [job.id]);
  assert.equal(await s.row(job), undefined);
});
