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
import { collectChanges, repositoryFiles } from "../../src/development/changes.js";
import { emptyUsage, ProviderError, type runAgentSession } from "../../src/review/agent.js";
import { gitEnv } from "../../src/workspace/workspace.js";
import type { Config } from "../../src/config/config.js";
import type { DevelopmentSettings } from "../../src/development/types.js";
import { createApp } from "../../src/github/webhook/handler.js";

const answer = (refusal = "") => JSON.stringify({ title: "fix: 修复常量", summary: "修复常量", refusal });

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
    development: { botId, secret: "unused", budgetTokens: 160000, timeoutMs: 5000 },
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
      {
        messageId,
        replyRequestId: `request-${messageId}`,
        receivedAt: new Date(),
        chatId: settings.chatId,
        requester: user,
        text: "修改代码",
        images: [],
      },
      config,
    );
    return (await store.claim(botId))!;
  };
  // 模拟 Pi 进程：经扩展桥读文件、申请写入，再直接改工作区里的文件；写入被拒绝时仍写入，模拟用 bash 绕过。
  const agent =
    (path = "src/normal.ts", before?: () => Promise<void>): typeof runAgentSession =>
    async (input) => {
      await input.bridge!.read!(path, false);
      await before?.();
      const decision = await input.bridge!.write!(path, "edit");
      await writeFile(join(input.root, path), "export const value = 2;\n");
      if (decision.allow) await input.bridge!.written!(path);
      const usage = { ...emptyUsage(), input: 100, output: 50, totalTokens: 150 };
      await input.onUsage?.(usage);
      return { text: answer(), usage, durationMs: 10, model: "test" };
    };
  // 同一个 setup 里的任务共用工作区，每次开始前回到快照。
  const reset = () => {
    git("checkout", "--quiet", "--", ".");
    git("clean", "-fdq");
  };
  const process = (model = agent()) =>
    createDevelopmentProcessor(
      config,
      store,
      github,
      model,
      async (_url, _token, _base, _head, run) => {
        reset();
        return run(root);
      },
      1,
    );
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
    const input = {
      messageId: "once",
      replyRequestId: "request-once",
      receivedAt: new Date(),
      chatId: s.settings.chatId,
      requester: "developer",
      text: "修改",
      images: [],
    };
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
      const prompt = input.prompt as any;
      assert.deepEqual(
        prompt.globalTeamRules.map((r: any) => [r.ref, r.title, r.content]),
        [["R1", "账务精度", "金额使用最小货币单位"]],
      );
      assert.deepEqual(prompt.teamRuleIndex, []);
      return s.agent()(input);
    };
    await s.process(model)(task, new AbortController().signal);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "succeeded");
    assert.equal(row.pr_number, 42);
    assert.equal(row.requester, "developer");
    assert.equal(row.usage.totalTokens, 150);
    assert.equal(row.rule_snapshot[0].id, ruleId);
    assert.equal(row.rule_snapshot[0].version, 2);
    assert.deepEqual(row.rule_snapshot[0].delivered, { via: "prompt" });
    assert.deepEqual(row.images, []);
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
    assert.equal(row.base_sha, s.sha);
    assert.equal(row.target_branch, "dev");
    assert.match(row.branch, /^bot\/development\//);
  } finally {
    await s.cleanup();
  }
});
test("按路径规则读写到文件才附加，命令新建的文件补发一次；补发后仍有遗漏则不发布", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    for (const [title, content, scope] of [
      ["常量命名", "常量使用 camelCase", { paths: ["src/normal.ts"] }],
      ["账务目录", "金额使用最小货币单位", { paths: ["src/billing/**"] }],
      ["文档日期", "文档名带日期", { paths: ["docs/**"] }],
    ] as const)
      await s.database.pool.query(
        `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,confidence,status,source_fingerprint)
        VALUES($1,1,$2,1,'engineering_rule',$3,$4,'团队约定',$5,'{"pullRequestNumber":1}',1,'ACTIVE',$6)`,
        [randomUUID(), s.repoId, title, content, JSON.stringify(scope), randomUUID()],
      );
    const file = async (root: string, path: string, content: string) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    };
    // late：补发之后再用命令新建的文件。
    const model =
      (late?: string): typeof runAgentSession =>
      async (input) => {
        const prompt = input.prompt as any;
        assert.deepEqual(prompt.globalTeamRules, []);
        const titles = prompt.teamRuleIndex.map((r: any) => r.title);
        for (const title of ["常量命名", "文档日期", "账务目录"]) assert(titles.includes(title));
        const read = (await input.bridge!.read!("src/normal.ts", false)).rules ?? "";
        assert(read.startsWith(prompt.teamRuleMarker));
        assert(read.includes("常量使用 camelCase") && !read.includes("金额使用最小货币单位"));
        assert.equal((await input.bridge!.write!("src/normal.ts", "edit")).allow, true);
        await file(input.root, "src/normal.ts", "export const value = 2;\n");
        assert.equal((await input.bridge!.written!("src/normal.ts")).rules, undefined, "同一条规则只给一次");
        assert.equal((await input.bridge!.write!("src/billing/fee.ts", "write")).allow, true);
        await file(input.root, "src/billing/fee.ts", "export const fee = 1;\n");
        assert.match((await input.bridge!.written!("src/billing/fee.ts")).rules ?? "", /金额使用最小货币单位/);
        // 用命令新建，不经过写入工具。
        await file(input.root, "docs/guide.md", "# 指南\n");
        const message = await input.followUp!(answer());
        assert(message !== undefined && message.startsWith(prompt.teamRuleMarker));
        assert(message.includes("文档名带日期") && !message.includes("金额使用最小货币单位"));
        if (late) await file(input.root, late, "late\n");
        assert.equal(await input.followUp!(answer()), undefined);
        const usage = { ...emptyUsage(), input: 100, output: 50, totalTokens: 150 };
        return { text: answer(), usage, durationMs: 10, model: "test" };
      };
    const task = await s.enqueue();
    await s.process(model())(task, new AbortController().signal);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "succeeded");
    const delivered = Object.fromEntries(row.rule_snapshot.map((r: any) => [r.title, r.delivered]));
    assert.deepEqual(delivered, {
      常量命名: { via: "read", path: "src/normal.ts" },
      账务目录: { via: "write", path: "src/billing/fee.ts" },
      文档日期: { via: "follow_up", path: "docs/guide.md" },
    });
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);

    await s.database.pool.query(
      `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,confidence,status,source_fingerprint)
      VALUES($1,1,$2,1,'engineering_rule','脚本目录','脚本要可重复执行','团队约定','{"paths":["scripts/**"]}','{"pullRequestNumber":1}',1,'ACTIVE',$3)`,
      [randomUUID(), s.repoId, randomUUID()],
    );
    const missed = await s.enqueue();
    await s.process(model("scripts/run.sh"))(missed, new AbortController().signal);
    const failed = await s.getTask(missed.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.result, /尚未提供给模型的团队规则.*脚本目录/);
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
  } finally {
    await s.cleanup();
  }
});
test("写入前检查：保护范围、覆盖前先读、含打码凭据的文件只能局部编辑", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    const model: typeof runAgentSession = async (input) => {
      const write = input.bridge!.write!;
      assert.match((await write("src/protected.ts", "edit")).reason ?? "", /保护规则「核心代码」/);
      assert.match((await write("src/normal.ts", "write")).reason ?? "", /先用 read/);
      assert.equal((await write("src/normal.ts", "edit")).allow, true);
      assert.equal((await write("src/brand-new.ts", "write")).allow, true);
      await input.bridge!.read!("src/normal.ts", true);
      assert.match((await write("src/normal.ts", "write")).reason ?? "", /打码/);
      assert.equal((await write("src/normal.ts", "edit")).allow, true);
      return { text: answer("只测试写入检查"), usage: emptyUsage(), durationMs: 1, model: "test" };
    };
    await s.process(model)(task, new AbortController().signal);
    assert.equal((await s.getTask(task.id)).status, "refused");
  } finally {
    await s.cleanup();
  }
});
test("模型服务临时故障时整个任务重试，用量累加；确定性错误和次数用尽不再重试", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const failing = (message: string): Error =>
      Object.assign(new ProviderError(message), { usage: { ...emptyUsage(), input: 40, output: 0, totalTokens: 40 } });
    const flaky = (failures: number, message = "Upstream request failed") => {
      let calls = 0;
      const model: typeof runAgentSession = async (input) => {
        calls++;
        if (calls <= failures) {
          // 失败前已经写了文件：重试必须从干净的工作区重新开始。
          await writeFile(join(input.root, "src/half-done.ts"), "partial\n");
          throw failing(message);
        }
        return s.agent()(input);
      };
      return { model, calls: () => calls };
    };
    const retried = flaky(1);
    const task = await s.enqueue();
    await s.process(retried.model)(task, new AbortController().signal);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "succeeded");
    assert.equal(retried.calls(), 2);
    assert.equal(row.usage.totalTokens, 190, "失败那次的 40 加上成功那次的 150");
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);

    const permanent = flaky(1, "401 invalid api key");
    const denied = await s.enqueue();
    await s.process(permanent.model)(denied, new AbortController().signal);
    assert.equal((await s.getTask(denied.id)).status, "failed");
    assert.equal(permanent.calls(), 1);

    const exhausted = flaky(5);
    const tired = await s.enqueue();
    await s.process(exhausted.model)(tired, new AbortController().signal);
    assert.equal((await s.getTask(tired.id)).status, "failed");
    assert.equal(exhausted.calls(), 3);
    assert.equal((await s.getTask(tired.id)).usage.totalTokens, 120);
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
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
test("从工作区收集最终改动：认 Agent 自己的提交，忽略 .gitignore 与 .codegraph，拒绝链接、冲突和打码占位符", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  const git = (...args: string[]) => execFileSync("git", ["-C", s.root, ...args], { env: gitEnv(), encoding: "utf8" });
  const reset = () => {
    git("reset", "--quiet", "--hard", s.sha);
    git("clean", "-fdqx");
  };
  try {
    const signal = new AbortController().signal,
      files = await repositoryFiles(s.root, s.sha, signal),
      collect = () => collectChanges(s.root, s.sha, files, signal);
    await assert.rejects(collect(), /实际变化/);

    await rm(join(s.root, "src/normal.ts"));
    await writeFile(join(s.root, "src/new.ts"), "new\n");
    git("add", "-A");
    git("-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "--quiet", "-m", "agent");
    await writeFile(join(s.root, "src/after.ts"), "after\n", { mode: 0o755 });
    await mkdir(join(s.root, ".codegraph"));
    await writeFile(join(s.root, ".codegraph/codegraph.db"), "db");
    await writeFile(join(s.root, ".git/info/exclude"), "tmp/\n");
    await mkdir(join(s.root, "tmp"));
    await writeFile(join(s.root, "tmp/build.log"), "log");
    const changes = (await collect()).map(({ path, content, mode }) => [path, content, mode]);
    assert.deepEqual(changes, [
      ["src/normal.ts", null, "100644"],
      ["src/after.ts", "after\n", "100755"],
      ["src/new.ts", "new\n", "100644"],
    ]);

    for (const [prepare, message] of [
      [() => symlink("/etc/hosts", join(s.root, "src/link")), /不能新建符号链接/],
      [() => rm(join(s.root, "outside")), /符号链接/],
      [
        async () => {
          await rm(join(s.root, "src/normal.ts"));
          await mkdir(join(s.root, "src/normal.ts"));
          await writeFile(join(s.root, "src/normal.ts/child"), "x");
        },
        /不能把文件改成符号链接或目录/,
      ],
      [() => writeFile(join(s.root, "src/normal.ts"), "export const value = '[已隐藏的密钥]';\n"), /打码/],
      [() => writeFile(join(s.root, "src/big.ts"), "x".repeat(200_001)), /过大/],
      [() => writeFile(join(s.root, "src/bad[1].ts"), "x"), /路径无效/],
    ] as const) {
      reset();
      await prepare();
      await assert.rejects(collect(), message);
    }
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

test("智能机器人完成结果引用原消息，无成员提及；重复消息不重复执行", { skip: !fixture.url }, async (t) => {
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
    await waitFor(async () => replies.length === 2, 10000);
    assert.equal(executions, 1);
    assert.equal(messages.length, 0);
    assert.equal(replies[0][0].headers.req_id, "request");
    assert.equal(replies[1][0].headers.req_id, "request");
    assert.notEqual(replies[0][1], replies[1][1]);
    assert.equal(replies[1][3], true);
    assert.match(replies[1][2], /^\*\*AI 开发任务已完成/);
    assert.match(replies[1][2], /pull\/55/);
    assert(!replies[1][2].includes("<@"));
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

test("重启后使用持久化回调引用结果；超期、缺少上下文或改绑不发送，未知回执不重发", {
  skip: !fixture.url,
}, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { waitFor } = await import("../helpers/database.js");
  t.mock.method(WSClient.prototype, "connect", function (this: InstanceType<typeof WSClient>) {
    this.emit("authenticated");
    return this;
  });
  t.mock.method(WSClient.prototype, "disconnect", () => undefined);
  const replies: any[] = [];
  let loseAck = false;
  t.mock.method(WSClient.prototype, "replyStream", async (...args: any[]) => {
    replies.push(args);
    if (loseAck) throw new Error("connection lost after send");
    return { headers: { req_id: "ack" }, errcode: 0 };
  });
  t.mock.method(WSClient.prototype, "sendMessage", async () => {
    throw new Error("must not fall back to unquoted message");
  });
  for (const mode of ["saved", "expired", "missing", "rebound", "unknown"]) {
    const s = await setup();
    const task = await s.enqueue();
    await s.store.checkpoint(task, { title: "完成", prNumber: 99 });
    await s.store.finish(task, "succeeded", "完成");
    if (mode === "expired")
      await s.database.pool.query(
        "UPDATE development_tasks SET reply_expires_at=now()-interval '1 second' WHERE id=$1",
        [task.id],
      );
    if (mode === "missing")
      await s.database.pool.query("UPDATE development_tasks SET reply_req_id=NULL WHERE id=$1", [task.id]);
    if (mode === "rebound")
      await s.store.saveSettings(s.repoId, { ...s.settings, chatId: `moved-${s.repoId}`, version: 1 }, "maintainer");
    loseAck = mode === "unknown";
    const before = replies.length;
    let worker = new DevelopmentWorker(s.config, s.store, s.github as any);
    try {
      worker.start();
      await waitFor(async () =>
        ["sent", "failed", "uncertain"].includes((await s.getTask(task.id)).notification_status),
      );
      await worker.stop();
      const row = await s.getTask(task.id);
      if (mode === "saved") {
        assert.equal(row.notification_status, "sent");
        assert.equal(replies.at(-1)[0].headers.req_id, `request-${task.message_id}`);
        assert.match(replies.at(-1)[2], /pull\/99/);
        assert.equal(replies.length, before + 1);
      } else if (mode === "unknown") {
        assert.equal(row.notification_status, "uncertain");
        assert.equal(replies.length, before + 1);
        worker = new DevelopmentWorker(s.config, s.store, s.github as any);
        worker.start();
        await waitFor(
          async () =>
            (
              await s.database.pool.query(
                "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=4897041 AND objid=hashtext($1)::oid",
                [s.botId],
              )
            ).rowCount === 1,
        );
        await worker.stop();
        assert.equal(replies.length, before + 1);
      } else {
        assert.equal(row.notification_status, "failed");
        assert.equal(replies.length, before);
        assert.equal(
          row.notification_error,
          {
            expired: "reply_window_expired",
            missing: "reply_context_missing",
            rebound: "repository_or_binding_changed",
          }[mode],
        );
      }
    } finally {
      await worker.stop();
      await s.cleanup();
    }
  }
});

test("开发进行中审查通知仍从同一智能机器人连接直接发绑定群", { skip: !fixture.url }, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { ReviewPublicationRepository } = await import(
    "../../src/persistence/repositories/review-publication.repository.js"
  );
  const { reviewNotificationChannel } = await import("../../src/notifications/wecom.js");
  const { waitFor } = await import("../helpers/database.js");
  const s = await setup();
  let bot: InstanceType<typeof WSClient> | undefined;
  let connections = 0,
    processing = false;
  let complete!: () => void;
  const blocked = new Promise<void>((r) => {
    complete = r;
  });
  const messages: any[] = [];
  t.mock.method(WSClient.prototype, "connect", function (this: InstanceType<typeof WSClient>) {
    connections++;
    bot = this;
    this.emit("authenticated");
    return this;
  });
  t.mock.method(WSClient.prototype, "disconnect", () => undefined);
  t.mock.method(WSClient.prototype, "replyStream", async () => ({ headers: { req_id: "ack" }, errcode: 0 }));
  t.mock.method(WSClient.prototype, "sendMessage", async (...args: any[]) => {
    assert(processing);
    messages.push(args);
    return { headers: { req_id: "sent" }, errcode: 0 };
  });
  const github = {
    ...s.github,
    getPullRequest: async () => ({ title: "人工 PR", state: "open", draft: false, head: { sha: "review-head" } }),
  };
  const worker = new DevelopmentWorker(s.config, s.store, github as any, async (task) => {
    processing = true;
    await blocked;
    processing = false;
    await s.store.finish(task, "refused", "测试结束");
  });
  try {
    worker.start();
    await waitFor(async () => Boolean(bot));
    bot!.emit("message", {
      headers: { req_id: "dev-request" },
      body: {
        aibotid: s.botId,
        msgid: "dev-message",
        chatid: s.settings.chatId,
        chattype: "group",
        from: { userid: "developer" },
        msgtype: "text",
        text: { content: "开发任务" },
      },
    });
    await waitFor(async () => processing);
    const { job } = await s.database.accept(
      {
        deliveryId: randomUUID(),
        installationId: 1,
        repositoryId: s.repoId,
        repository: s.repository,
        cloneUrl: `https://github.com/${s.repository}.git`,
        prNumber: 101,
        title: "人工 PR",
        body: "",
        baseSha: s.sha,
        headSha: "review-head",
      },
      { event: "pull_request", action: "opened" },
    );
    assert(job);
    job.reviewId = 55;
    job.reviewUrl = `https://github.com/${s.repository}/pull/101#pullrequestreview-55`;
    await s.database.beginPublication(job, randomUUID());
    await new ReviewPublicationRepository(s.database.pool).finishPublication(
      job,
      "published",
      reviewNotificationChannel(s.botId),
    );
    await waitFor(async () => messages.length === 1, 10000);
    assert.equal(connections, 1);
    assert.equal(messages[0][0], s.settings.chatId);
    assert.equal(messages[0][1].chat_type, 2);
    assert.match(messages[0][1].markdown.content, /AI 审查已完成/);
    assert(!messages[0][1].markdown.content.includes("<@"));
    await waitFor(
      async () =>
        (await s.database.pool.query("SELECT status FROM review_notifications WHERE job_id=$1", [job.id])).rows[0]
          ?.status === "sent",
    );
  } finally {
    complete();
    await worker.stop();
    await s.cleanup();
  }
});
