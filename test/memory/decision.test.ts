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
import type { MemoryService } from "../../src/memory/memory.service.js";

const exec = promisify(execFile);
const memories = { retrieveForReview: async () => ({ memories: [], total: 0 }) } as unknown as MemoryService;

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
    new Set(),
    new Set([11]),
    new Set(["backend/x/dto/A.java"]),
  );
  assert.equal(result.proposals[0]?.title, proposal.title);
  assert.deepEqual(result.discarded, []);
});

test("无决定允许空结果，非数组或无效 JSON 仍整体报错", () => {
  assert.deepEqual(parseDecisionProposals("[]", job, new Set()), { proposals: [], discarded: [] });
  assert.throws(() => parseDecisionProposals("{}", job, new Set()), /输出必须是数组/);
  assert.throws(() => parseDecisionProposals("invalid JSON", job, new Set()));
});

test("结构错误只丢弃该条并指出具体字段", () => {
  const result = parseDecisionProposals(
    JSON.stringify([{ ...proposal, source: { ...proposal.source, commitSha: "wrong" } }, proposal]),
    job,
    new Set(),
  );
  assert.deepEqual(result.proposals, [proposal]);
  assert.deepEqual(result.discarded, [{ index: 0, reason: "invalid_structure", fields: ["source.commitSha"] }]);
});

test("争议或无有效人类证据不能伪装为决定", () => {
  assert.deepEqual(
    parseDecisionProposals(
      JSON.stringify([{ ...proposal, source: { ...proposal.source, commentIds: [99] } }]),
      job,
      new Set(),
      new Set([11]),
      new Set(["backend/x/dto/A.java"]),
    ).discarded,
    [{ index: 0, reason: "invalid_human_comment" }],
  );
  assert.deepEqual(
    parseDecisionProposals(
      JSON.stringify([{ ...proposal, evidence: proposal.evidence.filter((e) => e.kind === "code") }]),
      job,
      new Set(),
    ).discarded,
    [{ index: 0, reason: "missing_evidence" }],
  );
});

test("人类证据必须对得上真实人类评论：commentIds 非空，human_comment 的 reference 是人类评论 id", () => {
  const parse = (value: DecisionProposal) =>
    parseDecisionProposals(
      JSON.stringify([value]),
      job,
      new Set(),
      new Set([11, 12]),
      new Set(["backend/x/dto/A.java"]),
    );
  assert.deepEqual(parse({ ...proposal, source: { ...proposal.source, commentIds: [] } }).discarded[0]?.fields, [
    "source.commentIds",
  ]);
  assert.deepEqual(
    parse({ ...proposal, source: { ...proposal.source, commentIds: ["11"] as unknown as number[] } }).discarded[0]
      ?.fields,
    ["source.commentIds"],
  );
  const human = (reference: string) => ({
    ...proposal,
    evidence: [{ kind: "human_comment" as const, reference, detail: "d" }, proposal.evidence[1]!],
  });
  for (const reference of ["99", "维护者在评论里同意", "11 和 12"]) {
    assert.deepEqual(parse(human(reference)).discarded, [{ index: 0, reason: "invalid_human_evidence" }]);
  }
  assert.equal(parse(human(" 12 ")).proposals[0]?.title, proposal.title, "去掉首尾空白后是人类评论 id 即通过");
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
    parseDecisionProposals(JSON.stringify([exception]), job, new Set([exception.relation.exceptionTo])).proposals[0]
      ?.relation?.exceptionTo,
    exception.relation.exceptionTo,
  );
  assert.equal(
    parseDecisionProposals(JSON.stringify([superseding]), job, new Set([superseding.relation.supersedes])).proposals[0]
      ?.relation?.supersedes,
    superseding.relation.supersedes,
  );
  assert.equal(
    proposalFingerprint(2, proposal),
    proposalFingerprint(2, { ...proposal, source: { ...proposal.source, commentIds: [11] } }),
  );
  assert.equal(proposalFingerprint(2, proposal), proposalFingerprint(2, superseding), "relation 不参与去重指纹");
  const unlinked = { ...exception, relation: undefined };
  assert.equal(parseDecisionProposals(JSON.stringify([unlinked]), job, new Set()).proposals[0]?.type, "exception");
});

test("写在顶层的关系字段移进 relation，再按提供的规则校验", () => {
  const result = parseDecisionProposals(
    JSON.stringify([
      { ...proposal, exceptionTo: "known" },
      { ...proposal, supersedes: "known", relation: { conflictsWith: ["known"] } },
      { ...proposal, exceptionTo: "other", relation: { exceptionTo: "known" } },
      { ...proposal, exceptionTo: null },
      { ...proposal, exceptionTo: "unknown" },
      { ...proposal, duplicateOf: "known" },
    ]),
    job,
    new Set(["known"]),
  );
  assert.deepEqual(result.proposals, [
    { ...proposal, relation: { exceptionTo: "known" } },
    { ...proposal, relation: { conflictsWith: ["known"], supersedes: "known" } },
    { ...proposal, relation: { exceptionTo: "known" } },
    proposal,
  ]);
  assert.deepEqual(
    result.discarded.map(({ index, reason }) => [index, reason]),
    [
      [4, "unknown_rule"],
      [5, "duplicate_relation"],
    ],
  );
});

test("relation 只能引用提供的规则，duplicateOf 候选逐条丢弃", () => {
  const relations = [
    { supersedes: "unknown" },
    { exceptionTo: "unknown" },
    { conflictsWith: ["known", "unknown"] },
    { duplicateOf: "known" },
    { conflictsWith: ["known"] },
  ];
  const result = parseDecisionProposals(
    JSON.stringify(relations.map((relation) => ({ ...proposal, relation }))),
    job,
    new Set(["known"]),
  );
  assert.deepEqual(result.proposals, [{ ...proposal, relation: { conflictsWith: ["known"] } }]);
  assert.deepEqual(
    result.discarded.map(({ reason }) => reason),
    ["unknown_rule", "unknown_rule", "unknown_rule", "duplicate_relation"],
  );
});

test("可选字段的 null 等价于未提供，合格候选保留且不带 null", () => {
  const result = parseDecisionProposals(
    JSON.stringify([
      { ...proposal, relation: null },
      { ...proposal, relation: { supersedes: null, exceptionTo: null, conflictsWith: null, duplicateOf: null } },
      { ...proposal, scope: { paths: ["a/**"], modules: null } },
      { ...proposal, scope: { paths: null, languages: null, modules: null, conditions: null } },
      {
        ...proposal,
        relation: { supersedes: "known", exceptionTo: null, conflictsWith: ["known"], duplicateOf: null },
      },
      { ...proposal, relation: { duplicateOf: null } },
    ]),
    job,
    new Set(["known"]),
    new Set([11]),
    new Set(["backend/x/dto/A.java"]),
  );
  assert.deepEqual(result.discarded, []);
  assert.deepEqual(result.proposals, [
    proposal,
    { ...proposal, relation: {} },
    { ...proposal, scope: { paths: ["a/**"] } },
    { ...proposal, scope: {} },
    { ...proposal, relation: { supersedes: "known", conflictsWith: ["known"] } },
    { ...proposal, relation: {} },
  ]);
});

test("畸形候选和代码证据不打断后续候选校验", () => {
  const invalid = [
    null,
    [],
    "rule",
    1,
    { ...proposal, evidence: [null] },
    { ...proposal, evidence: [{ kind: "code", reference: 1, detail: "bad" }] },
    { ...proposal, scope: { paths: "backend/**" } },
    { ...proposal, uncertainties: [null] },
    ...["id", [], { conflictsWith: "id" }, { supersedes: 1 }, { exceptionTo: ["id"] }].map((relation) => ({
      ...proposal,
      relation,
    })),
  ];
  const result = parseDecisionProposals(
    JSON.stringify([
      ...invalid,
      {
        ...proposal,
        evidence: [proposal.evidence[0], { kind: "code", reference: "other.ts:1", detail: "wrong path" }],
      },
      proposal,
    ]),
    job,
    new Set(),
    new Set([11]),
    new Set(["backend/x/dto/A.java"]),
  );
  assert.deepEqual(result.proposals, [proposal]);
  assert.equal(result.discarded.length, invalid.length + 1);
  assert.ok(result.discarded.slice(0, -1).every(({ reason }) => reason === "invalid_structure"));
  assert.equal(result.discarded.at(-1)?.reason, "invalid_code_evidence");
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
    await createDecisionProcessor(config, database, memories, github, async (input) => {
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
      createDecisionProcessor(config, database, memories, github, async () => {
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
    const outcome = await createDecisionProcessor(config, database, memories, github, async () => {
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
