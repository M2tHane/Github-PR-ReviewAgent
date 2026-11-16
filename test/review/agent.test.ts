import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { READ_ONLY_TOOLS } from "../../src/pi/session.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_PROMPT,
  REVIEW_SKILLS,
  runAgentSession,
  runAgentReview,
  parseReviewResult,
  type AgentReviewInput,
  type AgentUsage,
} from "../../src/review/agent.js";
import { compileMemoryContext } from "../../src/memory/context.js";
import type { MemoryRecord } from "../../src/memory/types.js";
import { startFakeModel, lastToolResult, type FakeReply } from "../helpers/fake-model.js";

const finding = (path: string) => ({
  path,
  category: "correctness",
  severity: "medium",
  evidenceLevel: "strong",
  description: "d",
  evidence: "e",
  impact: "i",
});
const output = (findings: object[], extra: object = {}) =>
  JSON.stringify({
    summary: "",
    findings,
    coverage: [],
    limitations: [],
    findingGroups: findings.map((_, index) => [index]),
    issueDisplays: findings.map(() => ({ title: "t", reason: "r", fix: "f" })),
    ...extra,
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
  return { model, input, run: () => runAgentReview(input) };
}

test("无索引、无 must 时系统提示、工具和任务 JSON 与改前逐字相同", async (t) => {
  // f3ce238 中 REVIEW_PROMPT 的原文字节摘要；防止把新增说明无条件塞回常量。
  assert.equal(
    createHash("sha256").update(REVIEW_PROMPT).digest("hex"),
    "239043580721c03151a27009bd46e5378b2770a09ef99f4f2c4b6cfc12ff12d5",
  );
  for (const teamRuleIndex of [undefined, []]) {
    const { model, input, run } = await review(t, [{ text: output([]) }, { text: output([]) }], { teamRuleIndex });
    // 改前的会话参数；同一工作区运行，比较实际送到 Provider 的内容。
    await runAgentSession({
      ...input,
      systemPrompt: REVIEW_PROMPT,
      builtinTools: READ_ONLY_TOOLS,
      skills: REVIEW_SKILLS,
      prompt: {
        task: "审查此 PR",
        outputLanguage: "zh-CN",
        title: input.title,
        body: input.body,
        baseSha: input.baseSha,
        headSha: input.headSha,
        changedFiles: input.changedFiles,
        activeTeamMemories: [],
        ruleHits: [],
        previousFindings: [],
      },
    });
    await run();
    const before = model.requests[0]!.body;
    const after = model.requests[1]!.body;
    assert.equal(after.messages[0].content, before.messages[0].content);
    assert.deepEqual(after.tools, before.tools);
    assert.equal(lastUserText(after), lastUserText(before));
    assert(!after.tools.some((tool: any) => tool.function.name === "read_team_rule"));
    assert(!lastUserText(after).includes("teamRuleIndex"));
  }
});

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
    level: "info",
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
      level: "info",
      type: "coding_convention",
      title: "规则标题",
      content: "规则正文",
      rationale: "规则理由",
      scope: { paths: ["src/**"] },
      source: { pullRequestNumber: 3, commitSha: "c", commentIds: [7] },
    },
  ]);
});

const rule = (id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id,
  version: 2,
  repositoryId: 1,
  installationId: 1,
  level: "should",
  type: "engineering_rule",
  title: `规则 ${id}`,
  content: "正文",
  rationale: "理由",
  scope: { paths: ["src/**"] },
  source: { pullRequestNumber: 1, commitSha: "c", commentIds: [2] },
  status: "ACTIVE",
  evidence: [],
  confidence: 1,
  uncertainties: [],
  createdAt: "",
  updatedAt: "",
  ...extra,
});
const referenced = (memory: MemoryRecord) => ({
  ...finding("src/a.ts"),
  category: "team_rule",
  memory: { id: memory.id, version: memory.version, source: memory.source },
});

test("超上限规则出现在索引；读取全文后可以引用，同一 id 重读只装载一次", async (t) => {
  const indexed = rule("indexed", { content: "x".repeat(30_001) });
  const full = rule("full", { level: "must" });
  const context = compileMemoryContext([full, indexed], { paths: ["src/a.ts"], text: "" });
  let loads = 0;
  const checks = [{ id: full.id, version: full.version, result: "followed" }];
  const { model, run } = await review(
    t,
    [
      { toolCalls: [{ name: "read_team_rule", args: { id: indexed.id } }] },
      { toolCalls: [{ name: "read_team_rule", args: { id: indexed.id } }] },
      { text: output([referenced(indexed)], { ruleChecks: checks }) },
    ],
    {
      memories: context.full,
      teamRuleIndex: context.index,
      readTeamRule: async (id) => {
        assert.equal(id, indexed.id);
        loads++;
        return indexed;
      },
    },
  );
  const result = await run();
  assert.equal(model.requests.length, 3, "已读取引用不触发修复轮");
  assert.equal(loads, 1);
  assert.equal(result.result.findings[0]!.memory!.id, indexed.id);
  assert.deepEqual(result.result.ruleChecks, checks);
  const prompt = JSON.parse(lastUserText(model.requests[0]!.body));
  assert.deepEqual(prompt.teamRuleIndex, context.index);
  assert(!JSON.stringify(prompt).includes(indexed.content));
  const text = JSON.parse(lastToolResult(model.requests[1]!)!);
  assert.deepEqual(Object.keys(text).sort(), Object.keys(prompt.activeTeamMemories[0]).sort());
  assert.equal(text.content, indexed.content);
  assert.equal(text.version, indexed.version);
});

test("未读索引的引用被要求修复；索引以外的 id 和变更的版本不能读取", async (t) => {
  const indexed = rule("indexed");
  const { id, version, title, level, scope } = indexed;
  let loads = 0;
  const { model, run } = await review(
    t,
    [
      { toolCalls: [{ name: "read_team_rule", args: { id: "other-repository" } }] },
      { toolCalls: [{ name: "read_team_rule", args: { id } }] },
      { text: output([referenced(indexed)]) },
      { text: output([]) },
    ],
    {
      teamRuleIndex: [{ id, version, title, level, scope }],
      readTeamRule: async () => {
        loads++;
        return { ...indexed, version: version + 1 };
      },
    },
  );
  const result = await run();
  const system = model.requests[0]!.body.messages[0].content;
  assert(system.includes("teamRuleIndex"));
  assert(!system.includes("ruleChecks"), "索引不启用 must 输出要求");
  assert.equal(loads, 1, "越界 id 不查询正文");
  assert.match(lastToolResult(model.requests[1]!)!, /不在本次 teamRuleIndex/);
  assert.match(lastToolResult(model.requests[2]!)!, /版本已不可读取/);
  assert.match(lastUserText(model.requests[3]!.body), /引用了未提供的团队规则/);
  assert.deepEqual(result.result.findings, []);
});

test("缺 must 结论修一次；仍缺则记录 limitation、未确认清单与日志", async (t) => {
  const must = rule("required", { level: "must" });
  const logs = t.mock.method(console, "info", () => undefined);
  const { model, run } = await review(t, [{ text: output([]) }, { text: output([]) }], { memories: [must] });
  const result = await run();
  assert(model.requests[0]!.body.messages[0].content.includes("ruleChecks"));
  assert(!model.requests[0]!.body.messages[0].content.includes("teamRuleIndex"));
  assert(!model.requests[0]!.body.tools.some((tool: any) => tool.function.name === "read_team_rule"));
  assert.equal(model.requests.length, 2);
  assert.match(lastUserText(model.requests[1]!.body), /must 规则需要一个检查结论/);
  assert.deepEqual(result.result.ruleChecks, []);
  assert.deepEqual(result.result.uncheckedMustRules, [{ id: must.id, version: must.version, title: must.title }]);
  assert.deepEqual(result.result.limitations, [`以下 must 规则未确认检查：${must.title}`]);
  assert(logs.mock.calls.some((call) => JSON.parse(call.arguments[0]).event === "review_must_rules_unconfirmed"));
});

test("violated 缺引用 finding 触发修复；补上有效引用才确认违反", async (t) => {
  const must = rule("required", { level: "must" });
  const ruleChecks = [{ id: must.id, version: must.version, result: "violated" }];
  const { model, run } = await review(
    t,
    [{ text: output([], { ruleChecks }) }, { text: output([referenced(must)], { ruleChecks }) }],
    { memories: [must] },
  );
  const result = await run();
  assert.match(lastUserText(model.requests[1]!.body), /violated 但没有引用它的有效 finding/);
  assert.deepEqual(result.result.ruleChecks, ruleChecks);
  assert.deepEqual(result.result.uncheckedMustRules, []);
});

test("违反规则但 finding 越界，修复后仍无有效证据时记未确认", async (t) => {
  const must = rule("required", { level: "must" });
  const ruleChecks = [{ id: must.id, version: must.version, result: "violated" }];
  const answer = output([{ ...referenced(must), path: "outside.ts" }], { ruleChecks });
  const { model, run } = await review(t, [{ text: answer }, { text: answer }], { memories: [must] });
  const result = await run();
  assert.equal(model.requests.length, 2);
  assert.deepEqual(result.result.ruleChecks, []);
  assert.equal(result.result.uncheckedMustRules?.length, 1);
});

test("ruleChecks 只确认 must 当前版本且每条一次，修复成功后无未确认项", async (t) => {
  const must = rule("required", { level: "must" }),
    should = rule("optional");
  const checks = [{ id: must.id, version: must.version, result: "not_applicable", note: "本次不改这类调用" }];
  const { model, run } = await review(
    t,
    [
      { text: output([], { ruleChecks: [...checks, ...checks, { id: should.id, version: 99, result: "followed" }] }) },
      { text: output([], { ruleChecks: checks }) },
    ],
    { memories: [must, should] },
  );
  const result = await run();
  assert.match(lastUserText(model.requests[1]!.body), /未提供的 must 规则/);
  assert.deepEqual(result.result.ruleChecks, checks);
  assert.deepEqual(result.result.uncheckedMustRules, []);
});

test("ruleChecks 信任边界校验字段类型，丢弃伪造的服务端未确认清单", () => {
  for (const ruleChecks of [
    null,
    {},
    [null],
    [{ id: 1, version: 1, result: "followed" }],
    [{ id: "a", version: 0, result: "followed" }],
    [{ id: "a", version: 1, result: "unknown" }],
    [{ id: "a", version: 1, result: "followed", note: {} }],
  ])
    assert.throws(() => parseReviewResult(output([], { ruleChecks }), true), /ruleChecks/);
  const parsed = parseReviewResult(
    output([], {
      ruleChecks: [{ id: "a", version: 1, result: "followed", note: null, forged: true }],
      uncheckedMustRules: [{ id: "forged" }],
    }),
    true,
  );
  assert.deepEqual(parsed.ruleChecks, [{ id: "a", version: 1, result: "followed" }]);
  assert.equal(parsed.uncheckedMustRules, undefined);
});
