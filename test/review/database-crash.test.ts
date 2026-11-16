import { seedTeamRule } from "../helpers/team-rule.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../../src/config/config.js";
import { GitHubApiError, type GitHubClient } from "../../src/github/client.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { transient } from "../../src/jobs/runner.js";
import { createDecisionProcessor } from "../../src/memory/decision.processor.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import type { DecisionProposal } from "../../src/memory/types.js";
import { Database } from "../../src/persistence/database.js";
import { MAX_ATTEMPTS } from "../../src/persistence/repositories/job.repository.js";
import { createReplyProcessor, parseReplyResult } from "../../src/reply/reply.processor.js";
import type { ReplyResult } from "../../src/reply/types.js";
import { emptyUsage, runAgentReview, type AgentReviewInput } from "../../src/review/agent.js";
import { startFakeModel, lastToolResult, type FakeReply } from "../helpers/fake-model.js";
import { createReviewProcessor, validateMemoryReferences } from "../../src/review/review.processor.js";
import type { Finding } from "../../src/review/types.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();
let repositoryId = 9_100_000_000;
const crash = Object.assign(new Error("worker interrupted"), { code: "ECONNRESET" });

async function setup(t: TestContext) {
  const database = new Database(fixture.url!);
  const nextWorker = new Database(fixture.url!);
  await mkdir("work", { recursive: true });
  const root = await mkdtemp(resolve("work/crash-test-"));
  t.after(async () => {
    await database.pool.query(
      "UPDATE jobs SET status='cancelled' WHERE repository_id=$1 AND status IN ('queued','running')",
      [input.repositoryId],
    );
    await database.close();
    await nextWorker.close();
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "a.ts"), "export const value = 1;\n");
  git("add", "a.ts");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  await writeFile(join(root, "a.ts"), "export const value = 2;\n");
  git("commit", "-qam", "head");
  const headSha = git("rev-parse", "HEAD");
  const input = {
    deliveryId: randomUUID(),
    installationId: 1,
    repositoryId: ++repositoryId,
    repository: `owner/crash-test-${repositoryId}`,
    cloneUrl: root,
    prNumber: 2,
    title: "test",
    body: "",
    baseSha,
    headSha,
  };
  const config = {
    appId: "1",
    privateKey: "",
    allowedRepositories: new Set([input.repository]),
    modelName: "test",
    agentTimeoutMs: 10_000,
  } as Config;
  const finding: Finding = {
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    category: "correctness",
    severity: "high",
    evidenceLevel: "strong",
    description: "test finding",
    evidence: "value = 2",
    impact: "test impact",
  };
  const remoteReviews: Array<{ id: number; html_url: string; commit_id: string; body: string }> = [];
  const remoteReplies: Awaited<ReturnType<GitHubClient["getReviewComments"]>> = [];
  const state = { headSha, open: true, draft: false, reviewWrites: 0, replyWrites: 0, interrupted: false };
  const api = {
    installationToken: async () => "token",
    getPullRequest: async () => ({
      state: state.open ? "open" : "closed",
      draft: state.draft,
      base: { sha: baseSha },
      head: { sha: state.headSha },
      merged: !state.open,
      merge_commit_sha: headSha,
      title: "merged test",
      body: "",
    }),
    getFiles: async () => [
      {
        filename: "a.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;",
      },
    ],
    isPrivateRepository: async () => true,
    getReviews: async () => remoteReviews,
    createReview: async (_token: string, job: ReviewJob, body: string) => {
      state.reviewWrites++;
      const published = { id: 90, html_url: "https://example/review/90", commit_id: job.headSha, body };
      remoteReviews.push(published);
      return published;
    },
    getReviewCommentsForReview: async () => {
      const rows = await database.pool.query("SELECT id FROM review_findings WHERE repository_id=$1", [
        input.repositoryId,
      ]);
      return rows.rows.map((row) => ({ id: input.repositoryId * 10 + 1, body: `<!-- pi-finding:${row.id} -->` }));
    },
    getReviewComments: async () => remoteReplies,
    replyToReviewComment: async (_token: string, _repository: string, _pr: number, rootId: number, body: string) => {
      state.replyWrites++;
      const published = {
        id: 20 + state.replyWrites,
        html_url: `https://example/reply/${20 + state.replyWrites}`,
        in_reply_to_id: rootId,
        body,
        path: "a.ts",
        line: 1,
        commit_id: headSha,
        created_at: new Date().toISOString(),
        user: { id: 1, login: "test[bot]", type: "Bot" },
      };
      remoteReplies.push(published);
      return published;
    },
    getConversationComments: async () => [
      { id: 12, html_url: "https://example/12", body: "确认此决定", user: { id: 2, login: "human", type: "User" } },
    ],
  };
  const github = api as unknown as GitHubClient;
  const claim = async (worker = database) => {
    const job = (await worker.claimNext()) as ReviewJob;
    assert.ok(job);
    assert.equal(job.repositoryId, input.repositoryId);
    return job;
  };
  const reclaim = async (job: ReviewJob) => {
    // 不调用 failJob/finishJob，模拟进程被杀、租约过期，再由另一条数据库连接接手。
    await database.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
    const recovered = await claim(nextWorker);
    assert.equal(recovered.id, job.id);
    assert.notEqual(recovered.leaseToken, job.leaseToken);
    assert.equal(recovered.attempt, job.attempt! + 1);
    return recovered;
  };
  const reply = async () => {
    const accepted = await database.accept(input, { event: "pull_request", action: "opened" });
    const [stored] = await database.saveFindings(accepted.job!, [finding], new Set([finding]));
    await database.bindFindings(accepted.job!, 90, [
      { id: input.repositoryId * 10 + 1, body: `<!-- pi-finding:${stored!.id} -->` },
    ]);
    await database.finishJob({ ...accepted.job!, status: "succeeded" });
    const acceptedReply = await database.acceptReply({
      ...input,
      deliveryId: randomUUID(),
      eventHeadSha: headSha,
      rootCommentId: input.repositoryId * 10 + 1,
      sourceCommentId: input.repositoryId,
      sourceCommentUrl: "https://example/12",
      humanActorId: 2,
      humanActorLogin: "human",
      humanReplyBody: "此处为已确认的局部例外",
    });
    await database.pool.query("UPDATE jobs SET payload=payload || $2::jsonb WHERE id=$1", [
      acceptedReply.job!.id,
      JSON.stringify({ cloneUrl: root }),
    ]);
    const result: ReplyResult = {
      findingId: stored!.id,
      analysisHeadSha: headSha,
      conclusion: "VALID_EXCEPTION",
      summary: "适配器有单独的约束。",
      evidence: [{ path: "a.ts", line: 1, detail: "current code" }],
      memoryReferences: [],
      suggestedFindingStatus: "EXCEPTION_PENDING",
      decisionClue: { type: "possible_exception", summary: "adapter exception" },
      limitations: [],
    };
    return { job: await claim(), result };
  };
  return {
    database,
    nextWorker,
    config,
    input,
    finding,
    api,
    github,
    state,
    remoteReviews,
    remoteReplies,
    claim,
    reclaim,
    reply,
  };
}

test("PR Review：各中断点由其他实例接手后只创建一个 Review", { skip: !fixture.url }, async (t) => {
  for (const step of ["Agent 运行中", "创建成功但台账未更新", "台账已更新但 Job 未结束"]) {
    await t.test(step, async (t) => {
      const s = await setup(t);
      await s.database.accept(s.input, { event: "pull_request", action: "opened" });
      const job = await s.claim();
      let runs = 0;
      const execute: NonNullable<Parameters<typeof createReviewProcessor>[4]> = async () => {
        runs++;
        if (step === "Agent 运行中" && runs === 1) throw crash;
        return {
          result: { summary: "test", findings: [s.finding], coverage: ["a.ts"], limitations: [] },
          model: "test",
          durationMs: 1,
          usage: emptyUsage(),
        };
      };
      if (step === "创建成功但台账未更新")
        t.mock.method(s.database, "finishPublication", async () => {
          throw crash;
        });
      const first = createReviewProcessor(s.config, s.github, s.database, new MemoryService(s.database), execute);
      if (step === "台账已更新但 Job 未结束") await first(job);
      else await assert.rejects(first(job), /worker interrupted/);
      assert.equal(s.state.reviewWrites, step === "Agent 运行中" ? 0 : 1);
      const recovered = await s.reclaim(job);
      await createReviewProcessor(
        s.config,
        s.github,
        s.nextWorker,
        new MemoryService(s.nextWorker),
        execute,
      )(recovered);
      await s.nextWorker.finishJob(recovered);
      assert.equal(s.state.reviewWrites, 1);
      assert.equal(s.remoteReviews.length, 1);
      const publication = await s.nextWorker.pool.query("SELECT * FROM review_publications WHERE job_id=$1", [job.id]);
      assert.equal(publication.rows[0].status, "published");
      assert.equal(Number(publication.rows[0].github_review_id), 90);
      assert.equal((await s.nextWorker.getJob(job.id))?.status, "succeeded");
    });
  }
});

test("Reply：各中断点恢复不重复发布，已保存结果不重跑 Agent", { skip: !fixture.url }, async (t) => {
  for (const step of ["Agent 运行中", "回复已发出但未记账", "已记账但 Job 未结束", "结果已保存但尚未发出"]) {
    await t.test(step, async (t) => {
      const s = await setup(t);
      const { job, result } = await s.reply();
      let runs = 0;
      const execute: NonNullable<Parameters<typeof createReplyProcessor>[4]> = async () => {
        runs++;
        if (step === "Agent 运行中" && runs === 1) {
          s.state.interrupted = true;
          throw crash;
        }
        return { text: "", result, model: "test", durationMs: 1, usage: emptyUsage() };
      };
      // 模拟杀进程：故障发生后第一实例不能再写台账或 Agent 结束状态。
      const mark = s.database.markReplyPublication;
      t.mock.method(s.database, "markReplyPublication", async (...args: Parameters<typeof mark>) => {
        if (s.state.interrupted) throw crash;
        return mark(...args);
      });
      const finishRun = s.database.finishAgentRun;
      t.mock.method(s.database, "finishAgentRun", async (...args: Parameters<typeof finishRun>) => {
        if (s.state.interrupted) throw crash;
        return finishRun(...args);
      });
      const post = s.api.replyToReviewComment;
      const postMock = t.mock.method(s.api, "replyToReviewComment", async (...args: Parameters<typeof post>) => {
        if (step === "结果已保存但尚未发出") {
          s.state.interrupted = true;
          throw crash;
        }
        const published = await post(...args);
        if (step === "回复已发出但未记账") {
          s.state.interrupted = true;
          throw crash;
        }
        return published;
      });
      const first = createReplyProcessor(s.config, s.database, new MemoryService(s.database), s.github, execute);
      if (step === "已记账但 Job 未结束") await first(job);
      else await assert.rejects(first(job), /worker interrupted/);
      postMock.mock.restore();
      const recovered = await s.reclaim(job);
      await createReplyProcessor(s.config, s.nextWorker, new MemoryService(s.nextWorker), s.github, execute)(recovered);
      await s.nextWorker.finishJob(recovered);
      assert.equal(s.state.replyWrites, 1, "GitHub 只收到一次有效回复写入");
      assert.equal(s.remoteReplies.length, 1);
      assert.equal(runs, step === "Agent 运行中" ? 2 : 1, "已有结果或已发布时不能重跑 Agent");
      assert.ok(s.remoteReplies[0]!.body.endsWith(`<!-- pi-reply:${job.sourceCommentId} -->`));
      assert.equal((await s.nextWorker.getReplyPublication(job.sourceCommentId!))?.status, "published");
      assert.equal((await s.nextWorker.getFinding(result.findingId))?.status, "EXCEPTION_PENDING");
      assert.equal((await s.nextWorker.getDecisionClues(job.repositoryId, job.prNumber)).length, 1);
      assert.equal((await s.nextWorker.getJob(job.id))?.status, "succeeded");
    });
  }
});

test("规则提取：候选已提交但 Job 未结束，租约恢复后不重复候选", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  s.state.open = false;
  await s.database.accept(s.input, {
    event: "pull_request",
    action: "closed",
    merged: true,
    mergeCommitSha: s.input.headSha,
  });
  const job = await s.claim();
  assert.equal(job.jobType, "DECISION_EXTRACT");
  const proposal: DecisionProposal = {
    type: "engineering_rule",
    title: "test rule",
    content: "test decision",
    rationale: "human confirmed",
    scope: { paths: ["a.ts"] },
    source: { pullRequestNumber: job.prNumber, commitSha: job.headSha, commentIds: [12] },
    evidence: [
      { kind: "human_comment", reference: "12", detail: "confirmed" },
      { kind: "code", reference: "a.ts:1", detail: "current code" },
    ],
    confidence: 0.9,
    uncertainties: [],
  };
  let runs = 0;
  const execute: NonNullable<Parameters<typeof createDecisionProcessor>[4]> = async () => {
    runs++;
    return { text: JSON.stringify([proposal]), model: "test", durationMs: 1, usage: emptyUsage() };
  };
  const insert = s.database.insertCandidates;
  t.mock.method(s.database, "insertCandidates", async (...args: Parameters<typeof insert>) => {
    await insert(...args);
    throw crash;
  });
  await assert.rejects(
    createDecisionProcessor(s.config, s.database, new MemoryService(s.database), s.github, execute)(job),
    /worker interrupted/,
  );
  const rows = async () =>
    (await s.nextWorker.pool.query("SELECT id,status FROM memories WHERE repository_id=$1", [job.repositoryId])).rows;
  const before = await rows();
  assert.equal(before.length, 1);
  const recovered = await s.reclaim(job);
  await createDecisionProcessor(s.config, s.nextWorker, new MemoryService(s.nextWorker), s.github, execute)(recovered);
  await s.nextWorker.finishJob(recovered);
  assert.deepEqual(await rows(), before);
  assert.equal(before[0].status, "CANDIDATE");
  assert.equal(runs, 2);
  assert.equal((await s.nextWorker.getJob(job.id))?.status, "succeeded");
});

test("Reply 恢复只匹配同一线程、Bot 和 source comment 标记，不读取源码或重跑 Agent", {
  skip: !fixture.url,
}, async (t) => {
  for (const found of [false, true]) {
    await t.test(
      found ? "找到远端回复，PR 已关闭也只补记账" : "不把其他线程、人类或其他 source 的评论当成已发布",
      async (t) => {
        const s = await setup(t);
        const { job, result } = await s.reply();
        await s.database.markReplyPublication(job, "pending", result);
        const comment = {
          id: 99,
          html_url: "https://example/reply/99",
          in_reply_to_id: job.rootCommentId,
          body: `saved response\n\n<!-- pi-reply:${job.sourceCommentId} -->`,
          path: "a.ts",
          line: 1,
          commit_id: job.headSha,
          created_at: new Date().toISOString(),
          user: { id: 1, login: "test[bot]", type: "Bot" },
        };
        s.remoteReplies.push(
          { ...comment, id: 100, in_reply_to_id: job.rootCommentId! + 1 },
          { ...comment, id: 101, user: { id: 2, login: "human", type: "User" } },
          { ...comment, id: 102, body: `<!-- pi-reply:${job.sourceCommentId! + 1} -->` },
        );
        if (found) {
          s.remoteReplies.push(comment);
          s.state.open = false;
          s.state.headSha = s.input.baseSha;
        }
        t.mock.method(s.api, "getFiles", async () => {
          throw new Error("must not load files");
        });
        await createReplyProcessor(s.config, s.database, new MemoryService(s.database), s.github, async () => {
          throw new Error("must not run agent");
        })(job);
        await s.database.finishJob(job);
        assert.equal(s.state.replyWrites, found ? 0 : 1);
        const publication = await s.database.getReplyPublication(job.sourceCommentId!);
        assert.equal(publication?.status, "published");
        assert.equal(Number(publication?.github_reply_comment_id), found ? 99 : 21);
        assert.deepEqual(publication?.result, result);
        assert.equal((await s.database.getFinding(result.findingId))?.status, result.suggestedFindingStatus);
        assert.equal((await s.database.getDecisionClues(job.repositoryId, job.prNumber)).length, 1);
      },
    );
  }
});

test("Reply 恢复发布前仍检查 head、PR 状态、仓库授权和取消信号", { skip: !fixture.url }, async (t) => {
  for (const state of ["新 head", "发布前新 head", "closed", "draft", "paused", "unauthorized", "保存结果时取消"]) {
    await t.test(state, async (t) => {
      const s = await setup(t);
      const { job, result } = await s.reply();
      await s.database.markReplyPublication(job, "pending", result);
      if (state === "新 head") s.state.headSha = s.input.baseSha;
      if (state === "closed") s.state.open = false;
      if (state === "draft") s.state.draft = true;
      if (state === "paused")
        await s.database.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [job.repositoryId]);
      if (state === "unauthorized") s.config.allowedRepositories.clear();
      if (state === "发布前新 head") {
        const get = s.api.getPullRequest;
        let reads = 0;
        t.mock.method(s.api, "getPullRequest", async () => {
          if (++reads === 2) s.state.headSha = s.input.baseSha;
          return get();
        });
      }
      if (state === "保存结果时取消") {
        const mark = s.database.markReplyPublication;
        t.mock.method(s.database, "markReplyPublication", async (...args: Parameters<typeof mark>) => {
          await mark(...args);
          s.database.stopReviews();
        });
      }
      await createReplyProcessor(s.config, s.database, new MemoryService(s.database), s.github, async () => {
        throw new Error("must not run agent");
      })(job);
      assert.equal(s.state.replyWrites, 0);
      if (state.includes("head")) {
        assert.equal(job.status, "queued");
        assert.equal(job.headSha, s.input.baseSha);
        assert.equal((await s.database.getReplyPublication(job.sourceCommentId!))?.result, null);
        const next = await s.claim(s.nextWorker);
        let runs = 0;
        await createReplyProcessor(
          s.config,
          s.nextWorker,
          new MemoryService(s.nextWorker),
          s.github,
          async (_config, _root, _input, binding) => {
            runs++;
            assert.equal(binding.headSha, s.input.baseSha);
            return {
              text: "",
              result: { ...result, analysisHeadSha: binding.headSha },
              model: "test",
              durationMs: 1,
              usage: emptyUsage(),
            };
          },
        )(next);
        await s.nextWorker.finishJob(next);
        assert.equal(runs, 1, "旧结果清空后才在新 head 重新分析");
        assert.equal(s.state.replyWrites, 1);
      } else {
        assert.equal(job.status, "cancelled");
        assert.equal((await s.database.getFinding(result.findingId))?.status, "OPEN");
      }
    });
  }
});

test("Reply 发布网络错误和 5xx 按既有分类重试，先核对再决定是否发送", { skip: !fixture.url }, async (t) => {
  for (const mode of ["已创建但断网", "已创建但 502", "未创建 502", "最终尝试已创建但断网", "明确拒绝 403"]) {
    await t.test(mode, async (t) => {
      const s = await setup(t);
      const { job, result } = await s.reply();
      if (mode.startsWith("最终")) job.attempt = MAX_ATTEMPTS;
      let runs = 0;
      const execute: NonNullable<Parameters<typeof createReplyProcessor>[4]> = async () => {
        runs++;
        return { text: "", result, model: "test", durationMs: 1, usage: emptyUsage() };
      };
      const post = s.api.replyToReviewComment;
      const error = mode.endsWith("断网")
        ? new Error("fetch failed")
        : new GitHubApiError("/replies", mode.endsWith("403") ? 403 : 502);
      const failedPost = t.mock.method(s.api, "replyToReviewComment", async (...args: Parameters<typeof post>) => {
        assert.deepEqual(
          (await s.database.getReplyPublication(job.sourceCommentId!))?.result,
          result,
          "外部写入前结果已持久化",
        );
        if (mode.includes("已创建")) await post(...args);
        throw error;
      });
      const processor = createReplyProcessor(s.config, s.database, new MemoryService(s.database), s.github, execute);
      if (mode.startsWith("最终")) {
        await processor(job);
        await s.database.finishJob(job);
      } else {
        await assert.rejects(processor(job), (actual) => actual === error);
        await s.database.failJob(job, error, transient(error));
        if (mode.endsWith("403")) {
          assert.equal(job.status, "failed");
          assert.equal((await s.database.getReplyPublication(job.sourceCommentId!))?.status, "failed");
          assert.equal(s.state.replyWrites, 0);
          return;
        }
        assert.equal(job.status, "queued");
        assert.equal((await s.database.getReplyPublication(job.sourceCommentId!))?.status, "pending");
        failedPost.mock.restore();
        await s.database.pool.query("UPDATE jobs SET next_run_at=now() WHERE id=$1", [job.id]);
        const next = await s.claim(s.nextWorker);
        await createReplyProcessor(s.config, s.nextWorker, new MemoryService(s.nextWorker), s.github, execute)(next);
        await s.nextWorker.finishJob(next);
      }
      assert.equal(s.state.replyWrites, 1);
      assert.equal(runs, 1);
      assert.equal((await s.database.getReplyPublication(job.sourceCommentId!))?.status, "published");
      assert.equal((await s.database.getJob(job.id))?.status, "succeeded");
    });
  }
});

test("Reply 核对暂时失败保留 pending，尝试耗尽才 uncertain，期间没有新写入", { skip: !fixture.url }, async (t) => {
  for (const unavailable of [1, MAX_ATTEMPTS]) {
    await t.test(unavailable === 1 ? "核对恢复后继续发布" : "持续无法核对", async (t) => {
      const s = await setup(t);
      const { job, result } = await s.reply();
      await s.database.markReplyPublication(job, "pending", result);
      const error = new GitHubApiError("/comments", 503);
      let reads = 0;
      t.mock.method(s.api, "getReviewComments", async () => {
        if (++reads <= unavailable) throw error;
        return s.remoteReplies;
      });
      const processor = createReplyProcessor(
        s.config,
        s.nextWorker,
        new MemoryService(s.nextWorker),
        s.github,
        async () => {
          throw new Error("must not run agent");
        },
      );
      let current = job;
      for (let attempt = 1; attempt <= unavailable; attempt++) {
        await assert.rejects(processor(current), (actual) => actual === error);
        await s.nextWorker.failJob(current, error, transient(error));
        const exhausted = attempt === MAX_ATTEMPTS;
        assert.equal(current.status, exhausted ? "uncertain" : "queued");
        assert.equal(
          (await s.database.getReplyPublication(job.sourceCommentId!))?.status,
          exhausted ? "uncertain" : "pending",
        );
        assert.equal(s.state.replyWrites, 0);
        if (!exhausted) {
          await s.database.pool.query("UPDATE jobs SET next_run_at=now() WHERE id=$1", [job.id]);
          current = await s.claim(s.nextWorker);
        }
      }
      if (unavailable === 1) {
        await processor(current);
        await s.nextWorker.finishJob(current);
        assert.equal(s.state.replyWrites, 1);
        assert.equal((await s.database.getReplyPublication(job.sourceCommentId!))?.status, "published");
      } else {
        await assert.rejects(processor(current), /待核对/);
        assert.equal(reads, MAX_ATTEMPTS);
        assert.equal((await s.database.getFinding(result.findingId))?.status, "OPEN");
      }
    });
  }
});

test("上下文：仓库规则进入 Review、引用与 usage；停用后拒绝引用", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  await s.database.accept(s.input, { event: "pull_request", action: "opened" });
  const team = await seedTeamRule(s.database, s.input.repositoryId);
  t.mock.method(s.api, "getReviewCommentsForReview", async () => {
    const rows = await s.database.pool.query(
      "SELECT id FROM review_findings WHERE repository_id=$1 ORDER BY created_at,id",
      [s.input.repositoryId],
    );
    return rows.rows.map((row, index) => ({
      id: s.input.repositoryId * 10 + index + 1,
      body: `<!-- pi-finding:${row.id} -->`,
    }));
  });
  const memories = new MemoryService(s.database);
  const logs = t.mock.method(console, "info", () => undefined);
  for (const [index, phase] of ["active", "level", "disable"].entries()) {
    if (phase === "level") await s.database.pool.query("UPDATE memories SET level='info' WHERE id=$1", [team.id]);
    if (phase === "disable")
      await s.database.pool.query("UPDATE memories SET status='DEPRECATED' WHERE id=$1", [team.id]);
    if (index)
      await s.database.accept(
        { ...s.input, deliveryId: randomUUID(), prNumber: 2 + index },
        { event: "pull_request", action: "opened" },
      );
    const job = await s.claim();
    const expected = phase === "active" || phase === "level";
    const reference: Finding = { ...s.finding, category: "team_rule", memory: { id: team.id, version: 1, source: {} } };
    await createReviewProcessor(s.config, s.github, s.database, memories, async (input) => {
      assert.deepEqual(
        input.memories?.map((rule) => rule.id),
        expected ? [team.id] : [],
      );
      if (expected) assert.equal(input.memories![0]!.level, phase === "level" ? "info" : "must");
      if (!expected)
        assert.throws(
          () =>
            validateMemoryReferences(
              { summary: "", findings: [reference], coverage: [], limitations: [] },
              input.memories!,
            ),
          /未召回/,
        );
      return {
        result: { summary: "team test", findings: [reference], coverage: [], limitations: [] },
        model: "test",
        durationMs: 1,
        usage: emptyUsage(),
      };
    })(job);
    await s.database.finishJob(job);
    const usage = (
      await s.database.pool.query(
        "SELECT repository_id,memory_id,memory_version FROM review_memory_usage WHERE job_id=$1",
        [job.id],
      )
    ).rows;
    assert.equal(usage.length, expected ? 1 : 0);
    if (expected)
      assert.deepEqual(usage[0], { repository_id: String(job.repositoryId), memory_id: team.id, memory_version: 1 });
    const findings = (await s.database.pool.query("SELECT memory_id FROM review_findings WHERE job_id=$1", [job.id]))
      .rows;
    assert.equal(findings.length, expected ? 1 : 0);
  }
  assert.equal(
    logs.mock.calls.filter((call) => JSON.parse(call.arguments[0]).event === "review_findings_dropped").length,
    1,
  );
});

test("上下文：Reply 带回本仓库原规则；停用或其他仓库的规则不带回", { skip: !fixture.url }, async (t) => {
  for (const phase of ["active", "disable", "foreign"])
    await t.test(phase, async (t) => {
      const s = await setup(t);
      const { job, result } = await s.reply();
      const team = await seedTeamRule(s.database, job.repositoryId, { scope: { paths: ["other/**"] } });
      await s.database.pool.query("UPDATE review_findings SET memory_id=$2,memory_version=1 WHERE id=$1", [
        result.findingId,
        team.id,
      ]);
      if (phase === "disable")
        await s.database.pool.query("UPDATE memories SET status='DEPRECATED' WHERE id=$1", [team.id]);
      if (phase === "foreign")
        await s.database.pool.query("UPDATE memories SET repository_id=$2 WHERE id=$1", [
          team.id,
          job.repositoryId + 100_000,
        ]);
      await createReplyProcessor(
        s.config,
        s.database,
        new MemoryService(s.database),
        s.github,
        async (_config, _root, prompt, binding) => {
          const expected = phase === "active";
          assert.deepEqual(
            binding.memories.map((rule) => rule.id),
            expected ? [team.id] : [],
          );
          assert.deepEqual((prompt as any).relevantMemories, binding.memories);
          const cited = { ...result, memoryReferences: [{ id: team.id, version: 1 }] };
          if (expected)
            assert.deepEqual(parseReplyResult(JSON.stringify(cited), binding).memoryReferences, cited.memoryReferences);
          else assert.throws(() => parseReplyResult(JSON.stringify(cited), binding), /Memory 引用无效/);
          return { text: "", result: expected ? cited : result, model: "test", durationMs: 1, usage: emptyUsage() };
        },
      )(job);
      await s.database.finishJob(job);
    });
});

test("上下文：提取器只看本仓库规则，保存例外、冲突和替代关系", { skip: !fixture.url }, async (t) => {
  const s = await setup(t);
  s.state.open = false;
  await s.database.accept(s.input, {
    event: "pull_request",
    action: "closed",
    merged: true,
    mergeCommitSha: s.input.headSha,
  });
  const job = await s.claim();
  const team = await seedTeamRule(s.database, job.repositoryId);
  const service = new MemoryService(s.database);
  const logs = t.mock.method(console, "info", () => undefined);
  await createDecisionProcessor(s.config, s.database, service, s.github, async (input) => {
    const rules = (input.prompt as any).existingRules;
    assert.equal(rules[0].id, team.id);
    assert.equal(rules[0].repositoryId, job.repositoryId);
    const proposal: DecisionProposal = {
      type: "exception",
      title: "项目例外",
      content: "本项目局部例外",
      rationale: "人工确认",
      scope: { paths: ["a.ts"] },
      source: { pullRequestNumber: job.prNumber, commitSha: job.headSha, commentIds: [12] },
      evidence: [
        { kind: "human_comment", reference: "12", detail: "confirmed" },
        { kind: "code", reference: "a.ts:1", detail: "current code" },
      ],
      confidence: 1,
      uncertainties: [],
    };
    return {
      text: JSON.stringify([
        { ...proposal, relation: { exceptionTo: team.id } },
        {
          ...proposal,
          type: "engineering_rule",
          title: "可能冲突",
          content: "可能与团队冲突",
          relation: { conflictsWith: [team.id] },
        },
        {
          ...proposal,
          type: "engineering_rule",
          title: "新的替代",
          content: "本仓库新的规则",
          relation: { supersedes: team.id },
        },
      ]),
      model: "test",
      durationMs: 1,
      usage: emptyUsage(),
    };
  })(job);
  const candidates = (await service.list(job.repositoryId)).filter((rule) => rule.status === "CANDIDATE");
  assert.equal(candidates.length, 3);
  const exception = candidates.find((rule) => rule.type === "exception")!;
  assert.equal(exception.exceptionTo, team.id);
  await service.transition(job.repositoryId, exception.id, "approve", { id: 1, login: "maintainer" });
  assert.deepEqual(
    new Set((await service.context(job.repositoryId, { paths: ["a.ts"], text: "" })).full.map((rule) => rule.id)),
    new Set([exception.id, team.id]),
  );
  assert.ok(candidates.find((rule) => rule.title === "可能冲突")?.uncertainties[0]?.includes(team.id));
  const event = logs.mock.calls
    .map((call) => JSON.parse(call.arguments[0]))
    .find((event) => event.event === "decisions_extracted");
  assert.deepEqual(event.discardedReasons, {});
  assert.equal(candidates.find((rule) => rule.title === "新的替代")?.supersedes, team.id);
  await s.database.finishJob(job);
});

test("规则索引：真实 Pi 工具转发、读取 usage、must 缺口与结果持久化后照常发布", { skip: !fixture.url }, async (t) => {
  for (const phase of ["read", "parallel", "unread", "missing", "violated"])
    await t.test(phase, async (t) => {
      const s = await setup(t);
      await s.database.accept(s.input, { event: "pull_request", action: "opened" });
      const full = await seedTeamRule(s.database, s.input.repositoryId, { title: "必须规则", level: "must" });
      const indexed = await seedTeamRule(s.database, s.input.repositoryId, { title: "索引规则", level: "should" });
      const untouched = await seedTeamRule(s.database, s.input.repositoryId, { title: "未读规则", level: "info" });
      await s.database.pool.query("UPDATE memories SET content=$2 WHERE id=$1", [full.id, "正文".repeat(15_001)]);
      const finding = { ...s.finding, category: "team_rule", memory: { id: indexed.id, version: 1, source: {} } };
      const answer = (findings: object[], ruleChecks?: object[]) =>
        JSON.stringify({
          summary: "完整审查",
          findings,
          coverage: ["a.ts"],
          limitations: [],
          findingGroups: findings.map((_, index) => [index]),
          issueDisplays: findings.map(() => ({ title: "问题", reason: "依据", fix: "修改" })),
          ...(ruleChecks ? { ruleChecks } : {}),
        });
      const check = { id: full.id, version: 1, result: phase === "violated" ? "violated" : "followed" };
      const reads = phase === "read" || phase === "parallel";
      const final = answer(reads || phase === "unread" ? [finding] : [], phase === "missing" ? undefined : [check]);
      const script: FakeReply[] = reads
        ? [
            {
              toolCalls: (phase === "parallel" ? [indexed.id, untouched.id] : [indexed.id]).map((id) => ({
                name: "read_team_rule",
                args: { id },
              })),
            },
            { text: final },
          ]
        : [{ text: final }, { text: final }];
      const model = await startFakeModel(script);
      t.after(() => model.close());
      const job = await s.claim();
      const memories = new MemoryService(s.database);
      const contextCalls = t.mock.method(memories, "context");
      await createReviewProcessor(
        {
          ...s.config,
          modelProvider: "rule-test",
          modelName: "test-model",
          modelApiKey: "fake-key",
          agentTimeoutMs: 30_000,
          modelEndpoint: { api: "openai-completions", baseUrl: model.baseUrl },
        },
        s.github,
        s.database,
        memories,
        async (input) => {
          assert.deepEqual(
            input.memories?.map((rule) => rule.id),
            [full.id],
          );
          assert.deepEqual(
            input.teamRuleIndex?.map((rule) => rule.id),
            [indexed.id, untouched.id],
          );
          return runAgentReview({ ...input, codegraph: false } as AgentReviewInput);
        },
      )(job);
      await s.database.finishJob(job);
      assert.equal(s.state.reviewWrites, 1, "检查缺口不阻止 Review 发布");
      assert.equal(model.requests.length, 2, "一次读取或一次修复，共用会话");
      assert.equal(contextCalls.mock.callCount(), reads ? 2 : 1, "多次读取共用一次额外上下文查询");
      const prompt = model.requests[0]!.body.messages.filter((message: any) => message.role === "user").at(-1).content;
      assert.match(JSON.stringify(prompt), /teamRuleIndex/);
      if (phase === "read") assert.match(lastToolResult(model.requests[1]!)!, /索引规则/);
      const usage = (
        await s.database.pool.query("SELECT memory_id FROM review_memory_usage WHERE job_id=$1 ORDER BY memory_id", [
          job.id,
        ])
      ).rows.map((row) => row.memory_id);
      assert.deepEqual(
        usage,
        (phase === "parallel" ? [full.id, indexed.id, untouched.id] : reads ? [full.id, indexed.id] : [full.id]).sort(),
      );
      const stored = (await s.database.pool.query("SELECT review_result FROM jobs WHERE id=$1", [job.id])).rows[0]
        .review_result;
      assert.equal(stored.findings.length, reads ? 1 : 0);
      if (phase === "missing" || phase === "violated") {
        assert.deepEqual(stored.ruleChecks, []);
        assert.deepEqual(stored.uncheckedMustRules, [{ id: full.id, version: 1, title: "必须规则" }]);
        assert(stored.limitations.includes("以下 must 规则未确认检查：必须规则"));
      } else {
        assert.deepEqual(stored.ruleChecks, [check]);
        assert.deepEqual(stored.uncheckedMustRules, []);
      }
      if (phase === "unread") assert.equal(stored.droppedFindings, 1);
      const publication = (
        await s.database.pool.query("SELECT status FROM review_publications WHERE job_id=$1", [job.id])
      ).rows[0];
      assert.equal(publication.status, "published");
    });
});
