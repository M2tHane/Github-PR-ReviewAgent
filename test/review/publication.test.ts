import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewProcessor } from "../../src/review/review.processor.js";
import { publishReview, type PublicationStore } from "../../src/review/review.publisher.js";
import { createReplyProcessor } from "../../src/reply/reply.processor.js";
import { emptyUsage } from "../../src/review/agent.js";
import { GitHubApiError, type GitHubClient } from "../../src/github/client.js";
import type { Database } from "../../src/persistence/database.js";
import type { MemoryService } from "../../src/memory/memory.service.js";
import type { Config } from "../../src/config/config.js";
import type { Finding, StoredFinding } from "../../src/review/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const exec = promisify(execFile);

test("固定提交发布：旧 head 不发布，绑定失败保留已发布 Review，Reply 过期重排且 uncertain 不重发", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-publication-test-"));
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.invalid");
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src/a.ts"), "export const value = 1;\n");
    await git("add", "src/a.ts");
    await git("commit", "-qm", "base");
    const baseSha = await git("rev-parse", "HEAD");
    await writeFile(join(source, "src/a.ts"), "export const value = 2;\n");
    await git("commit", "-qam", "head");
    const headSha = await git("rev-parse", "HEAD");
    const config = {
      appId: "1",
      privateKey: "",
      allowedRepositories: new Set(["owner/test"]),
      agentTimeoutMs: 10_000,
      modelName: "test",
    } as Config;
    const job = {
      id: "job",
      deliveryId: "delivery",
      repositoryId: 1,
      installationId: 1,
      repository: "owner/test",
      prNumber: 2,
      cloneUrl: source,
      baseSha,
      headSha,
      title: "",
      body: "",
      status: "running",
    } satisfies ReviewJob;
    const finding = {
      path: "src/a.ts",
      line: 1,
      side: "RIGHT",
      category: "correctness",
      severity: "high",
      evidenceLevel: "strong",
      description: "sample finding",
      evidence: "value = 2",
      impact: "sample impact",
    } satisfies Finding;
    const stored = {
      ...finding,
      id: "finding",
      jobId: job.id,
      repositoryId: 1,
      prNumber: 2,
      headSha,
      fingerprint: "fingerprint",
      status: "OPEN",
      githubCommentId: 11,
      bindingStatus: "pending",
    } satisfies StoredFinding;
    let currentHead = headSha,
      enabled = true,
      reviewPosts = 0,
      replyPosts = 0,
      prior = "pending",
      replyCalls = 0;
    const publications: string[] = [],
      bindings: number[] = [];
    const github = {
      installationToken: async () => "test-token",
      getPullRequest: async () => ({ state: "open", draft: false, base: { sha: baseSha }, head: { sha: currentHead } }),
      getFiles: async () => [
        {
          filename: "src/a.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;",
        },
      ],
      createReview: async (_token: string, _job: ReviewJob, body: string, comments: unknown[]) => {
        assert.match(body, /发现 1 个问题/);
        assert(!body.includes("在本次检查范围内未产出 finding"));
        assert.equal(comments.length, 1);
        reviewPosts++;
        return { id: 99, html_url: "https://example/review/99" };
      },
      getReviewCommentsForReview: async () => {
        throw new GitHubApiError("/comments", 403);
      },
      getReviewComments: async () => [],
      replyToReviewComment: async () => {
        replyPosts++;
        throw new Error("network result unknown");
      },
    } as unknown as GitHubClient;
    const publicationsStore = {
      getRepositoryConfig: async () => ({
        enabled,
        includePaths: [],
        excludePaths: [],
        outputLanguage: "zh-CN",
        budgetTokens: 1000,
        reviewMode: "single" as const,
        maxDelegates: 0,
      }),
      isRepositoryEnabled: async () => enabled,
      saveFindings: async () => [stored],
      beginPublication: async () => ({ status: "pending" }),
      finishPublication: async (_job: ReviewJob, status: string) => {
        publications.push(status);
      },
      bindFindings: async (_job: ReviewJob, _id: number, comments: unknown[]) => {
        bindings.push(comments.length);
        return 0;
      },
    };
    for (const mode of ["stale", "paused", "binding"]) {
      currentHead = headSha;
      enabled = true;
      const target: ReviewJob = { ...job };
      await createReviewProcessor(config, github, publicationsStore, undefined, async () => {
        if (mode === "stale") currentHead = "c".repeat(40);
        if (mode === "paused") enabled = false;
        return {
          result: { summary: "sample", findings: [finding], coverage: ["src/a.ts"], limitations: [] },
          model: "test",
          durationMs: 1,
          usage: emptyUsage(),
        };
      })(target);
      if (mode !== "binding") {
        assert.equal(target.status, "superseded");
        assert.equal(reviewPosts, 0);
      } else {
        assert.equal(target.reviewId, 99);
        assert.deepEqual(publications, ["published"]);
        assert.deepEqual(bindings, [0]);
      }
    }
    const database = {
      ...publicationsStore,
      getReplyPublication: async () => ({ status: prior }),
      getFinding: async () => stored,
      retargetReply: async (target: ReviewJob, base: string, head: string) => {
        target.baseSha = base;
        target.headSha = head;
      },
      requeueReply: async (target: ReviewJob, base: string, head: string) => {
        target.status = "queued";
        target.baseSha = base;
        target.headSha = head;
      },
      registerReviewAbort: () => {},
      unregisterReviewAbort: () => {},
      startAgentRun: async () => "run",
      finishAgentRun: async () => {},
      markReplyPublication: async (_job: ReviewJob, status: string) => {
        prior = status;
      },
      finishReply: async () => {
        throw new Error("must not publish");
      },
    } as unknown as Database;
    const memories = { retrieve: async () => [] } as unknown as MemoryService;
    for (const mode of ["stale", "unauthorized", "uncertain"]) {
      currentHead = headSha;
      enabled = true;
      prior = "pending";
      config.allowedRepositories.add("owner/test");
      const target: ReviewJob = {
        ...job,
        jobType: "REPLY_HANDLE",
        findingId: stored.id,
        sourceCommentId: 12,
        rootCommentId: 11,
        humanReplyBody: "fixed",
      };
      const processor = createReplyProcessor(
        config,
        database,
        memories,
        github,
        async (_config, _root, _input, binding) => {
          replyCalls++;
          if (mode === "stale") currentHead = "c".repeat(40);
          if (mode === "unauthorized") config.allowedRepositories.delete("owner/test");
          return {
            text: "",
            durationMs: 1,
            model: "test",
            usage: emptyUsage(),
            result: {
              findingId: stored.id,
              analysisHeadSha: binding.headSha,
              conclusion: "FIXED",
              summary: "fixed",
              evidence: [{ path: "src/a.ts", detail: "current code" }],
              memoryReferences: [],
              suggestedFindingStatus: "FIXED",
              limitations: [],
            },
          };
        },
      );
      if (mode === "stale") {
        await processor(target);
        assert.equal(target.status, "queued");
        assert.equal(replyPosts, 0);
      } else if (mode === "unauthorized") {
        await processor(target);
        assert.equal(target.status, "cancelled");
        assert.equal(replyPosts, 0);
      } else {
        await assert.rejects(processor(target), /network/);
        assert.equal(target.status, "uncertain");
        assert.equal(prior, "uncertain");
        const count = replyCalls;
        await assert.rejects(processor(target), /待核对/);
        assert.equal(replyCalls, count);
        assert.equal(replyPosts, 1);
      }
    }
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("发布结果不明时先查 GitHub：已创建就记为已发布，确认未创建才允许重试，网络中断查不到则停下", async () => {
  const config = { allowedRepositories: new Set(["owner/test"]) } as Config;
  const headSha = "h".repeat(40);
  const job = {
    id: "job",
    deliveryId: "d",
    repositoryId: 1,
    installationId: 1,
    repository: "owner/test",
    prNumber: 2,
    cloneUrl: "",
    baseSha: "b".repeat(40),
    headSha,
    title: "",
    body: "",
    status: "running",
  } satisfies ReviewJob;
  const review = {
    result: { summary: "", findings: [], coverage: [], limitations: [] },
    model: "test",
    durationMs: 1,
    usage: emptyUsage(),
  };
  type Scenario = {
    prior?: { status: string; inserted: boolean };
    createError?: Error;
    remoteHasReview?: boolean;
    listError?: boolean;
  };
  async function run(scenario: Scenario) {
    let fingerprint = "",
      posts = 0,
      lists = 0;
    const statuses: string[] = [];
    const github = {
      getPullRequest: async () => ({ state: "open", draft: false, head: { sha: headSha } }),
      createReview: async () => {
        posts++;
        if (scenario.createError) throw scenario.createError;
        return { id: 7, html_url: "https://example/review/7" };
      },
      getReviews: async () => {
        lists++;
        if (scenario.listError) throw new Error("fetch failed");
        return scenario.remoteHasReview
          ? [
              {
                id: 5,
                html_url: "https://example/review/5",
                commit_id: headSha,
                body: `## Pi Review\n\n<!-- pi-review:${fingerprint} -->`,
              },
            ]
          : [];
      },
    } as unknown as GitHubClient;
    const store: PublicationStore = {
      beginPublication: async (_job, value) => {
        fingerprint = value;
        return scenario.prior ?? { status: "pending", inserted: true };
      },
      finishPublication: async (_job, status) => {
        statuses.push(status);
      },
    };
    const target: ReviewJob = { ...job };
    const error = await publishReview(
      config,
      github,
      store,
      target,
      "token",
      new AbortController(),
      review,
      [],
      review.result,
    ).then(
      () => undefined,
      (value: Error) => value,
    );
    return { target, statuses, posts, lists, error };
  }

  const networkFoundRemote = await run({ createError: new Error("fetch failed"), remoteHasReview: true });
  assert.deepEqual(networkFoundRemote.statuses, ["published"]);
  assert.equal(networkFoundRemote.target.reviewId, 5);
  assert.equal(networkFoundRemote.error, undefined);

  const badGatewayNotCreated = await run({ createError: new GitHubApiError("/reviews", 502) });
  assert.deepEqual(badGatewayNotCreated.statuses, ["failed"]);
  assert.notEqual(badGatewayNotCreated.target.status, "uncertain");

  const networkNotFound = await run({ createError: new Error("fetch failed") });
  assert.deepEqual(networkNotFound.statuses, ["uncertain"]);
  assert.equal(networkNotFound.target.status, "uncertain");

  const lookupFails = await run({ createError: new GitHubApiError("/reviews", 502), listError: true });
  assert.deepEqual(lookupFails.statuses, ["uncertain"]);

  const rejected = await run({ createError: new GitHubApiError("/reviews", 422) });
  assert.deepEqual(rejected.statuses, ["failed"]);
  assert.equal(rejected.lists, 0);

  const interruptedButCreated = await run({ prior: { status: "pending", inserted: false }, remoteHasReview: true });
  assert.equal(interruptedButCreated.posts, 0);
  assert.deepEqual(interruptedButCreated.statuses, ["published"]);

  const interruptedNotCreated = await run({ prior: { status: "pending", inserted: false } });
  assert.equal(interruptedNotCreated.posts, 1);
  assert.deepEqual(interruptedNotCreated.statuses, ["published"]);

  const fresh = await run({});
  assert.equal(fresh.lists, 0, "首次发布不额外查询 GitHub");
  assert.equal(fresh.posts, 1);
});
