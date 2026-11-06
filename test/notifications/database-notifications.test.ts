import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Database } from "../../src/persistence/database.js";
import { NotificationRepository } from "../../src/persistence/repositories/notification.repository.js";
import { NotificationWorker } from "../../src/notifications/worker.js";
import { deliverBotNotification, reviewNotificationChannel } from "../../src/notifications/wecom.js";
import { useTestDatabase } from "../helpers/database.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { GitHubApiError } from "../../src/github/client.js";

const fixture = useTestDatabase();
let nextRepo = 91000;
async function setup(t: TestContext) {
  const repositoryId = ++nextRepo;
  const repository = `owner/notifications-${repositoryId}`;
  const channel = reviewNotificationChannel(randomUUID());
  const chatId = `group-${repositoryId}`;
  const db = new Database(fixture.url!, 1, channel);
  t.after(() => db.close());
  await db.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
    repositoryId,
    repository,
  ]);
  const bind = async (id: number, chat: string) =>
    db.pool.query(
      `INSERT INTO development_settings(repository_id,chat_id,target_branch,enabled,members,protections,updated_by)
     VALUES($1,$2,'main',true,'[{"userid":"admin","role":"admin"}]','[]','maintainer')`,
      [id, chat],
    );
  await bind(repositoryId, chatId);
  const config = { allowedRepositories: new Set([repository]) };
  const makeJob = async (partial = false, published = true, id = repositoryId, repo = repository) => {
    const deliveryId = randomUUID();
    const { job } = await db.accept(
      {
        deliveryId,
        installationId: 1,
        repositoryId: id,
        repository: repo,
        cloneUrl: `https://github.com/${repo}.git`,
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
    job.reviewUrl = `https://github.com/${repo}/pull/${job.prNumber}#pullrequestreview-123`;
    await db.beginPublication(job, deliveryId);
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
    user: { id: 77, login: "UnmappedAuthor" },
  };
  const github = { installationToken: async () => "fake-token", getPullRequest: async () => pr };
  const messages: Array<{ chatId: string; content: string }> = [];
  const sender = async (target: string, message: { markdown: { content: string } }) => {
    messages.push({ chatId: target, content: message.markdown.content });
    return { status: "sent" as const };
  };
  const worker = (send: ConstructorParameters<typeof NotificationWorker>[4] = sender) =>
    new NotificationWorker(config, channel, new NotificationRepository(db.pool), github, send, () => true);
  const row = async (job: ReviewJob) =>
    (await db.pool.query("SELECT * FROM review_notifications WHERE job_id=$1", [job.id])).rows[0];
  const ready = async (job: ReviewJob) => {
    await db.pool.query("UPDATE review_notifications SET next_run_at=now()-interval '1 second' WHERE job_id=$1", [
      job.id,
    ]);
    await db.pool.query("UPDATE notification_channels SET last_attempt_at=now()-interval '1 minute' WHERE channel=$1", [
      channel,
    ]);
  };
  return {
    db,
    channel,
    repositoryId,
    repository,
    chatId,
    bind,
    makeJob,
    pr,
    github,
    messages,
    worker,
    row,
    ready,
    config,
  };
}

test("审查通知按仓库绑定群隔离，不需要成员映射，不 @任何人", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  const first = await s.makeJob();
  const otherId = ++nextRepo,
    otherRepo = `owner/notifications-${otherId}`;
  s.config.allowedRepositories.add(otherRepo);
  await s.db.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [otherId, otherRepo]);
  await s.bind(otherId, "other-group");
  const second = await s.makeJob(false, true, otherId, otherRepo);
  await s.worker().tick();
  await s.ready(second);
  await s.worker().tick();
  assert.equal((await s.row(first)).status, "sent");
  assert.equal((await s.row(second)).status, "sent");
  assert.deepEqual(
    s.messages.map((m) => m.chatId),
    [s.chatId, "other-group"],
  );
  assert(s.messages.every((m) => !m.content.includes("<@") && !m.content.includes("UnmappedAuthor")));
  assert(s.messages[0].content.includes(s.repository));
  assert(s.messages[1].content.includes(otherRepo));
});

test("GitHub 限流遵守等待时间；明确失权不重试；读取期间改绑不发送", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob();
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
  assert.equal((await s.row(job)).last_error, "github_access_denied");
  const next = await s.makeJob();
  s.github.getPullRequest = async () => {
    await s.db.pool.query(
      "UPDATE development_settings SET chat_id='changed',version=version+1 WHERE repository_id=$1",
      [s.repositoryId],
    );
    return s.pr;
  };
  await s.worker().tick();
  assert.equal((await s.row(next)).status, "cancelled");
  assert.equal(s.messages.length, 0);
});

test("服务停止中止活动的 GitHub 读取并等待通知退出，不发群消息", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob();
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
  const worker = new NotificationWorker(
    s.config,
    s.channel,
    new NotificationRepository(s.db.pool),
    github,
    async () => {
      throw new Error("must not send");
    },
    () => true,
  );
  t.after(() => worker.stop());
  worker.start();
  await reading;
  await worker.stop();
  assert.equal((await s.row(job)).status, "pending");
  assert.equal((await s.row(job)).attempt, 1);
});

test("仅发布成功且绑定已启用群才入队，重复完成只保留一条，无机器人时不补发历史", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob(false, false);
  await s.db.finishPublication(job, "uncertain");
  assert.equal(await s.row(job), undefined);
  await s.db.finishPublication(job, "published");
  await s.db.finishPublication(job, "published");
  assert.equal((await s.row(job)).attempt, 0);
  assert.equal((await s.row(job)).chat_id, s.chatId);
  const unconfigured = new Database(fixture.url!);
  try {
    const disabled = await s.makeJob(false, false);
    await unconfigured.finishPublication(disabled, "published");
    assert.equal(await s.row(disabled), undefined);
  } finally {
    await unconfigured.close();
  }
  await s.db.pool.query("UPDATE development_settings SET enabled=false WHERE repository_id=$1", [s.repositoryId]);
  assert.equal(await s.row(await s.makeJob()), undefined);
  await s.db.pool.query("DELETE FROM development_settings WHERE repository_id=$1", [s.repositoryId]);
  assert.equal(await s.row(await s.makeJob()), undefined);
});

test("部分审查直发群：使用当前标题和链接，不带审查私密细节，不因缺少映射失败", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob(true);
  await s.worker().tick();
  assert.equal((await s.row(job)).status, "sent");
  const content = s.messages[0].content;
  assert.match(content, /^\*\*AI 审查结果已发布（部分检查未完成）/);
  assert(content.includes(`/pull/${job.prNumber}`) && content.includes("current PR title"));
  assert(!content.includes("private") && !content.includes("stale webhook title") && !content.includes("<@"));
  await s.worker().tick();
  assert.equal(s.messages.length, 1);
});

test("多实例投递互斥、共用机器人限速，换机器人不投递旧队列", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    first = await s.makeJob(),
    second = await s.makeJob();
  let sent = 0;
  const send = async () => {
    sent++;
    await s.worker().tick();
    return { status: "sent" as const };
  };
  await Promise.all([s.worker(send).tick(), s.worker(send).tick()]);
  assert.equal(sent, 1);
  assert.equal(s.messages.length, 0);
  const pending = (await s.row(first)).status === "pending" ? first : second;
  await s.ready(pending);
  await new NotificationWorker(
    s.config,
    reviewNotificationChannel("other-bot"),
    new NotificationRepository(s.db.pool),
    s.github,
    send,
    () => true,
  ).tick();
  assert.equal(sent, 1);
  await s.worker().tick();
  assert.equal((await s.row(pending)).status, "sent");
});

test("旧 head、Draft、关闭、停用、撤销、移出白名单与群绑定变更均取消旧通知", { skip: !fixture.url }, async (t) => {
  for (const change of [
    "head",
    "draft",
    "closed",
    "disabled",
    "revoked",
    "allowlist",
    "group",
    "binding-disabled",
    "version",
  ]) {
    const s = await setup(t),
      job = await s.makeJob();
    if (change === "head") s.pr.head.sha = "new-head";
    if (change === "draft") s.pr.draft = true;
    if (change === "closed") s.pr.state = "closed";
    if (change === "allowlist") s.config.allowedRepositories.clear();
    if (change === "disabled")
      await s.db.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [s.repositoryId]);
    if (change === "revoked")
      await s.db.pool.query("UPDATE repositories SET revoked_at=now() WHERE id=$1", [s.repositoryId]);
    if (change === "group")
      await s.db.pool.query("UPDATE development_settings SET chat_id='moved-'||chat_id WHERE repository_id=$1", [
        s.repositoryId,
      ]);
    if (change === "binding-disabled")
      await s.db.pool.query("UPDATE development_settings SET enabled=false WHERE repository_id=$1", [s.repositoryId]);
    if (change === "version")
      await s.db.pool.query("UPDATE development_settings SET version=version+1 WHERE repository_id=$1", [
        s.repositoryId,
      ]);
    await s.worker().tick();
    assert.equal((await s.row(job)).status, "cancelled", change);
    assert.equal(s.messages.length, 0, change);
  }
});

test("明确限流只重试通知，最多三次；未知结果与中断发送不重发", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob();
  let calls = 0;
  const limited = () =>
    deliverBotNotification(async () => {
      calls++;
      throw { errcode: 45009 };
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
  const lost = await s.makeJob();
  await s.ready(lost);
  const fail = () =>
    deliverBotNotification(async () => {
      calls++;
      throw new Error("socket lost");
    });
  await s.worker(fail).tick();
  await s.worker(fail).tick();
  assert.equal((await s.row(lost)).status, "uncertain");
  assert.equal(calls, 4);
  const crashed = await s.makeJob();
  await s.db.pool.query("UPDATE review_notifications SET status='sending' WHERE job_id=$1", [crashed.id]);
  await s.worker().tick();
  assert.equal((await s.row(crashed)).status, "uncertain");
  assert.equal(s.messages.length, 0);
});

test("发送前 GitHub 读取失败可重试，停止后不投递，删除任务级联清理通知", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob();
  s.github.getPullRequest = async () => {
    throw new Error("read failed");
  };
  await s.worker().tick();
  assert.equal((await s.row(job)).last_error, "github_lookup_failed");
  const stopped = s.worker();
  await stopped.stop();
  await s.ready(job);
  await stopped.tick();
  assert.equal((await s.row(job)).attempt, 1);
  await s.db.pool.query("DELETE FROM jobs WHERE id=$1", [job.id]);
  assert.equal(await s.row(job), undefined);
});

test("未认证不领取审查通知，限速排队期间改绑仍阻止真正发送", { skip: !fixture.url }, async (t) => {
  const s = await setup(t),
    job = await s.makeJob();
  const disconnected = new NotificationWorker(
    s.config,
    s.channel,
    new NotificationRepository(s.db.pool),
    s.github,
    async () => {
      throw new Error("must not send");
    },
    () => false,
  );
  await disconnected.tick();
  assert.equal((await s.row(job)).attempt, 0);
  let networkCalls = 0;
  await s
    .worker((_chat, _message, _signal, checkBinding) =>
      deliverBotNotification(async () => {
        await s.db.pool.query("UPDATE development_settings SET version=version+1 WHERE repository_id=$1", [
          s.repositoryId,
        ]);
        await checkBinding();
        networkCalls++;
      }),
    )
    .tick();
  assert.equal(networkCalls, 0);
  assert.equal((await s.row(job)).status, "cancelled");
});
