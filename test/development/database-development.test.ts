import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Database } from "../../src/persistence/database.js";
import { useTestDatabase } from "../helpers/database.js";
import { DevelopmentStore } from "../../src/development/store.js";
import { createDevelopmentProcessor } from "../../src/development/processor.js";
import { repositoryFiles, validateChanges } from "../../src/development/changes.js";
import { emptyUsage, type runAgentSession } from "../../src/review/agent.js";
import { gitEnv } from "../../src/workspace/workspace.js";
import type { Config } from "../../src/config/config.js";
import type { DevelopmentSettings } from "../../src/development/types.js";
import { createApp } from "../../src/github/webhook/handler.js";

// biome-ignore lint/correctness/useHookAtTopLevel: 这是 node:test 数据库生命周期辅助函数，不是 React Hook。
const fixture = useTestDatabase();
let nextRepo = 8_000_001;
async function setup() {
  const database = new Database(fixture.url!);
  const store = new DevelopmentStore(database.pool);
  const repoId = nextRepo++,
    repository = `owner/dev-${repoId}`,
    botId = `bot-${repoId}`;
  await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
    repoId,
    repository,
  ]);
  const settings: DevelopmentSettings = {
    chatId: `group-${repoId}`,
    targetBranch: "dev",
    enabled: true,
    version: 0,
    members: [
      { userid: "admin", role: "admin" },
      { userid: "developer", role: "developer" },
    ],
    protections: [{ name: "核心代码", paths: ["src/protected.ts"], reason: "由管理员维护" }],
  };
  await store.saveSettings(repoId, settings, "maintainer");
  const config = {
    allowedRepositories: new Set([repository]),
    queueCapacity: 10,
    agentTimeoutMs: 5000,
    webhookSecret: "secret",
    webhookMaxBytes: 100000,
    modelName: "test",
    modelProvider: "test",
    modelApiKey: "test",
    development: { botId, secret: "unused", budgetTokens: 160000 },
  } as Config;
  const root = await mkdtemp(resolve("work/development-test-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/normal.ts"), "export const value = 1;\n");
  await writeFile(join(root, "src/protected.ts"), "export const secret = 1;\n");
  await symlink("/etc/passwd", join(root, "outside"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { env: gitEnv(), encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "baseline");
  const sha = git("rev-parse", "HEAD"),
    head = "c".repeat(40);
  const calls: string[] = [];
  const github = {
    installationToken: async () => "token",
    developmentSnapshot: async () => ({ sha, tree: "b".repeat(40) }),
    createDevelopmentCommit: async (..._args: unknown[]) => {
      calls.push("commit");
      return head;
    },
    createDevelopmentBranch: async () => {
      calls.push("branch");
    },
    createDevelopmentPullRequest: async () => {
      calls.push("pr");
      return { number: 42, head: { sha: head } };
    },
    findDevelopmentPullRequest: async () => [] as any[],
  };
  const enqueue = async (user = "developer", messageId = randomUUID()) => {
    await store.accept(
      botId,
      { messageId, chatId: settings.chatId, requester: user, text: "修改代码", images: [] },
      config,
    );
    return (await store.claim(botId))!;
  };
  const agent =
    (path = "src/normal.ts", before?: () => Promise<void>): typeof runAgentSession =>
    async (input) => {
      await input
        .tools!.find((t) => t.name === "read_file")!
        .execute("read", { path } as never, undefined, undefined, undefined as never);
      await before?.();
      const usage = { ...emptyUsage(), input: 100, output: 50, totalTokens: 150 };
      await input.onUsage?.(usage);
      return {
        text: JSON.stringify({
          title: "修复",
          summary: "修复常量",
          changes: [{ path, content: "export const value = 2;\n" }],
          refusal: "",
        }),
        usage,
        durationMs: 10,
        model: "test",
      };
    };
  const process = (model = agent()) =>
    createDevelopmentProcessor(config, store, github, model, async (_url, _token, _base, _head, run) => run(root));
  const getTask = async (id: string) =>
    (await database.pool.query("SELECT * FROM development_tasks WHERE id=$1", [id])).rows[0];
  return {
    database,
    store,
    repoId,
    repository,
    botId,
    settings,
    config,
    root,
    sha,
    head,
    calls,
    github,
    enqueue,
    agent,
    process,
    getTask,
    cleanup: async () => {
      await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repoId]);
      await database.pool.query("DELETE FROM memories WHERE repository_id=$1", [repoId]);
      await database.pool.query("DELETE FROM repositories WHERE id=$1", [repoId]);
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("群绑定唯一、设置版本与审计、消息去重、身份拒绝和跨实例互斥", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const input = { messageId: "once", chatId: s.settings.chatId, requester: "developer", text: "修改", images: [] };
    const results = await Promise.all([
      s.store.accept(s.botId, input, s.config),
      s.store.accept(s.botId, input, s.config),
    ]);
    assert.deepEqual(results.sort(), ["accepted", "duplicate"]);
    await assert.rejects(
      s.store.accept(s.botId, { ...input, messageId: "unknown", requester: "stranger" }, s.config),
      /不能发起/,
    );
    await assert.rejects(s.store.saveSettings(s.repoId, s.settings, "maintainer"), /刷新/);
    const audit = await s.database.pool.query("SELECT actor FROM development_settings_audits WHERE repository_id=$1", [
      s.repoId,
    ]);
    assert.equal(audit.rows[0].actor, "maintainer");
    const other = s.repoId + 10000;
    await s.database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'other/r')", [
      other,
    ]);
    await assert.rejects(s.store.saveSettings(other, s.settings, "maintainer"), /已经绑定/);
    await s.database.pool.query("DELETE FROM repositories WHERE id=$1", [other]);
    let second = false;
    await s.store.withLeader(s.botId, async () => {
      await s.store.withLeader(s.botId, async () => {
        second = true;
      });
    });
    assert.equal(second, false);
  } finally {
    await s.cleanup();
  }
});
test("开发正常修改并提 PR；图片和团队规则传入模型；任务发起者被保留", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const ruleId = randomUUID();
    await s.database.pool.query(
      `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,confidence,status,source_fingerprint)
      VALUES($1,2,$2,1,'engineering_rule','账务精度','金额使用最小货币单位','避免舍入误差','{}','{"pullRequestNumber":1}',1,'ACTIVE',$3),
      ($4,1,$2,1,'engineering_rule','候选','候选不能参与开发','未确认','{}','{"pullRequestNumber":2}',1,'CANDIDATE',$5)`,
      [ruleId, s.repoId, randomUUID(), randomUUID(), randomUUID()],
    );
    const task = await s.enqueue();
    task.images = [{ type: "image", data: "cGljdHVyZQ==", mimeType: "image/png" }];
    const model: typeof runAgentSession = async (input) => {
      assert.equal(input.images?.length, 1);
      assert.equal((input.prompt as any).role, "developer");
      const rules = (input.prompt as { activeTeamRules: Array<{ id: string; version: number; content: string }> })
        .activeTeamRules;
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, ruleId);
      assert.equal(rules[0].version, 2);
      assert.equal(rules[0].content, "金额使用最小货币单位");
      return s.agent()(input);
    };
    await s.process(model)(task, new AbortController().signal);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "succeeded");
    assert.equal(row.pr_number, 42);
    assert.equal(row.requester, "developer");
    assert.equal(row.usage.totalTokens, 150);
    assert.equal(row.rule_snapshot[0].id, ruleId);
    assert.deepEqual(row.images, []);
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
    assert.equal(row.base_sha, s.sha);
    assert.equal(row.target_branch, "dev");
    assert.match(row.branch, /^bot\/development\//);
  } finally {
    await s.cleanup();
  }
});
test("开发命中保护整项拒绝，管理员成功且保护规则保持有效", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const dev = await s.enqueue();
    await s.process(s.agent("src/protected.ts"))(dev, new AbortController().signal);
    assert.equal((await s.getTask(dev.id)).status, "refused");
    assert.deepEqual(s.calls, []);
    const admin = await s.enqueue("admin");
    await s.process(s.agent("src/protected.ts"))(admin, new AbortController().signal);
    assert.equal((await s.getTask(admin.id)).status, "succeeded");
    assert.deepEqual((await s.store.settings(s.repoId))?.protections, s.settings.protections);
  } finally {
    await s.cleanup();
  }
});
test("任务执行期间身份或保护设置变更、目标分支推进均阻止发布", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    await s.process(
      s.agent("src/normal.ts", async () => {
        const settings = (await s.store.settings(s.repoId))!;
        await s.store.saveSettings(
          s.repoId,
          { ...settings, members: [{ userid: "admin", role: "admin" }] },
          "maintainer",
        );
      }),
    )(task, new AbortController().signal);
    assert.equal((await s.getTask(task.id)).status, "cancelled");
    assert.deepEqual(s.calls, []);
    const admin = await s.enqueue("admin");
    let reads = 0;
    s.github.developmentSnapshot = async () => ({ sha: ++reads === 1 ? s.sha : "d".repeat(40), tree: "b".repeat(40) });
    await s.process()(admin, new AbortController().signal);
    assert.equal((await s.getTask(admin.id)).status, "cancelled");
    assert.deepEqual(s.calls, []);
  } finally {
    await s.cleanup();
  }
});
test("PR 回调先于创建响应仍免审查；后续新提交也免审查，伪造分支不能绕过", { skip: !fixture.url }, async () => {
  const s = await setup();
  const { server } = createApp(s.config, s.database);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  try {
    const task = await s.enqueue();
    s.github.createDevelopmentPullRequest = async () => {
      const payload = {
        action: "opened",
        installation: { id: 1 },
        repository: { id: s.repoId, full_name: s.repository },
        pull_request: {
          number: 42,
          title: "PR",
          body: null,
          draft: false,
          state: "open",
          base: { sha: s.sha },
          head: { sha: s.head, ref: task.branch, repo: { full_name: s.repository } },
        },
      };
      const body = JSON.stringify(payload),
        signature = "sha256=" + createHmac("sha256", s.config.webhookSecret).update(body).digest("hex");
      const response = await fetch(`http://127.0.0.1:${addr.port}/github/webhook`, {
        method: "POST",
        body,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": signature,
        },
      });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as any).reason, "development_pull_request");
      return { number: 42, head: { sha: s.head } };
    };
    await s.process()(task, new AbortController().signal);
    assert.equal(await s.database.isDevelopmentPullRequest(s.repoId, 42, task.branch, "e".repeat(40)), true);
    assert.equal(await s.database.isDevelopmentPullRequest(s.repoId, 43, "bot/development/fake", s.head), false);
    assert.equal((await s.database.pool.query("SELECT 1 FROM jobs WHERE repository_id=$1", [s.repoId])).rowCount, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await s.cleanup();
  }
});
test("PR 创建响应丢失仅只读核对，不重复创建；不可核对保留 uncertain", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    s.github.createDevelopmentPullRequest = async () => {
      s.calls.push("pr");
      throw new Error("timeout");
    };
    s.github.findDevelopmentPullRequest = async () => [
      { number: 42, head: { sha: s.head, ref: task.branch, repo: { full_name: s.repository } }, base: { ref: "dev" } },
    ];
    await s.process()(task, new AbortController().signal);
    assert.equal((await s.getTask(task.id)).status, "succeeded");
    assert.equal(s.calls.filter((x) => x === "pr").length, 1);
    const uncertain = await s.enqueue();
    s.github.findDevelopmentPullRequest = async () => [];
    await s.process()(uncertain, new AbortController().signal);
    assert.equal((await s.getTask(uncertain.id)).status, "uncertain");
    assert.equal(s.calls.filter((x) => x === "pr").length, 2);
  } finally {
    await s.cleanup();
  }
});
test("服务恢复取消未发布任务并隔离旧执行权，发布/发送中断保留 uncertain", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    await s.store.checkpoint(task, { headSha: s.head, publishing: true });
    await s.database.pool.query("UPDATE development_tasks SET notification_status='sending' WHERE id=$1", [task.id]);
    await s.store.recover(s.botId);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "uncertain");
    assert.equal(row.notification_status, "uncertain");
    await assert.rejects(s.store.permission(task, s.config), /取消/);
    await assert.rejects(s.store.checkpoint(task, { prNumber: 123 }), /执行权/);
    await s.store.finish(task, "succeeded", "stale");
    assert.equal((await s.getTask(task.id)).status, "uncertain");
  } finally {
    await s.cleanup();
  }
});
test("最终改动拒绝符号链接、目录别名、空改动；新文件与删除保持正确模式", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const signal = new AbortController().signal,
      files = await repositoryFiles(s.root, signal);
    for (const path of ["outside", "outside/new", "SRC/normal.ts", "src/normal.ts/child"])
      await assert.rejects(validateChanges(s.root, files, [{ path, content: "evil" }], signal));
    await assert.rejects(
      validateChanges(s.root, files, [{ path: "src/normal.ts", content: "export const value = 1;\n" }], signal),
      /实际变化/,
    );
    const changes = await validateChanges(
      s.root,
      files,
      [
        { path: "src/normal.ts", content: null },
        { path: "src/new.ts", content: "new" },
      ],
      signal,
    );
    assert.equal(changes[0].content, null);
    assert.equal(changes[1].mode, "100644");
  } finally {
    await s.cleanup();
  }
});

test("管理 API 必须登录、maintain 权限、CSRF，禁止跨仓库写设置", { skip: !fixture.url }, async () => {
  const { createServer } = await import("node:http");
  const { createAdminHandler } = await import("../../src/admin/handler.js");
  const { memoryStore } = await import("../../src/admin/session-store.js");
  const s = await setup();
  let allowed = true;
  const secret = "preview-session-secret-32-characters",
    sessionId = "session",
    csrf = "csrf";
  const config = {
    ...s.config,
    sessionSecret: secret,
    githubOAuthCallbackUrl: "http://local/auth/github/callback",
    githubClientId: "test",
    githubClientSecret: "test",
  };
  const sessions = memoryStore<any>(60000, 10),
    states = memoryStore<number>(60000, 10);
  await sessions.set(sessionId, { id: 1, login: "maintainer", token: "fake", csrf, expiresAt: Date.now() + 60000 });
  const handler = createAdminHandler(
    config,
    s.database,
    { ...s.github, hasMaintainerPermission: async () => allowed } as any,
    { sessions, states },
  );
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/repositories/${s.repoId}/development`;
  const cookie = `session=${sessionId}.${createHmac("sha256", secret).update(sessionId).digest("base64url")}`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { cookie } })).status, 200);
    assert.equal(
      (await fetch(url, { method: "PUT", headers: { cookie }, body: JSON.stringify({ ...s.settings, version: 1 }) }))
        .status,
      403,
    );
    const headers = { cookie, origin: "http://local", "x-csrf-token": csrf };
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...s.settings, version: 1, repositoryId: 123 }),
        })
      ).status,
      422,
    );
    allowed = false;
    assert.equal((await fetch(url, { headers: { cookie } })).status, 403);
    assert.equal(
      (await fetch(url, { method: "PUT", headers, body: JSON.stringify({ ...s.settings, version: 1 }) })).status,
      403,
    );
    allowed = true;
    assert.equal(
      (await fetch(url, { method: "PUT", headers, body: JSON.stringify({ ...s.settings, version: 1 }) })).status,
      200,
    );
    assert.equal((await s.store.settings(s.repoId))?.version, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await s.cleanup();
  }
});

test("智能机器人群消息经接收、持久任务到原群 @提出者通知；重复消息不重复执行", { skip: !fixture.url }, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { waitFor } = await import("../helpers/database.js");
  const s = await setup();
  let bot: InstanceType<typeof WSClient> | undefined,
    executions = 0;
  const replies: any[] = [],
    messages: any[] = [];
  t.mock.method(WSClient.prototype, "connect", function (this: InstanceType<typeof WSClient>) {
    bot = this;
    this.emit("authenticated");
    return this;
  });
  t.mock.method(WSClient.prototype, "disconnect", () => undefined);
  t.mock.method(WSClient.prototype, "replyStream", async (...args: any[]) => {
    replies.push(args);
    return { headers: { req_id: "ack" }, errcode: 0 };
  });
  t.mock.method(WSClient.prototype, "sendMessage", async (...args: any[]) => {
    messages.push(args);
    return { headers: { req_id: "sent" }, errcode: 0 };
  });
  const worker = new DevelopmentWorker(s.config, s.store, s.github as any, async (task) => {
    executions++;
    await s.store.checkpoint(task, { title: "修复问题", prNumber: 55 });
    await s.store.finish(task, "succeeded", "已完成");
  });
  try {
    worker.start();
    await waitFor(async () => Boolean(bot));
    const frame = {
      headers: { req_id: "request" },
      body: {
        aibotid: s.botId,
        msgid: "message",
        chatid: s.settings.chatId,
        chattype: "group" as const,
        from: { userid: "developer" },
        msgtype: "text",
        text: { content: "修复按钮" },
      },
    };
    bot!.emit("message", frame);
    await waitFor(async () => replies.length === 1);
    bot!.emit("message", frame);
    await waitFor(async () => messages.length === 1, 10000);
    assert.equal(executions, 1);
    assert.equal(replies.length, 1);
    assert.equal(messages[0][0], s.settings.chatId);
    assert.match(messages[0][1].markdown.content, /^<@developer>\n\n\*\*AI 开发任务已完成/);
    assert.match(messages[0][1].markdown.content, /pull\/55/);
    await waitFor(
      async () =>
        (await s.database.pool.query("SELECT notification_status FROM development_tasks WHERE bot_id=$1", [s.botId]))
          .rows[0]?.notification_status === "sent",
    );
  } finally {
    await worker.stop();
    await s.cleanup();
  }
});
