import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { Database } from "../../src/persistence/database.js";
import { DevelopmentStore } from "../../src/development/store.js";
import { createAdminHandler } from "../../src/admin/handler.js";
import { memoryStore } from "../../src/admin/session-store.js";
import type { Session } from "../../src/admin/dto.js";
import type { Config } from "../../src/config/config.js";
import { loadDevelopmentConfig } from "../../src/development/config.js";
import { createApp } from "../../src/github/webhook/handler.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();
let nextId = 8_800_001;
async function setup() {
  const database = new Database(fixture.url!);
  const store = new DevelopmentStore(database.pool);
  const repoId = nextId++;
  const repository = `owner/source-${repoId}`;
  await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
    repoId,
    repository,
  ]);
  const config = {
    appId: "1",
    privateKey: "unused",
    webhookSecret: "secret",
    webhookMaxBytes: 100000,
    allowedRepositories: new Set([repository]),
    queueCapacity: 100,
    githubOAuthCallbackUrl: "http://127.0.0.1/callback",
    sessionSecret: "a".repeat(32),
    serviceAdmins: new Set(["service-admin"]),
    development: loadDevelopmentConfig({}),
  } as Config;
  let maintainer = true,
    write = true;
  const permissionChecks: string[] = [];
  const github = {
    hasMaintainerPermission: async () => maintainer,
    installationToken: async () => "installation-token",
    developmentSnapshot: async () => ({ sha: "a".repeat(40), tree: "b".repeat(40) }),
    hasWritePermission: async (token: string, repo: string, login: string) => {
      assert.equal(token, "installation-token");
      assert.equal(repo, repository);
      permissionChecks.push(login);
      return write;
    },
  };
  const sessions = memoryStore<Session>(60_000, 10);
  const headers = async (login: string) => {
    const id = randomUUID();
    await sessions.set(id, { id: 1, login, token: "oauth-token", csrf: "csrf", expiresAt: Date.now() + 60_000 });
    const sign = createHmac("sha256", config.sessionSecret!).update(id).digest("base64url");
    return { cookie: `session=${id}.${sign}`, origin: "http://127.0.0.1", "x-csrf-token": "csrf" };
  };
  const { server } = createApp(
    config,
    database,
    createAdminHandler(config, database, github as any, { sessions, states: memoryStore(60_000, 10) }),
    github,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin}/api/repositories/${repoId}/development`;
  const settings = { chatId: "", targetBranch: "main", enabled: true, members: [], protections: [], version: 0 };
  const save = async (patch = {}) => {
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: await headers("maintainer"),
      body: JSON.stringify({ ...settings, ...patch }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as any;
  };
  const label = (patch = {}) => ({
    action: "labeled",
    label: { name: "pi-dev" },
    installation: { id: 1 },
    repository: { id: repoId, full_name: repository },
    sender: { type: "User", login: "author" },
    issue: { number: 123, title: "修复导出", body: "完整保留日期筛选", state: "open" },
    ...patch,
  });
  const webhook = async (payload = label(), delivery = randomUUID()) => {
    const body = JSON.stringify(payload);
    return fetch(`${origin}/github/webhook`, {
      method: "POST",
      body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`,
      },
    });
  };
  return {
    database,
    store,
    repoId,
    repository,
    config,
    settings,
    endpoint,
    save,
    headers,
    label,
    webhook,
    permissionChecks,
    denyMaintainer: () => {
      maintainer = false;
    },
    denyWrite: () => {
      write = false;
    },
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
    },
  };
}

test("管理 API 不绑群也能保存和派任务；CSRF、维护权限、启用、白名单、队列及输入边界", {
  skip: !fixture.url,
}, async (t) => {
  let permissionTime = Date.now();
  t.mock.method(Date, "now", () => permissionTime);
  const s = await setup();
  try {
    const saved = await s.save();
    assert.equal(saved.settings.chatId, "");
    assert.deepEqual(saved.settings.members, []);
    assert.equal(
      (await s.database.pool.query("SELECT chat_id FROM development_settings WHERE repository_id=$1", [s.repoId]))
        .rows[0].chat_id,
      null,
    );
    const headers = await s.headers("Maintainer");
    const post = (prompt: unknown, requestHeaders = headers) =>
      fetch(`${s.endpoint}/tasks`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ prompt }) });
    assert.equal((await post("实现日期筛选", { ...headers, "x-csrf-token": "" })).status, 403);
    assert.equal(
      (await fetch(`${s.endpoint}/tasks`, { method: "POST", body: JSON.stringify({ prompt: "任务" }) })).status,
      401,
    );
    for (const prompt of ["", " \n ", "字".repeat(12001), null]) assert.equal((await post(prompt)).status, 422);
    for (const [login, role] of [
      ["Maintainer", "developer"],
      ["Service-Admin", "admin"],
    ]) {
      const response = await post("需".repeat(12000), await s.headers(login!));
      assert.equal(response.status, 202);
      const result = (await response.json()) as { taskId: string };
      const task = (await s.database.pool.query("SELECT * FROM development_tasks WHERE id=$1", [result.taskId]))
        .rows[0];
      assert.equal(task.role, role);
      assert.equal(task.source, "admin");
      assert.equal(task.requester_login, login);
      assert.equal(task.prompt.length, 12000);
      const listing = await fetch(s.endpoint, { headers: await s.headers("maintainer") });
      assert.equal(listing.status, 200);
      const listed = ((await listing.json()) as any).tasks.find((item: { id: string }) => item.id === task.id);
      assert.equal(listed.prompt_summary, "需".repeat(160));
      assert.equal(listed.prompt, undefined);
      assert.equal(task.bot_id, null);
      assert.equal(task.requester, null);
      assert.equal(task.chat_id, null);
      assert.equal(task.message_id, null);
      assert.equal(task.notification_status, "skipped");
      assert.equal(task.branch, `bot/development/${task.id}`);
      // 直接取得执行令牌和租约，检查空群的运行时权限边界。
      task.owner_token = randomUUID();
      await s.database.pool.query(
        "UPDATE development_tasks SET status='running',owner_token=$2,attempt=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1",
        [task.id, task.owner_token],
      );
      await s.store.permission(task, s.config);
    }
    s.config.queueCapacity = 0;
    assert.equal((await post("任务")).status, 409);
    s.config.queueCapacity = 100;
    await s.save({ enabled: false, version: 1 });
    assert.equal((await post("任务")).status, 409);
    await s.save({ enabled: true, version: 2 });
    for (const field of ["enabled=false", "revoked_at=now()"]) {
      await s.database.pool.query(`UPDATE repositories SET ${field} WHERE id=$1`, [s.repoId]);
      assert([403, 409].includes((await post("任务")).status));
      await s.database.pool.query("UPDATE repositories SET enabled=true,revoked_at=NULL WHERE id=$1", [s.repoId]);
    }
    s.config.allowedRepositories.clear();
    assert.equal((await post("任务")).status, 403);
    s.config.allowedRepositories.add(s.repository);
    s.denyMaintainer();
    permissionTime += 5 * 60_000;
    assert.equal((await post("任务", await s.headers("Maintainer"))).status, 403);
  } finally {
    await s.cleanup();
  }
});

test("pi-dev 标签验签后查 GitHub 写权限；并发、重复投递及重复标签不重复入队", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    await s.save();
    for (const payload of [
      s.label({ action: "opened" }),
      s.label({ label: { name: "other" } }),
      s.label({ sender: { type: "Bot", login: "bot" } }),
      s.label({ issue: { ...s.label().issue, pull_request: {} } }),
    ])
      assert.equal((await s.webhook(payload)).status, 200);
    assert.deepEqual(s.permissionChecks, []);
    const delivery = randomUUID();
    s.config.queueCapacity = 0;
    assert.equal((await s.webhook(s.label(), delivery)).status, 503);
    s.config.queueCapacity = 100;
    const responses = await Promise.all([s.webhook(s.label(), delivery), s.webhook(s.label(), delivery), s.webhook()]);
    const results = (await Promise.all(responses.map((r) => r.json()))) as any[];
    assert.equal(results.filter((r) => r.accepted).length, 1);
    assert.equal(results.filter((r) => r.duplicate).length, 2);
    const [task] = await s.store.list(s.repoId);
    assert.equal(task.prompt_summary, "修复导出");
    assert.equal(task.source, "issue_label");
    assert.equal(task.issue_number, 123);
    const row = (await s.database.pool.query("SELECT * FROM development_tasks WHERE id=$1", [task.id])).rows[0];
    assert.equal(row.role, "developer");
    assert.equal(row.requester_login, "author");
    assert.equal(row.bot_id, null);
    assert.equal(row.notification_status, "skipped");
    assert.equal((await s.store.issueOrigin(row))?.prompt, "修复导出\n\n完整保留日期筛选");
    const issue = (await s.database.pool.query("SELECT * FROM development_issues WHERE repository_id=$1", [s.repoId]))
      .rows[0];
    assert.equal(issue.status, "developing");
    assert.equal(issue.origin_task_id, row.id);
    await s.store.setIssueStatus(row, "discussing");
    for (const status of ["queued", "running", "publishing"]) {
      await s.database.pool.query("UPDATE development_tasks SET status=$2 WHERE id=$1", [row.id, status]);
      assert.equal(((await (await s.webhook()).json()) as any).duplicate, true, `${status} 任务阻止再次入队`);
    }
    await s.store.setIssueStatus(row, "developing");
    await s.database.pool.query("UPDATE development_tasks SET status='failed' WHERE id=$1", [row.id]);
    assert.equal(((await (await s.webhook()).json()) as any).duplicate, true, "developing 状态阻止再派任务");
    await s.store.setIssueStatus(row, "discussing");
    assert.equal(
      ((await (await s.webhook(s.label(), delivery)).json()) as any).duplicate,
      true,
      "结束后重投仍按 delivery 去重",
    );
    const again = (await (await s.webhook()).json()) as any;
    assert.equal(again.accepted, true, "没有活动任务且回到讨论后允许重新打标签");
    assert.notEqual(again.taskId, row.id);
    s.denyWrite();
    assert.equal((await s.webhook(s.label({ issue: { ...s.label().issue, number: 456 } }))).status, 200);
    assert.equal((await s.store.list(s.repoId)).length, 2);
  } finally {
    await s.cleanup();
  }
});

test("标签来源只接受已启用、未撤销、白名单内且安装一致的仓库", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    assert.equal((await s.webhook()).status, 200, "尚无开发设置");
    await s.save({ enabled: false });
    assert.equal((await s.webhook()).status, 200);
    await s.save({ version: 1 });
    for (const field of ["enabled=false", "revoked_at=now()"]) {
      await s.database.pool.query(`UPDATE repositories SET ${field} WHERE id=$1`, [s.repoId]);
      assert.equal((await s.webhook()).status, 200);
      await s.database.pool.query("UPDATE repositories SET enabled=true,revoked_at=NULL WHERE id=$1", [s.repoId]);
    }
    s.config.allowedRepositories.clear();
    assert.equal((await s.webhook()).status, 200);
    s.config.allowedRepositories.add(s.repository);
    assert.equal((await s.webhook(s.label({ installation: { id: 2 } }))).status, 200);
    assert.equal((await s.store.list(s.repoId)).length, 0);
  } finally {
    await s.cleanup();
  }
});

test("无企微来源的 issue 直接认原 GitHub 发起人开始；讨论、PR 评论仍去重且不发群通知", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    await s.save();
    await s.webhook();
    const origin = (await s.database.pool.query("SELECT * FROM development_tasks WHERE repository_id=$1", [s.repoId]))
      .rows[0];
    await s.database.pool.query("UPDATE development_tasks SET status='discussing' WHERE id=$1", [origin.id]);
    await s.store.setIssueStatus(origin, "discussing");
    const comment = { repositoryId: s.repoId, issueNumber: 123, commentId: 81, login: "other", body: "开始" };
    assert.equal((await s.store.acceptIssueComment(comment, s.config)).taskKind, "notice");
    assert.equal((await s.store.acceptIssueComment(comment, s.config)).kind, "duplicate");
    assert.equal(
      (await s.store.acceptIssueComment({ ...comment, commentId: 82, body: "需要什么格式？" }, s.config)).taskKind,
      "discuss",
    );
    assert.equal(
      (await s.store.acceptIssueComment({ ...comment, commentId: 83, login: "AUTHOR" }, s.config)).taskKind,
      "develop",
    );
    const tasks = await s.store.list(s.repoId);
    assert(tasks.every((t) => t.notification_status === "skipped"));
    assert.equal(tasks.find((t) => t.kind === "discuss").requester_login, "other");
    await s.database.pool.query("UPDATE development_tasks SET status='succeeded',pr_number=42 WHERE id=$1", [
      origin.id,
    ]);
    const pr = {
      repositoryId: s.repoId,
      prNumber: 42,
      source: "comment" as const,
      commentId: 91,
      login: "collaborator",
      body: "调整颜色",
    };
    assert.equal((await s.store.acceptPullRequestComment(pr, s.config)).taskKind, "revise");
    assert.equal((await s.store.acceptPullRequestComment(pr, s.config)).kind, "duplicate");
    const revision = (await s.store.list(s.repoId)).find((t) => t.kind === "revise");
    assert.equal(revision.source, "pr_comment");
    assert.equal(revision.requester_login, "collaborator");
    assert.equal(revision.notification_status, "skipped");
  } finally {
    await s.cleanup();
  }
});

test("016 增量迁移回填历史来源，保留群任务和原评论去重约束", { skip: !fixture.url }, async () => {
  const schema = `source_upgrade_${randomUUID().replaceAll("-", "")}`;
  const control = new Database(fixture.url!);
  await control.pool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(fixture.url!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const database = new Database(url.toString());
  const directory = await mkdtemp(resolve("work/source-migrations-"));
  try {
    for (const file of await readdir("migrations"))
      if (/^\d+.*\.sql$/.test(file) && file < "016") await copyFile(resolve("migrations", file), join(directory, file));
    await database.migrate(directory);
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES(1,1,'o/r')");
    const messages = ["group-message", "issue-comment:1", "pr-comment:2", "pr-review_comment:3", "pr-review:4"];
    for (const message of messages) {
      const id = randomUUID();
      await database.pool.query(
        `INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,settings_version,role,prompt,status)
        VALUES($1,'bot',$2,'group','alice',1,1,'o/r','main',$3,1,'developer','需求','succeeded')`,
        [id, message, `bot/development/${id}`],
      );
    }
    await copyFile(resolve("migrations/016_development_sources.sql"), join(directory, "016_development_sources.sql"));
    await database.migrate(directory);
    const rows = (await database.pool.query("SELECT message_id,source,requester_login,bot_id FROM development_tasks"))
      .rows;
    assert.deepEqual(
      messages.map((message) => rows.find((r) => r.message_id === message).source),
      ["wecom", "issue", "pr_comment", "pr_comment", "pr_comment"],
    );
    assert(rows.every((row) => row.bot_id === "bot" && row.requester_login === null));
    await assert.rejects(
      database.pool.query(
        `INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,settings_version,role,prompt,status)
      VALUES($1,'bot','group-message','group','alice',1,1,'o/r','main',$2,1,'developer','重复','queued')`,
        [randomUUID(), `bot/development/${randomUUID()}`],
      ),
      (error: any) => error.code === "23505",
    );
    await database.migrate(directory);
    assert.equal((await database.pool.query("SELECT count(*)::int n FROM development_tasks")).rows[0].n, 5);
  } finally {
    await database.close();
    await control.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});
