import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDecisionProcessor,
  parseDecisionProposals,
  proposalFingerprint,
} from "../../src/memory/decision.processor.js";
import { emptyUsage, TimeoutError } from "../../src/review/agent.js";
import type { PiSessionInput } from "../../src/pi/session.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { Database } from "../../src/persistence/database.js";
import type { Config } from "../../src/config/config.js";
import type { DecisionProposal } from "../../src/memory/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const exec = promisify(execFile);

const job = {
  id: "job",
  deliveryId: "delivery",
  jobType: "DECISION_EXTRACT",
  installationId: 1,
  repositoryId: 2,
  repository: "owner/repo",
  cloneUrl: "url",
  prNumber: 3,
  title: "",
  body: "",
  baseSha: "base",
  headSha: "merged",
  status: "running",
} satisfies ReviewJob;
const proposal: DecisionProposal = {
  type: "engineering_rule",
  title: "No Optional DTO",
  content: "Public DTO fields do not use Optional.",
  rationale: "Stable serialization contract.",
  scope: { paths: ["backend/**/dto/**"], languages: ["java"] },
  source: { pullRequestNumber: 3, commitSha: "merged", commentIds: [11] },
  evidence: [
    { kind: "human_comment", reference: "11", detail: "maintainer decision" },
    { kind: "code", reference: "backend/x/dto/A.java:4", detail: "field changed" },
  ],
  confidence: 0.9,
  uncertainties: [],
};

test("明确规则通过归属与双证据校验", () => {
  const result = parseDecisionProposals(
    JSON.stringify([proposal]),
    job,
    new Set([11]),
    new Set(["backend/x/dto/A.java"]),
  );
  assert.equal(result[0]?.title, proposal.title);
});

test("无决定允许空结果", () => assert.deepEqual(parseDecisionProposals("[]", job), []));

test("结构错误指出具体字段", () =>
  assert.throws(
    () =>
      parseDecisionProposals(
        JSON.stringify([{ ...proposal, source: { ...proposal.source, commitSha: "wrong" } }]),
        job,
      ),
    /source\.commitSha/,
  ));

test("争议或无有效人类证据不能伪装为决定", () => {
  assert.throws(
    () =>
      parseDecisionProposals(
        JSON.stringify([{ ...proposal, source: { ...proposal.source, commentIds: [99] } }]),
        job,
        new Set([11]),
        new Set(["backend/x/dto/A.java"]),
      ),
    /无效人类评论/,
  );
  assert.throws(
    () =>
      parseDecisionProposals(
        JSON.stringify([{ ...proposal, evidence: proposal.evidence.filter((e) => e.kind === "code") }]),
        job,
      ),
    /缺少人类讨论/,
  );
});

test("人类证据必须对得上真实人类评论：commentIds 非空，human_comment 的 reference 是人类评论 id", () => {
  const parse = (value: DecisionProposal) =>
    parseDecisionProposals(JSON.stringify([value]), job, new Set([11, 12]), new Set(["backend/x/dto/A.java"]));
  assert.throws(() => parse({ ...proposal, source: { ...proposal.source, commentIds: [] } }), /source\.commentIds/);
  assert.throws(
    () => parse({ ...proposal, source: { ...proposal.source, commentIds: ["11"] as unknown as number[] } }),
    /source\.commentIds/,
  );
  const human = (reference: string) => ({
    ...proposal,
    evidence: [{ kind: "human_comment" as const, reference, detail: "d" }, proposal.evidence[1]!],
  });
  assert.throws(() => parse(human("99")), /人类讨论证据引用了无效评论/, "不是真实人类评论 id");
  assert.throws(() => parse(human("维护者在评论里同意")), /人类讨论证据引用了无效评论/, "不是数字");
  assert.throws(() => parse(human("11 和 12")), /人类讨论证据引用了无效评论/);
  assert.equal(parse(human(" 12 "))[0]?.title, proposal.title, "去掉首尾空白后是人类评论 id 即通过");
});

test("局部例外与替代关系保留，指纹稳定", () => {
  const exception = {
    ...proposal,
    type: "exception" as const,
    scope: { paths: ["legacy/**"] },
    relation: { exceptionTo: "11111111-1111-1111-1111-111111111111" },
  };
  const superseding = { ...proposal, relation: { supersedes: "22222222-2222-2222-2222-222222222222" } };
  assert.equal(
    parseDecisionProposals(JSON.stringify([exception]), job)[0]?.relation?.exceptionTo,
    exception.relation.exceptionTo,
  );
  assert.equal(
    parseDecisionProposals(JSON.stringify([superseding]), job)[0]?.relation?.supersedes,
    superseding.relation.supersedes,
  );
  assert.equal(
    proposalFingerprint(2, proposal),
    proposalFingerprint(2, { ...proposal, source: { ...proposal.source, commentIds: [11] } }),
  );
});

test("Decision Extractor 走统一会话入口：有人类讨论时照常运行，使用仓库预算、只给只读工具，超时记为 timeout", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-decision-test-"));
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(source, "a.ts"), "export const a = 1;\n");
    await git("add", "a.ts");
    await git("commit", "-qm", "merge");
    const headSha = await git("rev-parse", "HEAD");
    const github = {
      installationToken: async () => "token",
      getPullRequest: async () => ({ merged: true, merge_commit_sha: headSha, title: "t", body: "" }),
      getFiles: async () => [],
      getConversationComments: async () => [
        { id: 11, html_url: "u", body: "以后 DTO 字段都不用 Optional", user: { login: "maintainer", type: "User" } },
      ],
      getReviews: async () => [],
      getReviewComments: async () => [],
    } as unknown as GitHubClient;
    const inserted: unknown[] = [];
    const database = {
      getDecisionClues: async () => [],
      getRepositoryConfig: async () => ({ budgetTokens: 1234 }),
      insertCandidates: async (_job: unknown, proposals: unknown[]) => {
        inserted.push(proposals);
      },
    } as unknown as Database;
    const config = { modelProvider: "p", modelName: "m", modelApiKey: "k", agentTimeoutMs: 1000 } as Config;
    const target = {
      id: "job",
      deliveryId: "d",
      repositoryId: 1,
      installationId: 1,
      repository: "o/r",
      prNumber: 3,
      cloneUrl: source,
      baseSha: headSha,
      headSha,
      title: "",
      body: "",
      status: "running",
    } as ReviewJob;
    let received: PiSessionInput | undefined;
    await createDecisionProcessor(config, database, github, async (input) => {
      received = input;
      return { text: "[]", durationMs: 1, model: "m", usage: emptyUsage() };
    })(target);
    assert.equal(received?.budgetTokens, 1234);
    assert.equal(received?.builtinTools, undefined, "默认只读：Pi 的读取、搜索和 bash");
    assert.equal(received?.bridge, undefined, "不能写入文件");
    assert.match(String(received?.systemPrompt), /Decision Extractor/);
    assert.deepEqual(inserted, [[]]);
    const timedOut = { ...target };
    await assert.rejects(
      createDecisionProcessor(config, database, github, async () => {
        throw new TimeoutError();
      })(timedOut),
    );
    assert.equal(timedOut.status, "timeout");
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("没有正文非空的人类讨论时不跑规则抽取：不启动 Agent、不写候选，任务照常结束", async () => {
  const comment = (id: number, body: string | null, type: string) => ({
    id,
    html_url: `https://example/${id}`,
    body,
    user: { login: type === "Bot" ? "ci[bot]" : "maintainer", type },
  });
  const run = async (discussion: { comments?: unknown[]; reviews?: unknown[]; reviewComments?: unknown[] }) => {
    const github = {
      installationToken: async () => "token",
      getPullRequest: async () => ({ merged: true, merge_commit_sha: "merged", title: "t", body: "" }),
      getFiles: async () => [],
      getConversationComments: async () => discussion.comments ?? [],
      getReviews: async () => discussion.reviews ?? [],
      getReviewComments: async () => discussion.reviewComments ?? [],
    } as unknown as GitHubClient;
    let executed = 0,
      inserted = 0;
    const database = {
      getDecisionClues: async () => [],
      getRepositoryConfig: async () => undefined,
      insertCandidates: async () => {
        inserted++;
      },
    } as unknown as Database;
    const config = { modelProvider: "p", modelName: "m", modelApiKey: "k", agentTimeoutMs: 1000 } as Config;
    // 工作区地址无效：一旦走到建工作区就会报错。
    const target = { ...job, cloneUrl: join(tmpdir(), "no-such-decision-repo") } as ReviewJob;
    const outcome = await createDecisionProcessor(config, database, github, async () => {
      executed++;
      return { text: "[]", durationMs: 1, model: "m", usage: emptyUsage() };
    })(target).then(
      () => "ok",
      (error: Error) => error.message,
    );
    return { outcome, executed, inserted, status: target.status };
  };
  for (const discussion of [
    { comments: [comment(1, "CI passed", "Bot")] },
    { reviews: [comment(2, "", "User"), comment(3, null, "User")], reviewComments: [comment(4, "  \n", "User")] },
  ]) {
    const result = await run(discussion);
    assert.deepEqual(result, { outcome: "ok", executed: 0, inserted: 0, status: "running" });
  }
  // 有正文非空的人类评论时流程照旧，见上面"走统一会话入口"的用例。
});
