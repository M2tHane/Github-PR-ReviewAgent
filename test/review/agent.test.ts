import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentReview, type AgentReviewInput, type AgentUsage } from "../../src/review/agent.js";
import type { MemoryRecord } from "../../src/memory/types.js";
import { startFakeModel, type FakeReply } from "../helpers/fake-model.js";

const finding = (path: string) => ({
  path,
  category: "correctness",
  severity: "medium",
  evidenceLevel: "strong",
  description: "d",
  evidence: "e",
  impact: "i",
});
const output = (findings: object[]) =>
  JSON.stringify({
    summary: "",
    findings,
    coverage: [],
    limitations: [],
    findingGroups: findings.map((_, index) => [index]),
    issueDisplays: findings.map(() => ({ title: "t", reason: "r", fix: "f" })),
  });
const lastUserText = (body: Record<string, any>) => {
  const message = [...body.messages].reverse().find((item: { role: string }) => item.role === "user");
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part: { text?: string }) => part.text ?? "").join("");
};

async function review(t: test.TestContext, script: FakeReply[], extra: Partial<AgentReviewInput> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-review-agent-test-"));
  const model = await startFakeModel(script);
  t.after(async () => {
    await model.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    root,
    provider: "review-test",
    modelName: "test-model",
    apiKey: "real-model-key",
    endpoint: { api: "openai-completions", baseUrl: model.baseUrl },
    timeoutMs: 20_000,
    title: "t",
    body: "",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }],
    // 测试不建 codegraph 索引；runAgentReview 把其余字段原样交给会话。
    codegraph: false,
    ...extra,
  } as AgentReviewInput;
  return { model, run: () => runAgentReview(input) };
}

test("Review 输出无效 JSON 时在同一会话修一次，第二次有效就得到结果", async (t) => {
  const { model, run } = await review(t, [{ text: "不是 JSON" }, { text: output([finding("src/a.ts")]) }]);
  const result = await run();
  assert.equal(result.result.findings.length, 1);
  assert.equal(model.requests.length, 2);
  const repair = lastUserText(model.requests[1]!.body);
  assert.match(repair, /没有通过服务校验/);
  assert.match(repair, /不是合法 JSON/);
  assert.match(repair, /重新输出完整的 JSON 对象/);
});

test("意见路径不属于 PR 时要求修正，改正后正常通过", async (t) => {
  const { model, run } = await review(t, [
    { text: output([finding("src/other.ts")]) },
    { text: output([finding("src/a.ts")]) },
  ]);
  const result = await run();
  assert.equal(result.result.findings[0]!.path, "src/a.ts");
  assert.equal(model.requests.length, 2);
  assert.match(lastUserText(model.requests[1]!.body), /finding 路径不属于 PR: src\/other\.ts/);
});

test("修过一次仍是无效 JSON：照旧抛错，错误上带两轮的 usage", async (t) => {
  const { model, run } = await review(t, [{ text: "不是 JSON" }, { text: "还是不是" }, { text: output([]) }]);
  const error = await run().catch((caught) => caught);
  assert.match(String(error), /不是合法 JSON/);
  assert.equal((error as Error & { usage: AgentUsage }).usage.totalTokens, 240);
  assert.equal(model.requests.length, 2, "每个会话最多修 1 次");
});

test("第一次输出有效时不追加提问；发给模型的团队规则只带判断需要的字段", async (t) => {
  const memory = {
    id: "memory-1",
    version: 2,
    repositoryId: 1,
    installationId: 1,
    type: "coding_convention",
    title: "规则标题",
    content: "规则正文",
    rationale: "规则理由",
    scope: { paths: ["src/**"] },
    source: { pullRequestNumber: 3, commitSha: "c", commentIds: [7] },
    evidence: [{ kind: "human_comment", reference: "7", detail: "评论原文" }],
    confidence: 0.9,
    uncertainties: ["不确定项"],
    status: "ACTIVE",
    approvedBy: 9,
    approvedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as MemoryRecord;
  const { model, run } = await review(t, [{ text: output([]) }], { memories: [memory] });
  const result = await run();
  assert.deepEqual(result.result.findings, []);
  assert.equal(model.requests.length, 1);
  const prompt = JSON.parse(lastUserText(model.requests[0]!.body));
  assert.deepEqual(prompt.activeTeamMemories, [
    {
      id: "memory-1",
      version: 2,
      type: "coding_convention",
      title: "规则标题",
      content: "规则正文",
      rationale: "规则理由",
      scope: { paths: ["src/**"] },
      source: { pullRequestNumber: 3, commitSha: "c", commentIds: [7] },
    },
  ]);
});
