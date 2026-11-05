import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionProcessor, parseDecisionProposals, proposalFingerprint } from "../../src/memory/decision.processor.js";
import { emptyUsage, TimeoutError } from "../../src/review/agent.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { Database } from "../../src/persistence/database.js";
import type { Config } from "../../src/config/config.js";
import type { DecisionProposal } from "../../src/memory/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const exec = promisify(execFile);

const job = { id: "job", deliveryId: "delivery", jobType: "DECISION_EXTRACT", installationId: 1, repositoryId: 2, repository: "owner/repo", cloneUrl: "url", prNumber: 3, title: "", body: "", baseSha: "base", headSha: "merged", status: "running" } satisfies ReviewJob;
const proposal: DecisionProposal = {
  type: "engineering_rule", title: "No Optional DTO", content: "Public DTO fields do not use Optional.", rationale: "Stable serialization contract.", scope: { paths: ["backend/**/dto/**"], languages: ["java"] },
  source: { pullRequestNumber: 3, commitSha: "merged", commentIds: [11] }, evidence: [{ kind: "human_comment", reference: "11", detail: "maintainer decision" }, { kind: "code", reference: "backend/x/dto/A.java:4", detail: "field changed" }], confidence: 0.9, uncertainties: [],
};

test("明确规则通过归属与双证据校验", () => {
  const result = parseDecisionProposals(JSON.stringify([proposal]), job, new Set([11]), new Set(["backend/x/dto/A.java"]));
  assert.equal(result[0]?.title, proposal.title);
});

test("无决定允许空结果", () => assert.deepEqual(parseDecisionProposals("[]", job), []));

test("结构错误指出具体字段", () => assert.throws(() => parseDecisionProposals(JSON.stringify([{ ...proposal, source: { ...proposal.source, commitSha: "wrong" } }]), job), /source\.commitSha/));

test("争议或无有效人类证据不能伪装为决定", () => {
  assert.throws(() => parseDecisionProposals(JSON.stringify([{ ...proposal, source: { ...proposal.source, commentIds: [99] } }]), job, new Set([11]), new Set(["backend/x/dto/A.java"])), /无效人类评论/);
  assert.throws(() => parseDecisionProposals(JSON.stringify([{ ...proposal, evidence: proposal.evidence.filter((e) => e.kind === "code") }]), job), /缺少人类讨论/);
});

test("局部例外与替代关系保留，指纹稳定", () => {
  const exception = { ...proposal, type: "exception" as const, scope: { paths: ["legacy/**"] }, relation: { exceptionTo: "11111111-1111-1111-1111-111111111111" } };
  const superseding = { ...proposal, relation: { supersedes: "22222222-2222-2222-2222-222222222222" } };
  assert.equal(parseDecisionProposals(JSON.stringify([exception]), job)[0]?.relation?.exceptionTo, exception.relation.exceptionTo);
  assert.equal(parseDecisionProposals(JSON.stringify([superseding]), job)[0]?.relation?.supersedes, superseding.relation.supersedes);
  assert.equal(proposalFingerprint(2, proposal), proposalFingerprint(2, { ...proposal, source: { ...proposal.source, commentIds: [11] } }));
});

test("Decision Extractor 走统一会话入口：使用仓库预算、只给只读工具，超时记为 timeout", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-decision-test-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
  try {
    await git("init", "-q"); await git("config", "user.name", "test"); await git("config", "user.email", "test@example.invalid");
    await writeFile(join(source, "a.ts"), "export const a = 1;\n"); await git("add", "a.ts"); await git("commit", "-qm", "merge");
    const headSha = await git("rev-parse", "HEAD");
    const github = {
      installationToken: async () => "token",
      getPullRequest: async () => ({ merged: true, merge_commit_sha: headSha, title: "t", body: "" }),
      getFiles: async () => [], getConversationComments: async () => [], getReviews: async () => [], getReviewComments: async () => [],
    } as unknown as GitHubClient;
    const inserted: unknown[] = [];
    const database = {
      getDecisionClues: async () => [], getRepositoryConfig: async () => ({ budgetTokens: 1234 }),
      insertCandidates: async (_job: unknown, proposals: unknown[]) => { inserted.push(proposals); },
    } as unknown as Database;
    const config = { modelProvider: "p", modelName: "m", modelApiKey: "k", agentTimeoutMs: 1000 } as Config;
    const target = { id: "job", deliveryId: "d", repositoryId: 1, installationId: 1, repository: "o/r", prNumber: 3, cloneUrl: source, baseSha: headSha, headSha, title: "", body: "", status: "running" } as ReviewJob;
    let received: Record<string, unknown> | undefined;
    await createDecisionProcessor(config, database, github, async (input) => { received = input; return { text: "[]", durationMs: 1, model: "m", usage: emptyUsage() }; })(target);
    assert.equal(received?.budgetTokens, 1234);
    assert.equal(received?.tools, undefined, "默认只有 read_file / search_text");
    assert.match(String(received?.systemPrompt), /Decision Extractor/);
    assert.deepEqual(inserted, [[]]);
    const timedOut = { ...target };
    await assert.rejects(createDecisionProcessor(config, database, github, async () => { throw new TimeoutError(); })(timedOut));
    assert.equal(timedOut.status, "timeout");
  } finally { await rm(source, { recursive: true, force: true }); }
});
