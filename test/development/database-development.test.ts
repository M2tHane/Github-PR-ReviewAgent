import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { DevelopmentSideEffects } from "../../src/development/side-effects.js";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PersistentRunner, TaskLeaseLostError } from "../../src/jobs/runner.js";
import { Database } from "../../src/persistence/database.js";
import { useTestDatabase, waitFor } from "../helpers/database.js";
import { DevelopmentStore, developmentSource } from "../../src/development/store.js";
import { pullRequestThread } from "../../src/development/revisions.js";
import { snapshotRecorder } from "../../src/development/snapshots.js";
import { createDevelopmentProcessor } from "../../src/development/processor.js";
import { applySnapshot, collectChanges, collectSnapshot, repositoryFiles } from "../../src/development/changes.js";
import { emptyUsage, ProviderError, type runAgentSession } from "../../src/review/agent.js";
import { gitEnv } from "../../src/workspace/workspace.js";
import type { Config } from "../../src/config/config.js";
import type { DevelopmentSettings, DevelopmentTask } from "../../src/development/types.js";
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
    botId = `bot-${repoId}-${randomUUID()}`;
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
    development: {
      wecom: { botId, secret: "unused" },
      cacheDir: "work/dev-cache",
      budgetTokens: 160000,
      timeoutMs: 5000,
      concurrency: 2,
    },
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
  // issue 替身：记下开的 issue、发的评论和 PR 正文；thread 是 GitHub 上已有的评论。
  const issues: Array<{ title: string; body: string }> = [],
    issueComments: Array<{ number: number; body: string }> = [],
    prBodies: string[] = [],
    thread: Array<{ id: number; body: string; created_at: string; user: { login: string; type: string } }> = [];
  // PR 替身：PR 状态、PR 对话里的评论，以及推送到分支的提交。
  const pull = { state: "open", ref: "" },
    prComments: Array<{ id: number; body: string; created_at: string; user: { login: string; type: string } }> = [],
    pushes: string[] = [];
  const github = {
    installationToken: async () => "token",
    developmentCommitTree: async () => "b".repeat(40),
    findDevelopmentIssue: async (_token: string, _repo: string, marker: string) =>
      issues.find((i) => i.body.includes(marker)) ? { number: 7 } : undefined,
    findDevelopmentComment: async (_token: string, _repo: string, number: number, marker: string) => {
      const i = issueComments.findIndex((c) => c.number === number && c.body.includes(marker));
      return i < 0 ? undefined : { id: i + 1 };
    },
    developmentSnapshot: async () => ({ sha, tree: "b".repeat(40) }),
    createDevelopmentCommit: async (..._args: unknown[]) => {
      calls.push("commit");
      return head;
    },
    createDevelopmentBranch: async () => {
      calls.push("branch");
    },
    createDevelopmentPullRequest: async (_token: string, _repository: string, input: { body: string }) => {
      calls.push("pr");
      prBodies.push(input.body);
      return { number: 42, head: { sha: head } };
    },
    findDevelopmentPullRequest: async () => [] as any[],
    createIssue: async (_token: string, _repository: string, input: { title: string; body: string }) => {
      issues.push(input);
      return { number: 7 };
    },
    createIssueComment: async (_token: string, _repository: string, number: number, body: string) => {
      issueComments.push({ number, body });
      return { id: issueComments.length };
    },
    getIssue: async (_token: string, _repository: string, number: number) => ({
      number,
      title: issues[0]?.title ?? "issue",
      body: issues[0]?.body ?? "",
      state: "open",
    }),
    listIssueComments: async () => thread,
    getPullRequest: async (_token: string, _repository: string, number: number) => ({
      number,
      title: "fix: 修复常量",
      body: prBodies.at(-1) ?? "",
      state: pull.state,
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      base: { sha },
      head: { sha: head, ref: pull.ref },
      user: { id: 1, login: "bot" },
    }),
    updateDevelopmentBranch: async (_token: string, _repository: string, branch: string, commit: string) => {
      calls.push("push");
      pushes.push(`${branch}@${commit}`);
    },
    getConversationComments: async () => prComments.map((c) => ({ ...c, html_url: "", user: { id: 2, ...c.user } })),
    getReviewComments: async () => [],
    getReviews: async () => [],
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
    return (await store.claim())!;
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
  let workspaceCount = 0;
  const process = (model = agent()) =>
    createDevelopmentProcessor(
      config,
      store,
      github,
      model,
      async (_url, _token, _base, _head, run) => {
        workspaceCount++;
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
    issues,
    issueComments,
    prBodies,
    thread,
    pull,
    prComments,
    pushes,
    enqueue,
    agent,
    process,
    getTask,
    workspaceCount: () => workspaceCount,
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
        // 每次尝试结束时交出执行记录。
        await input.onSession?.({
          id: randomUUID(),
          status: calls <= failures ? "failed" : "succeeded",
          startedAt: new Date(),
          durationMs: 5,
          steps: 0,
          bytes: 0,
          truncated: false,
          timings: { models: [], tools: {} },
          content: "",
        });
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
    assert.deepEqual(
      (await s.store.list(s.repoId))
        .find((item) => item.id === task.id)
        .agent_sessions.map((item: any) => [item.role, item.attempt, item.status]),
      [
        ["developer", 1, "failed"],
        ["developer", 2, "succeeded"],
      ],
      "每次尝试各有一份执行记录",
    );
    // 服务步骤和 Agent 会话写在同一份记录里：第一次失败在 Agent 阶段，第二次走完全部步骤。
    const attempts = (
      await s.database.pool.query(
        "SELECT attempt,status,error,events FROM agent_sessions WHERE development_task_id=$1 ORDER BY attempt",
        [task.id],
      )
    ).rows;
    assert.deepEqual(Object.keys(attempts[0].events).sort(), ["snapshot", "workspace"]);
    assert.match(attempts[0].error, /模型服务临时故障，0\.001 秒后重试：.*Upstream request failed/);
    assert.deepEqual(Object.keys(attempts[1].events).sort(), [
      "branch",
      "changes",
      "check",
      "commit",
      "pr",
      "workspace",
    ]);
    assert(
      Object.values(attempts[1].events as Record<string, { ok: boolean; durationMs: number }>).every(
        (event) => event.ok && event.durationMs >= 0,
      ),
    );
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
test("身份或保护设置变更阻止发布；目标分支推进仍以原基线创建 PR", { skip: !fixture.url }, async () => {
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
    let targetSha = s.sha;
    s.github.developmentSnapshot = async () => {
      reads++;
      return { sha: targetSha, tree: "b".repeat(40) };
    };
    s.github.createDevelopmentCommit = async (...args: unknown[]) => {
      assert.equal((args[2] as { sha: string }).sha, s.sha, "提交的父提交仍为任务开始的基线");
      assert.notEqual(targetSha, s.sha, "分析期间目标分支已有新提交");
      s.calls.push("commit");
      return s.head;
    };
    await s.process(
      s.agent("src/normal.ts", async () => {
        targetSha = "d".repeat(40);
      }),
    )(admin, new AbortController().signal);
    assert.equal((await s.getTask(admin.id)).status, "succeeded");
    assert.equal(reads, 1, "发布前不再读取目标分支");
    assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
  } finally {
    await s.cleanup();
  }
});
test("PR 回调先于创建响应仍免审查；后续新提交也免审查，伪造分支不能绕过", { skip: !fixture.url }, async () => {
  const s = await setup();
  const { server } = createApp(s.config, s.database);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  let callback: Promise<void> | undefined;
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
      callback = fetch(`http://127.0.0.1:${addr.port}/github/webhook`, {
        method: "POST",
        body,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": signature,
        },
      }).then(async (response) => {
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as any).reason, "development_pull_request");
      });
      // 回调已到，但它绑定 PR 号的 UPDATE 会等待创建请求释放任务锁；GitHub 不等 Webhook 响应。
      await waitFor(async () =>
        Boolean(
          (
            await s.database.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE development_tasks SET pr_number=$2%' AND wait_event_type='Lock'",
            )
          ).rowCount,
        ),
      );
      return { number: 42, head: { sha: s.head } };
    };
    await s.process()(task, new AbortController().signal);
    await callback;
    assert.equal(await s.database.isDevelopmentPullRequest(s.repoId, 42, task.branch, "e".repeat(40)), true);
    assert.equal(await s.database.isDevelopmentPullRequest(s.repoId, 43, "bot/development/fake", s.head), false);
    assert.equal((await s.database.pool.query("SELECT 1 FROM jobs WHERE repository_id=$1", [s.repoId])).rowCount, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await s.cleanup();
  }
});
test("PR 创建响应丢失仅只读核对，不重复创建；不可核对时由执行器重排", { skip: !fixture.url }, async () => {
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
    await assert.rejects(s.process()(uncertain, new AbortController().signal), /timeout/);
    await s.store.fail(uncertain);
    assert.equal((await s.getTask(uncertain.id)).status, "queued");
    assert.equal(s.calls.filter((x) => x === "pr").length, 2);
  } finally {
    await s.cleanup();
  }
});
test("发布租约过期隔离旧执行权，发布中断重新领取，发送中断保留 uncertain", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    await s.store.checkpoint(task, { headSha: s.head, publishing: true });
    await s.database.pool.query("UPDATE development_tasks SET notification_status='sending' WHERE id=$1", [task.id]);
    await s.database.pool.query("UPDATE development_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [
      task.id,
    ]);
    await s.store.claim();
    await s.store.recover(s.botId);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "running");
    assert.equal(row.attempt, 2);
    assert.equal(row.notification_status, "uncertain");
    await assert.rejects(s.store.permission(task, s.config), /取消/);
    await assert.rejects(s.store.checkpoint(task, { prNumber: 123 }), /执行权/);
    await s.store.finish(task, "succeeded", "stale");
    assert.equal((await s.getTask(task.id)).status, "running");
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

test("管理 API 必须登录、maintain 权限、CSRF，禁止跨仓库写设置", { skip: !fixture.url }, async (t) => {
  const { createServer } = await import("node:http");
  const { createAdminHandler } = await import("../../src/admin/handler.js");
  const { memoryStore } = await import("../../src/admin/session-store.js");
  const s = await setup();
  let permissionTime = Date.now();
  t.mock.method(Date, "now", () => permissionTime);
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
  const sessions = memoryStore<any>(3_600_000, 10),
    states = memoryStore<number>(60000, 10);
  await sessions.set(sessionId, { id: 1, login: "maintainer", token: "fake", csrf, expiresAt: Date.now() + 3_600_000 });
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
    permissionTime += 5 * 60_000;
    assert.equal((await fetch(url, { headers: { cookie } })).status, 403);
    assert.equal(
      (await fetch(url, { method: "PUT", headers, body: JSON.stringify({ ...s.settings, version: 1 }) })).status,
      403,
    );
    allowed = true;
    permissionTime += 60_000;
    config.development.wecom = undefined;
    const view = (await (await fetch(url, { headers: { cookie } })).json()) as any;
    assert.equal(view.configured, true, "开发设置不依赖企微");
    assert.equal(view.wecomConfigured, false, "单独返回群连接配置状态");
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
  const worker = withExecution(new DevelopmentWorker(s.config, s.store, s.github as any), s.store, async (task) => {
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

test("企微未认证时执行器照常领取开发任务，认证后 Worker 发送完成通知", { skip: !fixture.url }, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { waitFor } = await import("../helpers/database.js");
  const s = await setup();
  let bot: InstanceType<typeof WSClient> | undefined;
  let executions = 0;
  const replies: any[] = [];
  t.mock.method(WSClient.prototype, "connect", function (this: InstanceType<typeof WSClient>) {
    bot = this;
    return this;
  });
  t.mock.method(WSClient.prototype, "disconnect", () => undefined);
  t.mock.method(WSClient.prototype, "replyStream", async (...args: any[]) => {
    replies.push(args);
    return { headers: { req_id: "ack" }, errcode: 0 };
  });
  const accepted = await s.store.accept(
    s.botId,
    {
      messageId: "unauthenticated-task",
      replyRequestId: "request-unauthenticated-task",
      receivedAt: new Date(),
      chatId: s.settings.chatId,
      requester: "developer",
      text: "修改代码",
      images: [],
    },
    s.config,
  );
  assert.equal(accepted, "accepted");
  const queued = (
    await s.database.pool.query("SELECT * FROM development_tasks WHERE bot_id=$1 AND message_id=$2", [
      s.botId,
      "unauthenticated-task",
    ])
  ).rows[0];
  const worker = withExecution(new DevelopmentWorker(s.config, s.store, s.github as any), s.store, async (task) => {
    executions++;
    await s.store.checkpoint(task, { title: "完成", prNumber: 42 });
    await s.store.finish(task, "succeeded", "已完成");
  });
  try {
    worker.start();
    await waitFor(async () => Boolean(bot));
    await waitFor(async () => executions === 1 && (await s.getTask(queued.id)).status === "succeeded");
    const beforeAuthentication = await s.getTask(queued.id);
    assert.equal(beforeAuthentication.notification_status, "pending");
    assert.equal(replies.length, 0);

    bot!.emit("authenticated");
    await waitFor(async () => (await s.getTask(queued.id)).notification_status === "sent", 10_000);
    assert.equal(replies.length, 1);
    assert.equal(replies[0][0].headers.req_id, "request-unauthenticated-task");
    assert.match(replies[0][2], /^\*\*AI 开发任务已完成/);
  } finally {
    await worker.stop();
    await s.cleanup();
  }
});

test("多个项目并行开发，同一项目按发送顺序排队；确认消息带排队位置", { skip: !fixture.url }, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { waitFor } = await import("../helpers/database.js");
  const s = await setup();
  // 第二个项目绑定另一个群，由同一个智能机器人处理。
  const other = s.repoId + 500,
    otherName = `owner/dev-${other}`;
  await s.database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,$2)", [
    other,
    otherName,
  ]);
  await s.store.saveSettings(other, { ...s.settings, chatId: `group-${other}` }, "maintainer");
  s.config.allowedRepositories.add(otherName);
  let bot: InstanceType<typeof WSClient> | undefined;
  const replies: any[] = [];
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
  // 任务一直做到测试放行，记录同时在做的任务。
  const running = new Map<string, () => void>(),
    started: string[] = [];
  let peak = 0;
  const worker = withExecution(new DevelopmentWorker(s.config, s.store, s.github as any), s.store, async (task) => {
    started.push(task.prompt);
    await new Promise<void>((resolve) => running.set(task.prompt, resolve));
    running.delete(task.prompt);
    await s.store.finish(task, "succeeded", "已完成");
  });
  const send = (id: string, chatId: string) =>
    bot!.emit("message", {
      headers: { req_id: `request-${id}` },
      body: {
        aibotid: s.botId,
        msgid: id,
        chatid: chatId,
        chattype: "group" as const,
        from: { userid: "developer" },
        msgtype: "text",
        text: { content: id },
      },
    });
  const acks = () =>
    replies.filter((reply) => reply[0].headers?.req_id?.startsWith("request-") && !reply[1].startsWith("result-"));
  try {
    worker.start();
    await waitFor(async () => Boolean(bot));
    send("A1", s.settings.chatId);
    await waitFor(async () => acks().length === 1);
    send("A2", s.settings.chatId);
    await waitFor(async () => acks().length === 2);
    send("B1", `group-${other}`);
    await waitFor(async () => acks().length === 3);
    assert.deepEqual(
      acks().map((reply) => reply[2]),
      ["已收到开发任务。", "已收到开发任务，前面还有 1 个同项目的任务，会按顺序开发。", "已收到开发任务。"],
    );
    await waitFor(async () => started.length === 2, 10_000);
    peak = Math.max(peak, running.size);
    assert.deepEqual([...started].sort(), ["A1", "B1"], "不同项目同时开始，A2 等 A1");
    running.get("A1")!();
    await waitFor(async () => started.length === 3, 10_000);
    assert.equal(started.at(-1), "A2", "同一项目的下一个任务在前一个结束后开始");
    assert.equal(peak, 2);
    running.get("B1")!();
    running.get("A2")!();
    await waitFor(
      async () =>
        (
          await s.database.pool.query(
            "SELECT count(*)::int n FROM development_tasks WHERE bot_id=$1 AND notification_status='sent'",
            [s.botId],
          )
        ).rows[0].n === 3,
      15_000,
    );
  } finally {
    for (const release of running.values()) release();
    await worker.stop();
    await s.database.pool.query("DELETE FROM repositories WHERE id=$1", [other]);
    await s.cleanup();
  }
});

test("同时收到多条消息时依次入队，不再要求稍后重发", { skip: !fixture.url }, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { waitFor } = await import("../helpers/database.js");
  const s = await setup();
  let bot: InstanceType<typeof WSClient> | undefined;
  const replies: any[] = [];
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
  const worker = withExecution(new DevelopmentWorker(s.config, s.store, s.github as any), s.store, async (task) => {
    await s.store.finish(task, "succeeded", "已完成");
  });
  try {
    worker.start();
    await waitFor(async () => Boolean(bot));
    for (const id of ["m1", "m2", "m3", "m4"])
      bot!.emit("message", {
        headers: { req_id: `request-${id}` },
        body: {
          aibotid: s.botId,
          msgid: id,
          chatid: s.settings.chatId,
          chattype: "group" as const,
          from: { userid: "developer" },
          msgtype: "text",
          text: { content: id },
        },
      });
    await waitFor(
      async () =>
        (await s.database.pool.query("SELECT count(*)::int n FROM development_tasks WHERE bot_id=$1", [s.botId]))
          .rows[0].n === 4,
      20_000,
    );
    assert(!replies.some((reply) => String(reply[2]).includes("太多")));
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
  const worker = withExecution(new DevelopmentWorker(s.config, s.store, github as any), s.store, async (task) => {
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

// ---------- 需求 issue ----------
const issueAnswer = JSON.stringify({
  title: "",
  summary: "",
  refusal: "",
  issue: {
    title: "订单导出加上限",
    body: "**要做的事**：导出加条数上限。\n\n**需要你确认**：\n1. 上限多少？我倾向 1 万。",
  },
});
// 一个替身同时扮演开发和讨论：讨论只读（没有 write 工具），回一句话；开发时按 answers 依次作答。
function issueAgent(
  s: Awaited<ReturnType<typeof setup>>,
  answers: string[],
  prompts: any[] = [],
): typeof runAgentSession {
  const develop = s.agent();
  return async (input) => {
    prompts.push(input.prompt);
    const usage = { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 };
    if (!input.builtinTools?.includes("write"))
      return {
        text: JSON.stringify({ reply: "上限按 1 万做，超出时报错。没问题请回复“开始”。" }),
        usage,
        durationMs: 1,
        model: "test",
      };
    const next = answers.shift() ?? answer();
    if (next !== answer()) {
      await writeFile(join(input.root, "src/normal.ts"), "export const value = 3;\n");
      return { text: next, usage, durationMs: 1, model: "test" };
    }
    return develop(input);
  };
}
const comment = (s: Awaited<ReturnType<typeof setup>>, id: number, login: string, body: string) =>
  s.store.acceptIssueComment({ repositoryId: s.repoId, issueNumber: 7, commentId: id, login, body }, s.config);

test("需求不清楚时开 issue、不提交改动；群里回复带 issue 链接和“开始”的说明", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    await s.process(issueAgent(s, [issueAnswer]))(task, new AbortController().signal);
    const saved = await s.getTask(task.id);
    assert.equal(saved.status, "discussing");
    assert.equal(saved.issue_number, 7);
    assert.equal(saved.title, "订单导出加上限");
    assert.deepEqual(s.calls, [], "不提交、不建分支和 PR");
    assert.equal(s.issues[0]!.title, "订单导出加上限");
    assert.match(
      s.issues[0]!.body,
      /需要你确认[\s\S]*---\n有异议的回复编号说明，没提到的按推荐做。确认后请提需求的人回复“开始”。（提需求的人还没有关联 GitHub 账号/,
    );
    const issue = (
      await s.database.pool.query("SELECT status,origin_task_id FROM development_issues WHERE repository_id=$1", [
        s.repoId,
      ])
    ).rows[0];
    assert.deepEqual(issue, { status: "discussing", origin_task_id: task.id });
    assert.equal(saved.notification_status, "pending", "开 issue 的结果照常回复群里");
  } finally {
    await s.cleanup();
  }
});

test("issue 讨论：评论排讨论回复，只有提需求的人说“开始”才开发；PR 关闭 issue 并贴回链接", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    const prompts: any[] = [];
    // 同一个替身：第一次开发时开 issue，之后开发正常改代码。
    const model = issueAgent(s, [issueAnswer], prompts);
    const run = (task: any) => s.process(model)(task, new AbortController().signal);
    const origin = await s.enqueue();
    await run(origin);
    await s.database.pool.query(
      "INSERT INTO repository_notification_members(repository_id,github_login,wecom_userid) VALUES($1,'alice','developer')",
      [s.repoId],
    );
    // 普通评论：排讨论回复；重投的同一条评论不重复排。
    assert.deepEqual(await comment(s, 101, "bob", "上限多少合适？"), { kind: "accepted", taskKind: "discuss" });
    assert.deepEqual(await comment(s, 101, "bob", "上限多少合适？"), { kind: "duplicate" });
    s.thread.push({
      id: 101,
      body: "上限多少合适？",
      created_at: new Date().toISOString(),
      user: { login: "bob", type: "User" },
    });
    const discussion = (await s.store.claim())!;
    assert.equal(discussion.kind, "discuss");
    await run(discussion);
    assert.equal((await s.getTask(discussion.id)).status, "succeeded");
    assert.equal((await s.getTask(discussion.id)).notification_status, "skipped", "讨论回复不发群");
    assert.deepEqual(s.issueComments.at(-1), {
      number: 7,
      body: `上限按 1 万做，超出时报错。没问题请回复“开始”。\n\n<!-- pi-dev:${discussion.id}:discussion -->`,
    });
    assert.equal(prompts.at(-1).originalRequest, "修改代码");
    assert.equal(prompts.at(-1).issue.comments[0].author, "bob");
    assert.deepEqual(prompts.at(-1).requesterLogins, ["alice"]);
    // 别人说“开始”不算数，回一条提示。
    assert.deepEqual(await comment(s, 102, "bob", "开始"), { kind: "accepted", taskKind: "notice" });
    const notice = (await s.store.claim())!;
    await run(notice);
    assert.equal(
      s.issueComments.at(-1)!.body,
      `只有提需求的 @alice 回复“开始”才会开工。\n\n<!-- pi-dev:${notice.id}:notice -->`,
    );
    // 讨论里顺口提到“开始”不算指令。
    assert.equal((await comment(s, 103, "Alice", "那就开始吧，上限 1 万")).taskKind, "discuss");
    await s.database.pool.query("DELETE FROM development_tasks WHERE message_id='issue-comment:103'");
    // 提需求的人（GitHub 账号不区分大小写）说“开始”：排开发任务，issue 进入开发中；这期间的评论回提示。
    assert.deepEqual(await comment(s, 104, "Alice", "开始！"), { kind: "accepted", taskKind: "develop" });
    assert.equal((await comment(s, 105, "bob", "再加个导出日志")).taskKind, "notice");
    const develop = (await s.store.claim())!;
    assert.equal(develop.kind, "develop");
    assert.equal(develop.issue_number, 7);
    await run(develop);
    const done = await s.getTask(develop.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.pr_number, 42);
    assert.equal(done.notification_status, "pending", "开发结果照常通知群里");
    assert.match(s.prBodies.at(-1)!, /\n\nCloses #7$/);
    assert.deepEqual(s.issueComments.at(-1), {
      number: 7,
      body: `PR 建好了：#42\n\n<!-- pi-dev:${develop.id}:issue-pr -->`,
    });
    const opened = await s.getTask(origin.id);
    assert.deepEqual(
      [opened.status, opened.result],
      ["succeeded", "issue #7 讨论后已建 PR #42。"],
      "开 issue 的任务不再显示讨论中",
    );
    assert.equal(prompts.at(-1).task, "修改代码");
    assert.equal(prompts.at(-1).issue.title, "订单导出加上限");
    // PR 建好后 issue 不再处理新评论。
    assert.deepEqual(await comment(s, 106, "alice", "开始"), { kind: "ignored" });
  } finally {
    await s.cleanup();
  }
});

test("issue 里开始后仍有没定的地方：把问题贴成评论、回到讨论中；开发失败也贴回原因", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    await s.process(issueAgent(s, [issueAnswer]))(await s.enqueue(), new AbortController().signal);
    await s.database.pool.query(
      "INSERT INTO repository_notification_members(repository_id,github_login,wecom_userid) VALUES($1,'alice','developer')",
      [s.repoId],
    );
    await comment(s, 201, "alice", "开始");
    const again = (await s.store.claim())!;
    await s.process(issueAgent(s, [issueAnswer]))(again, new AbortController().signal);
    assert.equal((await s.getTask(again.id)).status, "discussing");
    assert.equal(s.issues.length, 1, "不再开新 issue");
    assert.match(s.issueComments.at(-1)!.body, /需要你确认/);
    assert.deepEqual(s.calls, []);
    const status = async () =>
      (await s.database.pool.query("SELECT status FROM development_issues WHERE repository_id=$1", [s.repoId])).rows[0]
        .status;
    assert.equal(await status(), "discussing");
    // 命中保护规则被拒绝：原因贴回 issue，可以调整后再说“开始”。
    await comment(s, 202, "alice", "开始");
    const refused = (await s.store.claim())!;
    await s.process(s.agent("src/protected.ts"))(refused, new AbortController().signal);
    assert.equal((await s.getTask(refused.id)).status, "refused");
    assert.match(
      s.issueComments.at(-1)!.body,
      /^这次没有建 PR：已拒绝整个任务[\s\S]*再回复“开始”。\n\n<!-- pi-dev:[^:]+:issue-failure -->$/,
    );
    assert.equal(await status(), "discussing");
  } finally {
    await s.cleanup();
  }
});

test("领取：issue 讨论不等同项目的开发任务，同一个 issue 的讨论一次一条，后面还有新评论时合并回复", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    await s.process(issueAgent(s, [issueAnswer]))(await s.enqueue(), new AbortController().signal);
    const developing = await s.enqueue();
    assert.equal(developing.kind, "develop");
    await comment(s, 301, "bob", "第一条");
    await comment(s, 302, "bob", "第二条");
    const first = (await s.store.claim())!;
    assert.equal(first.kind, "discuss", "同项目有开发任务在跑，讨论照样领取");
    assert.equal(await s.store.claim(), undefined, "同一个 issue 的讨论不并行");
    await s.process(issueAgent(s, []))(first, new AbortController().signal);
    const merged = await s.getTask(first.id);
    assert.equal(merged.status, "cancelled");
    assert.match(merged.result, /合并到下一条/);
    // 没有关联开发任务的遗留 issue 状态恢复到讨论中。
    await s.database.pool.query("UPDATE development_issues SET status='developing' WHERE repository_id=$1", [s.repoId]);
    await s.store.claim();
    assert.equal(
      (await s.database.pool.query("SELECT status FROM development_issues WHERE repository_id=$1", [s.repoId])).rows[0]
        .status,
      "discussing",
    );
  } finally {
    await s.cleanup();
  }
});

test("issue 里开始的任务没有群消息可引用：结果直接发到绑定群；讨论回复不发群", { skip: !fixture.url }, async (t) => {
  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const { DevelopmentWorker } = await import("../../src/development/worker.js");
  const { waitFor } = await import("../helpers/database.js");
  const s = await setup();
  let bot: InstanceType<typeof WSClient> | undefined;
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
    return { errcode: 0 };
  });
  t.mock.method(WSClient.prototype, "sendMessage", async (...args: any[]) => {
    messages.push(args);
    return { errcode: 0 };
  });
  // 先走一遍开 issue，再由提需求的人说“开始”，并排一条讨论回复。
  await s.process(issueAgent(s, [issueAnswer]))(await s.enqueue(), new AbortController().signal);
  await s.database.pool.query("UPDATE development_tasks SET notification_status='sent' WHERE repository_id=$1", [
    s.repoId,
  ]);
  await s.database.pool.query(
    "INSERT INTO repository_notification_members(repository_id,github_login,wecom_userid) VALUES($1,'alice','developer')",
    [s.repoId],
  );
  await comment(s, 401, "bob", "补充一下");
  await comment(s, 402, "alice", "开始");
  const worker = withExecution(new DevelopmentWorker(s.config, s.store, s.github as any), s.store, async (task) => {
    if (task.kind === "develop") await s.store.checkpoint(task, { title: "feat: 导出加上限", prNumber: 56 });
    await s.store.finish(task, "succeeded", "已完成");
  });
  try {
    worker.start();
    await waitFor(async () => messages.length === 1, 10000);
    assert.equal(messages[0][0], s.settings.chatId);
    assert.equal(messages[0][1].chat_type, 2);
    assert.match(messages[0][1].markdown.content, /^\*\*AI 开发任务已完成[\s\S]*来自 \[issue #7\]/);
    assert.equal(replies.length, 0);
    await waitFor(
      async () =>
        (
          await s.database.pool.query(
            "SELECT count(*)::int n FROM development_tasks WHERE repository_id=$1 AND notification_status='skipped' AND status='succeeded'",
            [s.repoId],
          )
        ).rows[0].n === 1,
    );
  } finally {
    await worker.stop();
    await s.cleanup();
  }
});

// 开发 PR 下的一条评论（替身同时记到 GitHub 的评论列表里，处理时能读到）。
const prComment = async (s: Awaited<ReturnType<typeof setup>>, id: number, login: string, body: string) => {
  if (!s.prComments.some((c) => c.id === id))
    s.prComments.push({ id, body, created_at: new Date().toISOString(), user: { login, type: "User" } });
  return s.store.acceptPullRequestComment(
    { repositoryId: s.repoId, prNumber: 42, source: "comment", commentId: id, login, body },
    s.config,
  );
};
// 处理 PR 评论的模型替身：change 时改文件，其余只回复。
const revisionAgent =
  (result: object, prompts: any[] = [], path = "src/normal.ts"): typeof runAgentSession =>
  async (input) => {
    prompts.push(input.prompt);
    if ((result as { action: string }).action === "change") {
      await input.bridge!.read!(path, false);
      const decision = await input.bridge!.write!(path, "edit");
      await writeFile(join(input.root, path), "export const value = 3;\n");
      if (decision.allow) await input.bridge!.written!(path);
    }
    const usage = { ...emptyUsage(), input: 100, output: 20, totalTokens: 120 };
    return { text: JSON.stringify({ reply: "", commitMessage: "", ...result }), usage, durationMs: 10, model: "test" };
  };

test("开发 PR 的评论：改代码推到同一分支并在 PR 回复、通知群；只回答时不推送不通知；重投去重，非开发 PR 忽略", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    const origin = await s.enqueue();
    await s.process()(origin, new AbortController().signal);
    const branch = (await s.getTask(origin.id)).branch;
    s.pull.ref = branch;
    assert.deepEqual(await prComment(s, 201, "carol", "把 value 改成 3"), { kind: "accepted", taskKind: "revise" });
    assert.deepEqual(await prComment(s, 201, "carol", "把 value 改成 3"), { kind: "duplicate" });
    assert.deepEqual(
      await s.store.acceptPullRequestComment(
        { repositoryId: s.repoId, prNumber: 99, source: "comment", commentId: 299, login: "carol", body: "改一下" },
        s.config,
      ),
      { kind: "ignored" },
      "不是开发 PR",
    );
    const revise = (await s.store.claim())!;
    assert.deepEqual(
      [revise.kind, revise.branch, revise.pr_number, revise.role, revise.requester],
      ["revise", branch, 42, "developer", "developer"],
      "评论人不是群成员：按开发身份，通知仍发给原来的群",
    );
    const prompts: any[] = [];
    const reply = "value 改成 3 了，相关测试通过。";
    await s.process(revisionAgent({ action: "change", reply, commitMessage: "fix: value 改为 3" }, prompts))(
      revise,
      new AbortController().signal,
    );
    const changed = await s.getTask(revise.id);
    assert.equal(changed.status, "succeeded", changed.result);
    assert.equal(changed.notification_status, "pending", "改了代码才通知群里");
    assert.equal(changed.title, "fix: value 改为 3");
    assert.deepEqual(s.pushes, [`${branch}@${s.head}`], "推到原来的开发分支");
    assert.deepEqual(s.issueComments.at(-1), {
      number: 42,
      body: `${reply}\n\n提交：${s.head.slice(0, 7)}\n\n<!-- pi-dev:${revise.id}:reply -->`,
    });
    assert.equal(prompts[0].originalRequest, "修改代码");
    assert.deepEqual(
      prompts[0].pullRequest.comments.map((c: any) => [c.author, c.new, c.body]),
      [["carol", true, "把 value 改成 3"]],
    );
    // 只是提问：回答，不推送、不通知；上次处理之前的评论不再算新评论。
    await prComment(s, 202, "carol", "为什么不用常量？");
    const question = (await s.store.claim())!;
    await s.process(revisionAgent({ action: "reply", reply: "项目里同类值都直接写在这里。" }, prompts))(
      question,
      new AbortController().signal,
    );
    const answered = await s.getTask(question.id);
    assert.deepEqual([answered.status, answered.notification_status], ["succeeded", "skipped"]);
    assert.equal(s.pushes.length, 1);
    assert.deepEqual(s.issueComments.at(-1), {
      number: 42,
      body: `项目里同类值都直接写在这里。\n\n<!-- pi-dev:${question.id}:reply -->`,
    });
    assert.deepEqual(
      prompts[1].pullRequest.comments.map((c: any) => c.new),
      [false, true],
    );
  } finally {
    await s.cleanup();
  }
});

test("PR 评论：连发几条只处理最后一条；评论人关联管理员时按管理员身份；PR 关闭后排队的评论取消", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    const origin = await s.enqueue();
    await s.process()(origin, new AbortController().signal);
    s.pull.ref = (await s.getTask(origin.id)).branch;
    await s.database.pool.query(
      "INSERT INTO repository_notification_members(repository_id,github_login,wecom_userid) VALUES($1,'boss','admin')",
      [s.repoId],
    );
    await prComment(s, 301, "carol", "按钮挪到右边");
    await prComment(s, 302, "Boss", "还是放左边吧");
    const first = (await s.store.claim())!;
    await s.process(revisionAgent({ action: "none" }))(first, new AbortController().signal);
    assert.equal((await s.getTask(first.id)).status, "cancelled", "后面还有评论，合并到下一条");
    assert.equal(s.issueComments.length, 0);
    const second = (await s.store.claim())!;
    assert.deepEqual([second.role, second.requester], ["admin", "admin"]);
    await s.process(revisionAgent({ action: "none" }))(second, new AbortController().signal);
    const ignored = await s.getTask(second.id);
    assert.deepEqual([ignored.status, ignored.notification_status], ["succeeded", "skipped"], ignored.result);
    assert.equal(s.issueComments.length, 0, "不需要处理时不回复");
    // PR 合并：排队的评论取消，不再领取。
    await prComment(s, 303, "carol", "再改一下文案");
    await s.store.closePullRequest(s.repoId, 42);
    assert.equal(await s.store.claim(), undefined);
    const closed = (
      await s.database.pool.query(
        "SELECT status,notification_status FROM development_tasks WHERE message_id='pr-comment:303'",
      )
    ).rows[0];
    assert.deepEqual([closed.status, closed.notification_status], ["cancelled", "skipped"]);
  } finally {
    await s.cleanup();
  }
});

// 测试中显式组装企微入口和独立执行器，两者通过数据库交接任务。
function withExecution(
  worker: { start(): void; stop(): Promise<void> },
  store: DevelopmentStore,
  execute: (task: DevelopmentTask, signal: AbortSignal) => Promise<void>,
) {
  const runner = new PersistentRunner(developmentSource(store), execute, 20, { concurrency: 2 });
  return {
    start() {
      void runner.start();
      worker.start();
    },
    async stop() {
      await Promise.all([runner.stop(), worker.stop()]);
    },
  };
}

test("没有企微配置和 Worker 时，执行器领取并完成开发任务", { skip: !fixture.url }, async () => {
  const s = await setup();
  const task = await s.enqueue();
  await s.store.release(task);
  s.config.development.wecom = undefined;
  const runner = new PersistentRunner(developmentSource(s.store), s.process(), 20);
  try {
    await runner.start();
    await waitFor(async () => (await s.getTask(task.id)).status === "succeeded");
    const row = await s.getTask(task.id);
    assert.equal(row.attempt, 1);
    assert.equal(row.pr_number, 42);
    assert.equal(row.notification_status, "pending", "没有企微连接时保留通知供后续发送");
  } finally {
    await runner.stop();
    await s.cleanup();
  }
});

test("实例停心跳后另一个执行器接手，attempt=2，旧实例不能覆盖结果", { skip: !fixture.url }, async () => {
  const s = await setup();
  const task = await s.enqueue();
  await s.store.release(task);
  let firstTask: DevelopmentTask | undefined;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const first = new PersistentRunner(
    developmentSource(s.store),
    async (job) => {
      firstTask = job;
      await paused;
      await assert.rejects(s.store.checkpoint(job, { title: "旧结果" }), /执行权/);
      assert.equal(await s.store.finish(job, "succeeded", "旧结果"), false);
    },
    20,
    { heartbeatMs: 60_000 },
  );
  const second = new PersistentRunner(
    developmentSource(new DevelopmentStore(s.database.pool)),
    async (job) => {
      assert.equal(job.attempt, 2);
      assert.notEqual(job.owner_token, firstTask!.owner_token);
      await s.store.finish(job, "succeeded", "新实例完成");
    },
    20,
  );
  try {
    await first.start();
    await waitFor(async () => Boolean(firstTask));
    await s.database.pool.query("UPDATE development_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [
      task.id,
    ]);
    await second.start();
    await waitFor(async () => (await s.getTask(task.id)).status === "succeeded");
    resume();
    await first.stop();
    assert.equal((await s.getTask(task.id)).result, "新实例完成");
    assert.equal((await s.getTask(task.id)).attempt, 2);
  } finally {
    resume();
    await Promise.all([first.stop(), second.stop()]);
    await s.cleanup();
  }
});

test("第四次租约过期停止重试并恢复 issue；前三次重排仍保持开发中", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const origin = await s.enqueue();
    await s.store.recordIssue(origin, 7);
    await s.store.finish(origin, "discussing", "讨论");
    const task = await s.enqueue();
    await s.store.checkpoint(task, { issueNumber: 7 });
    await s.store.setIssueStatus({ ...task, issue_number: 7 }, "developing");
    for (let expiration = 1; expiration <= 4; expiration++) {
      await s.database.pool.query(
        "UPDATE development_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [task.id],
      );
      const claimed = await s.store.claim();
      if (expiration < 4) assert.equal(claimed!.attempt, expiration + 1);
      else assert.equal(claimed, undefined);
      const issue = (
        await s.database.pool.query("SELECT status FROM development_issues WHERE repository_id=$1", [s.repoId])
      ).rows[0];
      assert.equal(issue.status, expiration < 4 ? "developing" : "discussing");
    }
    const row = await s.getTask(task.id);
    assert.equal(row.status, "failed");
    assert.match(row.result, /多次中断/);
    assert.equal(row.owner_token, null);
  } finally {
    await s.cleanup();
  }
});

test("停止真实开发处理器：收尾后回到 queued，次数不变，无取消结果、通知和 issue 失败评论", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  const origin = await s.enqueue();
  await s.store.recordIssue(origin, 7);
  await s.store.finish(origin, "discussing", "讨论");
  const task = await s.enqueue();
  await s.store.checkpoint(task, { issueNumber: 7 });
  await s.store.setIssueStatus({ ...task, issue_number: 7 }, "developing");
  await s.store.release(task);
  let started = false,
    cleaned = false;
  const runner = new PersistentRunner(
    developmentSource(s.store),
    s.process(async (input) => {
      started = true;
      try {
        await new Promise<void>((_resolve, reject) =>
          input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }),
        );
        throw new Error("不应完成");
      } finally {
        cleaned = true;
      }
    }),
    20,
  );
  try {
    await runner.start();
    await waitFor(async () => started);
    await runner.stop();
    assert.equal(cleaned, true);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 1);
    assert.equal(row.owner_token, null);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.result, null);
    assert.equal(row.notification_status, "pending");
    assert.deepEqual(s.issueComments, []);
    assert.deepEqual(s.calls, []);
    assert.equal((await s.store.claim())!.attempt, 1, "部署后的再次领取不增加次数");
  } finally {
    await runner.stop();
    await s.cleanup();
  }
});

test("心跳续租；管理端取消或改状态导致执行中止，旧执行不能再写结果", { skip: !fixture.url }, async () => {
  for (const status of ["cancelled", "failed"] as const) {
    const s = await setup();
    const completed = await s.enqueue();
    await s.store.finish(completed, "succeeded", "本次执行完成");
    assert.deepEqual(await s.store.renew([completed], 1000), [], "自己已完成的处理器可以继续收尾");
    const task = await s.enqueue();
    await s.store.release(task);
    let started = false,
      aborted = false;
    const runner = new PersistentRunner(
      developmentSource(s.store),
      async (job, signal) => {
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        assert.equal(await s.store.finish(job, "succeeded", "过期结果"), false);
      },
      20,
      { leaseMs: 1000, heartbeatMs: 30 },
    );
    try {
      await runner.start();
      await waitFor(async () => started);
      const expiry = (await s.getTask(task.id)).lease_expires_at.getTime();
      await waitFor(async () => (await s.getTask(task.id)).lease_expires_at.getTime() > expiry);
      await s.database.pool.query(
        "UPDATE development_tasks SET status=$2,result='管理员终止',owner_token=CASE WHEN $2='cancelled' THEN NULL ELSE owner_token END WHERE id=$1",
        [task.id, status],
      );
      await waitFor(async () => aborted);
      assert.equal((await s.getTask(task.id)).status, status);
      assert.equal((await s.getTask(task.id)).result, "管理员终止");
    } finally {
      await runner.stop();
      await s.cleanup();
    }
  }
});

test("跨实例并发领取仍同项目串行，不同项目与 Bot 可并行", { skip: !fixture.url }, async () => {
  const a = await setup(),
    b = await setup();
  try {
    const first = await a.enqueue();
    await a.store.release(first);
    await a.store.accept(
      "other-bot",
      {
        messageId: randomUUID(),
        replyRequestId: "req",
        receivedAt: new Date(),
        chatId: a.settings.chatId,
        requester: "developer",
        text: "第二个任务",
        images: [],
      },
      a.config,
    );
    // b 的入队辅助函数会领取全局队列，先用 accept 保持三条都排队。
    await b.store.accept(
      b.botId,
      {
        messageId: randomUUID(),
        replyRequestId: "req",
        receivedAt: new Date(),
        chatId: b.settings.chatId,
        requester: "developer",
        text: "其他项目",
        images: [],
      },
      b.config,
    );
    const claimed = (
      await Promise.all([a.store.claim(), b.store.claim(), new DevelopmentStore(a.database.pool).claim()])
    ).filter((task) => task !== undefined);
    assert.equal(claimed.length, 2);
    assert.deepEqual(new Set(claimed.map((task) => Number(task.repository_id))), new Set([a.repoId, b.repoId]));
    await a.store.finish(claimed.find((task) => Number(task.repository_id) === a.repoId)!, "succeeded", "完成");
    assert.equal((await b.store.claim())!.bot_id, "other-bot", "领取不依赖连接的 Bot");
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

for (const kind of ["discuss", "revise", "notice"] as const) {
  test(`停止 ${kind} 处理器不会写取消结果或失败评论`, { skip: !fixture.url }, async () => {
    const s = await setup();
    const task = await s.enqueue();
    await s.store.recordIssue(task, 7);
    await s.database.pool.query("UPDATE development_tasks SET kind=$2,issue_number=$3,pr_number=$4 WHERE id=$1", [
      task.id,
      kind,
      kind === "revise" ? null : 7,
      kind === "revise" ? 42 : null,
    ]);
    await s.store.release(task);
    s.pull.ref = task.branch;
    let started = false;
    const wait = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        started = true;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    if (kind === "notice") s.github.installationToken = async (...args: unknown[]) => wait(args[1] as AbortSignal);
    const runner = new PersistentRunner(
      developmentSource(s.store),
      s.process(async (input) => wait(input.signal!)),
      20,
    );
    try {
      await runner.start();
      await waitFor(async () => started);
      await runner.stop();
      const row = await s.getTask(task.id);
      assert.equal(row.status, "queued");
      assert.equal(row.result, null);
      assert.equal(row.attempt, 1);
      assert.equal(row.notification_status, "pending");
      assert.deepEqual(s.issueComments, []);
    } finally {
      await runner.stop();
      await s.cleanup();
    }
  });
}

test("停止发布中的任务放回队列；企微恢复不取消活跃租约", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    await s.store.recover(s.botId);
    assert.equal((await s.getTask(task.id)).status, "running");
    await s.store.checkpoint(task, { publishing: true, headSha: s.head });
    await s.store.release(task);
    const row = await s.getTask(task.id);
    assert.equal(row.status, "queued");
    assert.equal(row.owner_token, null);
    assert.equal(row.attempt, 1);
    assert.equal((await s.store.claim())!.attempt, 1);
  } finally {
    await s.cleanup();
  }
});

test("管理页发起的需求开 issue 后直接标注 GitHub 发起人；标签需求带全文并在 issue 回 PR", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    await s.store.saveSettings(s.repoId, { ...s.settings, chatId: "", members: [], version: 1 }, "maintainer");
    const claimDirect = async (id: string) =>
      (
        await s.database.pool.query(
          "UPDATE development_tasks SET status='running',owner_token=$2,started_at=now(),attempt=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1 RETURNING *",
          [id, randomUUID()],
        )
      ).rows[0];
    const admin = await s.store.acceptAdmin(
      { repositoryId: s.repoId, login: "Maintainer", role: "admin", prompt: "新增日期筛选" },
      s.config,
    );
    const task = await claimDirect(admin.taskId!);
    await s.process(async () => ({
      text: JSON.stringify({ issue: { title: "日期范围", body: "按创建时间筛选？" } }),
      usage: emptyUsage(),
      durationMs: 1,
      model: "test",
    }))(task, new AbortController().signal);
    assert.equal((await s.getTask(task.id)).status, "discussing");
    assert.match(s.issues[0]!.body, /@Maintainer/);
    assert.doesNotMatch(s.issues[0]!.body, /没有关联/);
    assert.equal((await s.getTask(task.id)).notification_status, "skipped");

    s.issues[0] = { title: "导出日期范围", body: "导出必须保留日期筛选。" };
    s.thread.push({
      id: 1,
      body: "按创建日期筛选",
      user: { login: "author", type: "User" },
      created_at: new Date().toISOString(),
    });
    const labeled = await s.store.acceptIssueLabel(
      {
        repositoryId: s.repoId,
        installationId: 1,
        repository: s.repository,
        issueNumber: 23,
        title: s.issues[0].title,
        body: s.issues[0].body,
        login: "author",
        deliveryId: randomUUID(),
      },
      s.config,
    );
    const labelTask = await claimDirect(labeled.taskId!);
    await s.process(async (input) => {
      const prompt = input.prompt as any;
      assert.equal(prompt.task, "导出日期范围\n\n导出必须保留日期筛选。");
      assert.equal(prompt.issue.comments[0].body, "按创建日期筛选");
      return s.agent()(input);
    })(labelTask, new AbortController().signal);
    assert.equal((await s.getTask(labelTask.id)).status, "succeeded");
    assert(s.issueComments.some((c) => c.number === 23 && c.body.includes("#42")));
    assert.match(s.prBodies.at(-1)!, /Closes #23/);
    assert.equal((await s.getTask(labelTask.id)).notification_status, "skipped");
    assert.equal((await s.store.issueOrigin(labelTask))?.status, "done");
  } finally {
    await s.cleanup();
  }
});

test("标签开发失败把原因贴回 issue 并回到讨论，不发送企微通知", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    await s.store.saveSettings(s.repoId, { ...s.settings, chatId: "", members: [], version: 1 }, "maintainer");
    const accepted = await s.store.acceptIssueLabel(
      {
        repositoryId: s.repoId,
        installationId: 1,
        repository: s.repository,
        issueNumber: 29,
        title: "修改核心代码",
        body: "修改受保护文件",
        login: "author",
        deliveryId: randomUUID(),
      },
      s.config,
    );
    const task = (
      await s.database.pool.query(
        "UPDATE development_tasks SET status='running',owner_token=$2,started_at=now(),attempt=1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1 RETURNING *",
        [accepted.taskId, randomUUID()],
      )
    ).rows[0];
    await s.process(s.agent("src/protected.ts"))(task, new AbortController().signal);
    assert.equal((await s.getTask(task.id)).status, "refused");
    assert.equal((await s.store.issueOrigin(task))?.status, "discussing");
    assert(
      s.issueComments.some((c) => c.number === 29 && c.body.includes("这次没有建 PR") && c.body.includes("保护规则")),
    );
    assert.equal((await s.getTask(task.id)).notification_status, "skipped");
    assert.deepEqual(s.calls, []);
  } finally {
    await s.cleanup();
  }
});

test("管理页和 issue 标签派的任务没有企微 Bot，也由执行器领取并完成", { skip: !fixture.url }, async () => {
  const s = await setup();
  s.config.development.wecom = undefined;
  await s.store.saveSettings(s.repoId, { ...s.settings, chatId: "", members: [], version: 1 }, "maintainer");
  const admin = await s.store.acceptAdmin(
    { repositoryId: s.repoId, login: "Maintainer", role: "developer", prompt: "新增日期筛选" },
    s.config,
  );
  const runner = new PersistentRunner(developmentSource(s.store), s.process(), 20);
  try {
    await runner.start();
    await waitFor(async () => (await s.getTask(admin.taskId!)).status === "succeeded");
    const row = await s.getTask(admin.taskId!);
    assert.deepEqual([row.source, row.bot_id, row.attempt, row.notification_status], ["admin", null, 1, "skipped"]);
    assert.equal(row.pr_number, 42);
  } finally {
    await runner.stop();
    await s.cleanup();
  }
});

// 请求替身只抛出中断；等原事务退出后再过期租约，避免在持锁请求内用第二个连接 UPDATE 自锁。
async function interruptDevelopment(): Promise<never> {
  throw new TaskLeaseLostError("模拟 worker 崩溃");
}
async function reclaimDevelopment(s: Awaited<ReturnType<typeof setup>>, id: string, agent: typeof runAgentSession) {
  await s.database.pool.query(
    "UPDATE development_tasks SET lease_expires_at=now()-interval '1 millisecond' WHERE id=$1 AND status IN ('running','publishing')",
    [id],
  );
  const runner = new PersistentRunner(developmentSource(s.store), s.process(agent), 10, {
    leaseMs: 5000,
    heartbeatMs: 100,
  });
  try {
    await runner.start();
    await waitFor(async () =>
      ["succeeded", "discussing", "failed", "cancelled", "uncertain"].includes((await s.getTask(id)).status),
    );
  } finally {
    await runner.stop();
  }
  return s.getTask(id);
}

for (const stage of ["agent", "proposal", "commit", "branch", "pr"] as const) {
  test(`开发恢复：${stage} 中断后另一执行器接手，复用快照/提交且只建一个分支和 PR`, {
    skip: !fixture.url,
  }, async () => {
    const s = await setup();
    try {
      if (stage === "proposal")
        await s.database.pool.query(
          `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,confidence,status,source_fingerprint)
         VALUES($1,1,$2,1,'engineering_rule','代码规则','使用常量','便于维护','{"paths":["src/**"]}','{"pullRequestNumber":1}',1,'ACTIVE',$3)`,
          [randomUUID(), s.repoId, randomUUID()],
        );
      const task = await s.enqueue();
      let interrupted = false;
      const checkpoint = s.store.checkpoint.bind(s.store);
      s.store.checkpoint = async (task, fields) => {
        await checkpoint(task, fields);
        if (stage === "proposal" && fields.proposal && !interrupted) {
          interrupted = true;
          await interruptDevelopment();
        }
      };
      const sideEffects = s.store.sideEffects.bind(s.store);
      s.store.sideEffects = (task) => {
        const effects = sideEffects(task);
        const once = effects.once.bind(effects);
        effects.once = async (key, options) => {
          const result = await once(key, options);
          if (stage === key && !interrupted) {
            interrupted = true;
            await interruptDevelopment();
          }
          return result;
        };
        return effects;
      };
      const agent: typeof runAgentSession = async (input) => {
        const result = await s.agent()(input);
        if (stage === "agent") {
          // 代表五分钟定时保存已落盘，之后执行中断。
          const files = await repositoryFiles(input.root, s.sha, input.signal!);
          await s.store.saveSnapshot(task, s.sha, await collectSnapshot(input.root, s.sha, files, input.signal!));
          await interruptDevelopment();
        }
        return result;
      };
      await assert.rejects(s.process(agent)(task, new AbortController().signal), /模拟 worker 崩溃/);
      const before = await s.getTask(task.id);
      if (stage === "commit") assert.equal(before.head_sha, null, "commit 已 done 但 head checkpoint 未写入");
      let resumed = 0;
      const row = await reclaimDevelopment(s, task.id, async (input) => {
        resumed++;
        assert.equal(stage, "agent", "proposal/commit 后不再调用 Agent");
        assert.deepEqual((input.prompt as any).resume.files, ["src/normal.ts"]);
        assert.match(input.systemPrompt!, /不要从头重写/);
        assert.match(await readFile(join(input.root, "src/normal.ts"), "utf8"), /value = 2/);
        assert.equal(input.budgetTokens, s.config.development.budgetTokens! - 150);
        return s.agent()(input);
      });
      assert.equal(row.status, "succeeded", row.result);
      assert.equal(row.attempt, 2);
      assert.equal(resumed, stage === "agent" ? 1 : 0);
      assert.equal(s.workspaceCount(), ["agent", "proposal"].includes(stage) ? 2 : 1);
      assert.equal(row.usage.totalTokens, stage === "agent" ? 300 : 150);
      assert(row.duration_ms >= before.duration_ms);
      assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
    } finally {
      await s.cleanup();
    }
  });
}

for (const stage of ["branch", "pr"] as const) {
  test(`开发恢复：${stage} 已在 GitHub 生效但响应丢失，pending 先核对不再写入`, { skip: !fixture.url }, async () => {
    const s = await setup();
    try {
      const task = await s.enqueue();
      if (stage === "branch") {
        const create = s.github.createDevelopmentBranch;
        s.github.createDevelopmentBranch = async () => {
          await create();
          return interruptDevelopment();
        };
        s.github.developmentSnapshot = async (..._args: unknown[]) => ({ sha: s.head, tree: "b".repeat(40) });
        // 首次工作区仍固定在真正的基线。
        await s.store.checkpoint(task, { baseSha: s.sha });
        task.base_sha = s.sha;
      } else {
        const create = s.github.createDevelopmentPullRequest;
        s.github.createDevelopmentPullRequest = async (...args) => {
          await create(...args);
          return interruptDevelopment();
        };
        s.github.findDevelopmentPullRequest = async () =>
          s.calls.includes("pr")
            ? [
                {
                  number: 42,
                  head: { sha: s.head, ref: task.branch, repo: { full_name: s.repository } },
                  base: { ref: "dev" },
                },
              ]
            : [];
      }
      await assert.rejects(s.process()(task, new AbortController().signal), /模拟 worker 崩溃/);
      assert.equal(
        (await s.database.pool.query("SELECT status FROM side_effects WHERE key=$1", [`${task.id}:${stage}`])).rows[0]
          .status,
        "pending",
      );
      const row = await reclaimDevelopment(s, task.id, async () => {
        throw new Error("不应重跑 Agent");
      });
      assert.equal(row.status, "succeeded", row.result);
      assert.deepEqual(s.calls, ["commit", "branch", "pr"]);
      assert.equal(s.workspaceCount(), 1);
    } finally {
      await s.cleanup();
    }
  });
}

test("停止放回时保存代码快照，重新领取保留耗时与用量并从工作区继续", { skip: !fixture.url }, async () => {
  const s = await setup();
  const task = await s.enqueue();
  await s.store.release(task);
  let started = false;
  const runner = new PersistentRunner(
    developmentSource(s.store),
    s.process(async (input) => {
      await s.agent()(input);
      started = true;
      return new Promise((_resolve, reject) =>
        input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }),
      );
    }),
    10,
  );
  try {
    await runner.start();
    await waitFor(async () => started);
    await runner.stop();
    const stopped = await s.getTask(task.id);
    assert.equal(stopped.status, "queued");
    assert.equal((await s.store.loadSnapshot(task.id))!.changes[0]!.path, "src/normal.ts");
    const row = await reclaimDevelopment(s, task.id, async (input) => {
      assert.match(await readFile(join(input.root, "src/normal.ts"), "utf8"), /value = 2/);
      assert((input.prompt as any).resume);
      assert(input.timeoutMs <= s.config.development.timeoutMs - stopped.duration_ms);
      return s.agent()(input);
    });
    assert.equal(row.status, "succeeded");
    assert.equal(row.attempt, 1);
    assert.equal(row.usage.totalTokens, 300);
    assert(row.duration_ms >= stopped.duration_ms);
  } finally {
    await runner.stop();
    await s.cleanup();
  }
});

test("revise 推进分支生效、回复前崩溃：不重建工作区，分支只推进一次且评论只发一条", {
  skip: !fixture.url,
}, async () => {
  const s = await setup();
  try {
    const origin = await s.enqueue();
    await s.process()(origin, new AbortController().signal);
    s.pull.ref = origin.branch;
    await prComment(s, 8001, "carol", "改为 3");
    const task = (await s.store.claim())!;
    const push = s.github.updateDevelopmentBranch;
    s.github.updateDevelopmentBranch = async (...args) => {
      await push(...args);
      return interruptDevelopment();
    };
    await assert.rejects(
      s.process(revisionAgent({ action: "change", reply: "已修改", commitMessage: "fix: 修改常量" }))(
        task,
        new AbortController().signal,
      ),
      /模拟 worker 崩溃/,
    );
    s.github.developmentSnapshot = async () => ({ sha: s.head, tree: "b".repeat(40) });
    const count = s.workspaceCount();
    const row = await reclaimDevelopment(s, task.id, async () => {
      throw new Error("不应重跑 Agent");
    });
    assert.equal(row.status, "succeeded", row.result);
    assert.equal(s.workspaceCount(), count);
    assert.equal(s.pushes.length, 1);
    assert.equal(s.issueComments.length, 1);
    assert.match(s.issueComments[0]!.body, /已修改/);
    assert.equal(row.usage.totalTokens, 120);
  } finally {
    await s.cleanup();
  }
});

for (const stage of ["issue", "discuss", "notice"] as const) {
  test(`${stage} 写入生效但响应丢失，接手只读核对后完成`, { skip: !fixture.url }, async () => {
    const s = await setup();
    try {
      let task = await s.enqueue();
      if (stage !== "issue") {
        await s.process(issueAgent(s, [issueAnswer]))(task, new AbortController().signal);
        await comment(s, 8101, "bob", stage === "notice" ? "开始" : "请解释一下");
        task = (await s.store.claim())!;
      }
      if (stage === "issue") {
        const create = s.github.createIssue;
        s.github.createIssue = async (...args) => {
          await create(...args);
          return interruptDevelopment();
        };
      } else {
        const create = s.github.createIssueComment;
        s.github.createIssueComment = async (...args) => {
          await create(...args);
          return interruptDevelopment();
        };
      }
      await assert.rejects(
        s.process(issueAgent(s, [issueAnswer]))(task, new AbortController().signal),
        /模拟 worker 崩溃/,
      );
      const row = await reclaimDevelopment(s, task.id, async () => {
        throw new Error("proposal 已保存，不应再跑 Agent");
      });
      assert.equal(row.status, stage === "issue" ? "discussing" : "succeeded", row.result);
      assert.equal(s.issues.length, 1);
      assert.equal(s.issueComments.length, stage === "issue" ? 0 : 1);
    } finally {
      await s.cleanup();
    }
  });
}

test("快照不套发布文件数/大小限制，gzip 超过 20 MB 清除旧快照且接手从头完成", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    await s.store.saveSnapshot(task, s.sha, [{ path: "old.txt", content: "b2xk", mode: "100644" }]);
    for (let i = 0; i < 31; i++) await writeFile(join(s.root, `temp-${i}.bin`), randomBytes(700_000));
    const files = await repositoryFiles(s.root, s.sha, new AbortController().signal);
    const changes = await collectSnapshot(s.root, s.sha, files, new AbortController().signal);
    assert.equal(changes.length, 31);
    assert.equal(await s.store.saveSnapshot(task, s.sha, changes), false);
    assert.equal(await s.store.loadSnapshot(task.id), undefined);
    await assert.rejects(interruptDevelopment());
    const row = await reclaimDevelopment(s, task.id, async (input) => {
      assert.equal((input.prompt as any).resume, undefined);
      return s.agent()(input);
    });
    assert.equal(row.status, "succeeded", row.result);
  } finally {
    await s.cleanup();
  }
});

for (const offset of [-5000, 5000]) {
  test(`评论时间比数据库时钟${offset}毫秒，下一次只把后续 GitHub 评论标为 new`, { skip: !fixture.url }, async () => {
    const s = await setup();
    try {
      const origin = await s.enqueue();
      await s.process()(origin, new AbortController().signal);
      s.pull.ref = origin.branch;
      const prompts: any[] = [];
      await prComment(s, 8201, "carol", "第一次问题");
      const dbNow = (await s.database.pool.query("SELECT now() at")).rows[0].at.getTime();
      s.prComments[0]!.created_at = new Date(dbNow + offset).toISOString();
      await s.process(revisionAgent({ action: "reply", reply: "答复" }, prompts))(
        (await s.store.claim())!,
        new AbortController().signal,
      );
      await prComment(s, 8202, "carol", "第二次问题");
      s.prComments[1]!.created_at = new Date(dbNow + offset + 1000).toISOString();
      await s.process(revisionAgent({ action: "reply", reply: "答复" }, prompts))(
        (await s.store.claim())!,
        new AbortController().signal,
      );
      assert.deepEqual(
        prompts[1].pullRequest.comments.map((c: any) => c.new),
        [false, true],
      );
    } finally {
      await s.cleanup();
    }
  });
}

test("五分钟定时快照、最终快照串行落盘；失去执行权的旧 worker 不能覆盖新快照", { skip: !fixture.url }, async (t) => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    const files = await repositoryFiles(s.root, s.sha, new AbortController().signal);
    t.mock.timers.enable({ apis: ["setInterval"] });
    const snapshots = snapshotRecorder(s.store, task, s.root, s.sha, files);
    await writeFile(join(s.root, "src/normal.ts"), "periodic\n");
    t.mock.timers.tick(5 * 60_000 - 1);
    assert.equal(await s.store.loadSnapshot(task.id), undefined);
    t.mock.timers.tick(1);
    await waitFor(async () => Boolean(await s.store.loadSnapshot(task.id)));
    assert.equal(
      Buffer.from((await s.store.loadSnapshot(task.id))!.changes[0]!.content!, "base64").toString(),
      "periodic\n",
    );
    await writeFile(join(s.root, "src/normal.ts"), "final\n");
    await snapshots.finish();
    t.mock.timers.reset();
    assert.equal(
      Buffer.from((await s.store.loadSnapshot(task.id))!.changes[0]!.content!, "base64").toString(),
      "final\n",
    );
    await s.store.release(task);
    const successor = (await s.store.claim())!;
    await s.store.saveSnapshot(successor, s.sha, [{ path: "new.txt", content: "bmV3", mode: "100644" }]);
    await assert.rejects(
      s.store.saveSnapshot(task, s.sha, [{ path: "stale.txt", content: "b2xk", mode: "100644" }]),
      TaskLeaseLostError,
    );
    assert.equal((await s.store.loadSnapshot(task.id))!.changes[0]!.path, "new.txt");
    await assert.rejects(
      s.store.sideEffects(task).once("stale-comment", {
        kind: "issue_comment",
        verify: async () => undefined,
        perform: async () => {
          throw new Error("不能发请求");
        },
      }),
      /执行权/,
    );
  } finally {
    t.mock.timers.reset();
    await s.cleanup();
  }
});

test("发布核对持续不可用，达到尝试上限才 uncertain；不同 SHA 分支直接人工核对", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    let task = await s.enqueue();
    const id = task.id;
    s.github.createDevelopmentBranch = async () => {
      s.calls.push("branch");
      throw new Error("network unavailable");
    };
    s.github.developmentSnapshot = async () => ({ sha: s.sha, tree: "b".repeat(40) });
    await assert.rejects(s.process()(task, new AbortController().signal), /network/);
    await s.store.fail(task);
    // 基线 tree 直接按固定 SHA 读；分支核对持续失败。
    s.github.developmentSnapshot = async (_token?: string, _repo?: string, _id?: number, branch?: string) => {
      if (branch?.startsWith("bot/")) throw new Error("verification unavailable");
      return { sha: s.sha, tree: "b".repeat(40) };
    };
    for (let attempt = 2; attempt <= 4; attempt++) {
      task = (await s.store.claim())!;
      assert.equal(task.attempt, attempt);
      await assert.rejects(s.process()(task, new AbortController().signal), /verification/);
      await s.store.fail(task);
      assert.equal((await s.getTask(id)).status, attempt < 4 ? "queued" : "uncertain");
    }
    assert.deepEqual(s.calls, ["commit", "branch"], "核对失败时没有重复写入");
    assert.equal(await s.store.claim(), undefined);

    const conflict = await s.enqueue();
    s.github.developmentSnapshot = async () => ({ sha: s.sha, tree: "b".repeat(40) });
    await assert.rejects(s.process()(conflict, new AbortController().signal), /network/);
    await s.store.fail(conflict);
    const resumed = (await s.store.claim())!;
    await s.process()(resumed, new AbortController().signal);
    assert.equal((await s.getTask(conflict.id)).status, "failed");
    assert.match((await s.getTask(conflict.id)).result, /人工核对/);
  } finally {
    await s.cleanup();
  }
});

test("快照恢复校验父目录链接，保留新增、删除与可执行位并过滤忽略文件", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const signal = new AbortController().signal;
    const files = await repositoryFiles(s.root, s.sha, signal);
    await writeFile(join(s.root, ".gitignore"), "cache/\n");
    await mkdir(join(s.root, "cache"));
    await writeFile(join(s.root, "cache/tmp"), "private cache");
    await mkdir(join(s.root, ".codegraph"));
    await writeFile(join(s.root, ".codegraph/index"), "index");
    await rm(join(s.root, "src/normal.ts"));
    await writeFile(join(s.root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const changes = await collectSnapshot(s.root, s.sha, files, signal);
    assert.deepEqual(changes.map((c) => c.path).sort(), [".gitignore", "run.sh", "src/normal.ts"]);
    assert.equal(changes.find((c) => c.path === "run.sh")!.mode, "100755");
    assert.equal(changes.find((c) => c.path === "src/normal.ts")!.content, null);
    await rm(join(s.root, "run.sh"));
    await applySnapshot(s.root, changes);
    assert.equal(await readFile(join(s.root, "run.sh"), "utf8"), "#!/bin/sh\n");
    await rm(join(s.root, "src"), { recursive: true });
    await symlink("/tmp", join(s.root, "src"));
    await assert.rejects(collectSnapshot(s.root, s.sha, files, signal), /符号链接/);
    await assert.rejects(
      applySnapshot(s.root, [{ path: "src/test", content: "dGVzdA==", mode: "100644" }]),
      /符号链接/,
    );
  } finally {
    await s.cleanup();
  }
});

test("commit 请求成功但台账未落盘：允许孤立提交重做，只有一个提交被分支引用", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    let commits = 0;
    const referenced: string[] = [];
    s.github.createDevelopmentCommit = async () => {
      commits++;
      if (commits === 1) return interruptDevelopment();
      return s.head;
    };
    s.github.createDevelopmentBranch = async (...args: unknown[]) => {
      referenced.push(String(args[3]));
    };
    await assert.rejects(s.process()(task, new AbortController().signal), /模拟 worker 崩溃/);
    const row = await reclaimDevelopment(s, task.id, async () => {
      throw new Error("已有 proposal");
    });
    assert.equal(row.status, "succeeded", row.result);
    assert.equal(commits, 2);
    assert.deepEqual(referenced, [s.head]);
  } finally {
    await s.cleanup();
  }
});

for (const stage of ["proposal", "commit", "reply"] as const) {
  test(`revise ${stage} 中断后复用结果，保持原评论游标且回复去重`, { skip: !fixture.url }, async () => {
    const s = await setup();
    try {
      const origin = await s.enqueue();
      await s.process()(origin, new AbortController().signal);
      s.pull.ref = origin.branch;
      await prComment(s, 8301, "carol", "改为 3");
      const task = (await s.store.claim())!;
      const observed = s.prComments[0]!.created_at;
      let interrupted = false;
      const checkpoint = s.store.checkpoint.bind(s.store);
      s.store.checkpoint = async (current, fields) => {
        await checkpoint(current, fields);
        if (!interrupted && stage === "proposal" && fields.proposal) {
          interrupted = true;
          await interruptDevelopment();
        }
      };
      const sideEffects = s.store.sideEffects.bind(s.store);
      s.store.sideEffects = (current) => {
        const effects = sideEffects(current);
        const once = effects.once.bind(effects);
        effects.once = async (key, options) => {
          const result = await once(key, options);
          if (!interrupted && stage === "commit" && key === "commit") {
            interrupted = true;
            await interruptDevelopment();
          }
          return result;
        };
        return effects;
      };
      if (stage === "reply") {
        const comment = s.github.createIssueComment;
        s.github.createIssueComment = async (...args) => {
          await comment(...args);
          return interruptDevelopment();
        };
      }
      await assert.rejects(
        s.process(revisionAgent({ action: "change", reply: "已修改", commitMessage: "fix: 修改常量" }))(
          task,
          new AbortController().signal,
        ),
        /模拟 worker 崩溃/,
      );
      const workspaceCount = s.workspaceCount();
      s.prComments.push({
        id: 8302,
        body: "期间又发的新问题",
        created_at: observed,
        user: { login: "carol", type: "User" },
      });
      const row = await reclaimDevelopment(s, task.id, async () => {
        throw new Error("不应再次调用 Agent");
      });
      assert.equal(row.status, "succeeded", row.result);
      assert.equal(s.workspaceCount(), workspaceCount + (stage === "proposal" ? 1 : 0));
      assert.equal(row.last_revision_comment_at.toISOString(), observed);
      assert.equal(s.pushes.length, 1);
      assert.equal(s.issueComments.length, 1);
      assert.deepEqual(row.last_revision_comment_ids, ["comment:8301"]);
      await prComment(s, 8302, "carol", "期间又发的新问题");
      const prompts: any[] = [];
      await s.process(revisionAgent({ action: "none" }, prompts))(
        (await s.store.claim())!,
        new AbortController().signal,
      );
      assert.deepEqual(
        prompts[0].pullRequest.comments.map((c: any) => c.new),
        [false, true],
      );
    } finally {
      await s.cleanup();
    }
  });
}

// 等真实时钟越过租约；不能用 UPDATE 过期，因为被测事务必须持有任务行锁。
async function shortLease(s: Awaited<ReturnType<typeof setup>>, task: DevelopmentTask) {
  await s.database.pool.query(
    "UPDATE development_tasks SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
    [task.id],
  );
}
async function leaseElapsed(s: Awaited<ReturnType<typeof setup>>, task: DevelopmentTask) {
  await waitFor(
    async () =>
      (
        await s.database.pool.query(
          "SELECT lease_expires_at<clock_timestamp() expired FROM development_tasks WHERE id=$1",
          [task.id],
        )
      ).rows[0].expired,
  );
}

// 同时包装 pool.query 与事务 client.query，卡在执行权检查之后、记账 SQL 发出之前。
function pauseLedgerDone(pool: Pool) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const wrapQuery = (target: Pool | PoolClient) => async (sql: string, args?: unknown[]) => {
    if (sql.startsWith("UPDATE side_effects SET status='done'") && args?.[1] === JSON.stringify({ sha: "old" })) {
      entered.resolve();
      await released.promise;
    }
    return target.query(sql, args);
  };
  const wrapped = {
    query: wrapQuery(pool),
    connect: async () => {
      const client = await pool.connect();
      return { query: wrapQuery(client), release: () => client.release() };
    },
  } as unknown as Pool;
  return { pool: wrapped, entered: entered.promise, release: released.resolve };
}

test("审查回归 1：旧 owner 请求在途时接手跳过，评论只创建一次", { skip: !fixture.url }, async () => {
  const s = await setup();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let old: Promise<unknown> | undefined;
  try {
    const task = await s.enqueue();
    await shortLease(s, task);
    let writes = 0;
    const options = {
      kind: "issue_comment",
      verify: async () => (writes ? { id: writes } : undefined),
      perform: async () => {
        entered.resolve();
        await released.promise;
        return { id: ++writes };
      },
    };
    old = s.store
      .sideEffects(task)
      .once("comment", options)
      .catch((error) => error);
    await entered.promise;
    await leaseElapsed(s, task);
    const overlapping = await s.store.claim();
    if (overlapping)
      await s.store.sideEffects(overlapping).once("comment", { ...options, perform: async () => ({ id: ++writes }) });
    released.resolve();
    const result = await old;
    assert.equal(overlapping, undefined, "在途请求锁住任务，新 owner 不能领取");
    assert.deepEqual(result, { id: 1 });
    const next = (await s.store.claim())!;
    assert.notEqual(next.owner_token, task.owner_token);
    assert.deepEqual(await s.store.sideEffects(next).once("comment", options), { id: 1 });
    assert.equal(writes, 1);
  } finally {
    released.resolve();
    await old;
    await s.cleanup();
  }
});

test("审查回归 2：检查通过后暂停记账时接手跳过，done 结果不被旧 owner 覆盖", { skip: !fixture.url }, async () => {
  const s = await setup();
  const gate = pauseLedgerDone(s.database.pool);
  let old: Promise<unknown> | undefined;
  try {
    const task = await s.enqueue();
    await shortLease(s, task);
    old = new DevelopmentSideEffects(gate.pool, task)
      .once("commit", {
        kind: "commit",
        verify: async () => undefined,
        perform: async () => ({ sha: "old" }),
      })
      .catch((error) => error);
    await gate.entered;
    await leaseElapsed(s, task);
    const overlapping = await s.store.claim();
    if (overlapping)
      await s.store.sideEffects(overlapping).once("commit", {
        kind: "commit",
        verify: async () => undefined,
        perform: async () => ({ sha: "new" }),
      });
    gate.release();
    const result = await old;
    assert.equal(overlapping, undefined, "台账写事务完成前不能接手");
    assert.deepEqual(result, { sha: "old" });
    const next = (await s.store.claim())!;
    assert.deepEqual(
      await s.store.sideEffects(next).once("commit", {
        kind: "commit",
        verify: async () => undefined,
        perform: async () => {
          throw new Error("不能重复创建提交");
        },
      }),
      { sha: "old" },
    );
    await assert.rejects(
      s.store.sideEffects(task).once("commit", {
        kind: "commit",
        verify: async () => undefined,
        perform: async () => ({ sha: "stale" }),
      }),
      TaskLeaseLostError,
    );
  } finally {
    gate.release();
    await old;
    await s.cleanup();
  }
});

test("审查回归 3：旧快照 SQL 等待行锁时接手跳过，恢复后保存的新快照不被覆盖", { skip: !fixture.url }, async () => {
  const s = await setup();
  let locker: PoolClient | undefined;
  let pending: Promise<unknown> | undefined;
  const changes = (path: string) => [{ path, content: "dGVzdA==", mode: "100644" }];
  try {
    const task = await s.enqueue();
    await s.store.saveSnapshot(task, s.sha, changes("initial"));
    await shortLease(s, task);
    locker = await s.database.pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT * FROM development_snapshots WHERE task_id=$1 FOR UPDATE", [task.id]);
    pending = s.store.saveSnapshot(task, s.sha, changes("stale")).catch((error) => error);
    await waitFor(async () =>
      Boolean(
        (
          await s.database.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'INSERT INTO development_snapshots%' AND wait_event_type='Lock'",
          )
        ).rowCount,
      ),
    );
    await leaseElapsed(s, task);
    const overlapping = await s.store.claim();
    if (overlapping)
      await locker.query("UPDATE development_snapshots SET changes=$2 WHERE task_id=$1", [
        task.id,
        gzipSync(JSON.stringify({ changes: changes("new") })),
      ]);
    await locker.query("COMMIT");
    const saved = await pending;
    assert.equal(overlapping, undefined, "快照 SQL 在途期间不能交接执行权");
    assert.equal(saved, true);
    const next = (await s.store.claim())!;
    await s.store.saveSnapshot(next, s.sha, changes("new"));
    await assert.rejects(s.store.saveSnapshot(task, s.sha, changes("stale")), TaskLeaseLostError);
    assert.equal((await s.store.loadSnapshot(task.id))!.changes[0]!.path, "new");
  } finally {
    if (locker) {
      await locker.query("ROLLBACK");
      locker.release();
    }
    await pending;
    await s.cleanup();
  }
});

test("审查回归 4：pending issue 恢复取 token 失败回队列，后续核对不重建 issue", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    const create = s.github.createIssue;
    s.github.createIssue = async (...args) => {
      await create(...args);
      throw new TaskLeaseLostError("模拟 worker 崩溃");
    };
    await assert.rejects(
      s.process(issueAgent(s, [issueAnswer]))(task, new AbortController().signal),
      TaskLeaseLostError,
    );
    await s.database.pool.query(
      "UPDATE development_tasks SET lease_expires_at=now()-interval '1 millisecond' WHERE id=$1",
      [task.id],
    );
    const next = (await s.store.claim())!;
    const token = s.github.installationToken;
    s.github.installationToken = async () => {
      throw new Error("network unavailable");
    };
    // 模拟 runner：只有处理器抛出错误才调用 fail；直接 finish(failed) 的旧实现会在断言中暴露。
    await s
      .process()(next, new AbortController().signal)
      .catch(() => s.store.fail(next));
    const row = await s.getTask(task.id);
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 3);
    assert.equal(
      (await s.database.pool.query("SELECT status FROM side_effects WHERE key=$1", [`${task.id}:issue`])).rows[0]
        .status,
      "pending",
    );
    s.github.installationToken = token;
    const recovered = (await s.store.claim())!;
    await s.process(async () => {
      throw new Error("不能重跑 Agent");
    })(recovered, new AbortController().signal);
    assert.equal((await s.getTask(task.id)).status, "discussing");
    assert.equal(s.issues.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("审查回归 5：同一 GitHub 秒内后到的评论为 new，已处理的评论不重复", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const origin = await s.enqueue();
    await s.process()(origin, new AbortController().signal);
    s.pull.ref = origin.branch;
    const prompts: any[] = [];
    await prComment(s, 9901, "carol", "第一个问题");
    s.prComments[0].created_at = "2026-11-15T01:00:00Z";
    await s.process(revisionAgent({ action: "reply", reply: "答复" }, prompts))(
      (await s.store.claim())!,
      new AbortController().signal,
    );
    await prComment(s, 9902, "carol", "后到的新问题");
    s.prComments[1].created_at = "2026-11-15T01:00:00Z";
    await s.process(revisionAgent({ action: "reply", reply: "答复" }, prompts))(
      (await s.store.claim())!,
      new AbortController().signal,
    );
    assert.deepEqual(
      prompts[1].pullRequest.comments.map((c: any) => c.new),
      [false, true],
    );
  } finally {
    await s.cleanup();
  }
});

for (const kind of ["discuss", "notice", "revise"] as const) {
  test(`发布恢复准备失败：${kind} 有 pending/done 台账时重排，耗尽才 uncertain`, { skip: !fixture.url }, async () => {
    const s = await setup();
    try {
      const origin = await s.enqueue();
      if (kind === "revise") {
        await s.process()(origin, new AbortController().signal);
        s.pull.ref = origin.branch;
        await prComment(s, 9951, "carol", "请解释");
      } else {
        await s.process(issueAgent(s, [issueAnswer]))(origin, new AbortController().signal);
        await comment(s, 9951, "bob", kind === "notice" ? "开始" : "请解释");
      }
      let task = (await s.store.claim())!;
      assert.equal(task.kind, kind);
      const create = s.github.createIssueComment;
      s.github.createIssueComment = async (...args) => {
        await create(...args);
        return interruptDevelopment();
      };
      await assert.rejects(
        s.process(kind === "revise" ? revisionAgent({ action: "reply", reply: "答复" }) : issueAgent(s, []))(
          task,
          new AbortController().signal,
        ),
        TaskLeaseLostError,
      );
      await s.store.release(task);
      // 即使状态回到 running，也须从持久化台账辨认发布阶段。
      task = (await s.store.claim())!;
      await s.database.pool.query("UPDATE development_tasks SET status='running' WHERE id=$1", [task.id]);
      task.status = "running";
      s.github.installationToken = async () => {
        throw new Error("token network unavailable");
      };
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (attempt > 1) task = (await s.store.claim())!;
        await assert.rejects(s.process()(task, new AbortController().signal), /token network unavailable/);
        await s.store.fail(task);
        const row = await s.getTask(task.id);
        assert.equal(row.status, attempt === 4 ? "uncertain" : "queued");
        assert.equal(row.attempt, attempt + 1);
        if (attempt === 2)
          await s.database.pool.query("UPDATE side_effects SET status='done',result='{}' WHERE task_id=$1", [task.id]);
      }
      assert.equal(s.issueComments.length, 1);
    } finally {
      await s.cleanup();
    }
  });
}

test("同秒评论身份包含种类：comment/review_comment/review 共用 ID 时仍各自处理", { skip: !fixture.url }, async () => {
  const s = await setup();
  try {
    const task = await s.enqueue();
    const at = "2026-11-15T01:00:00Z";
    const user = { id: 2, login: "carol", type: "User" };
    const github: Parameters<typeof pullRequestThread>[0] = {
      getConversationComments: async () => [{ id: 7, body: "对话", created_at: at, user, html_url: "" }],
      getReviewComments: async () => [
        { id: 7, body: "代码行", created_at: at, user, path: "a.ts", line: 1, html_url: "", commit_id: s.sha },
      ],
      getReviews: async () => [
        { id: 7, body: "review", submitted_at: at, user, html_url: "", commit_id: s.sha, state: "COMMENTED" },
      ],
    };
    const result = await pullRequestThread(
      github,
      "token",
      task,
      { title: "PR", body: "" },
      { at: new Date(at), ids: ["comment:7"] },
    );
    assert.deepEqual(
      result.comments.map((c) => [c.kind, c.new]),
      [
        ["comment", false],
        ["review_comment", true],
        ["review", true],
      ],
    );
  } finally {
    await s.cleanup();
  }
});
