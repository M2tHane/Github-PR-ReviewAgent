import assert from "node:assert/strict";
import test from "node:test";
import { extractionScore, recallScore } from "./metrics.mjs";
import { loadCases } from "./support.mjs";

const proposal = {
  type: "engineering_rule",
  title: "支付幂等",
  content: "扣款和幂等记录使用同一事务",
  rationale: "回调重试",
};
const expected = {
  type: "engineering_rule",
  keywords: [
    ["幂等", "idempotency"],
    ["事务", "transaction"],
  ],
};

test("重复候选只命中一次，多余候选计入 FP", () => {
  const score = extractionScore([proposal, proposal], [expected]);
  assert.equal(score.tp, 1);
  assert.equal(score.fp, 1);
  assert.equal(score.precision, 0.5);
});

test("每组要点必须命中，类型及关系目标都必须准确", () => {
  for (const item of [
    { ...proposal, type: "coding_convention" },
    { ...proposal, content: "扣款不涉及其他操作" },
    { ...proposal, relation: { supersedes: "unrelated" } },
  ])
    assert.equal(extractionScore([item], [expected]).tp, 0);
  const target = { ...expected, relation: { supersedes: "old-rule" } };
  assert.equal(extractionScore([{ ...proposal, relation: { supersedes: "old-rule" } }], [target]).tp, 1);
  assert.equal(extractionScore([{ ...proposal, relation: { supersedes: "other-rule" } }], [target]).tp, 0);
});

test("最大匹配不受宽窄标注的贪心次序影响", () => {
  const broad = { type: "engineering_rule", keywords: [["幂等"]] };
  const narrowProposal = { ...proposal, content: "仅按幂等键查询" };
  const score = extractionScore([proposal, narrowProposal], [broad, expected]);
  assert.equal(score.tp, 2);
});

test("模型把例外关联放到顶层时不能误计为正确关系", () => {
  const target = { ...expected, type: "exception", relation: { exceptionTo: "original-rule" } };
  const misplaced = { ...proposal, type: "exception", exceptionTo: "original-rule" };
  assert.equal(extractionScore([misplaced], [target]).tp, 0);
  assert.equal(extractionScore([{ ...misplaced, relation: target.relation }], [target]).tp, 1);
});

test("空结果的精确率/召回率无分母时为 null，独立记录空样例是否正确", () => {
  assert.equal(extractionScore([], []).exact, true);
  assert.equal(extractionScore([], []).precision, null);
  assert.equal(extractionScore([], [expected]).recall, 0);
  assert.equal(extractionScore([proposal], []).fp, 1);
});

test("索引计入可见覆盖，不计入全文；重复 ID 不增加命中", () => {
  const full = [{ id: "a", title: "标题", content: "正文", rationale: "理由" }];
  const index = [
    { id: "a", title: "标题" },
    { id: "b", title: "第二条" },
  ];
  const score = recallScore(["a", "b", "c"], full, index);
  assert.equal(score.fullHits, 1);
  assert.equal(score.providedHits, 2);
  assert.equal(score.fullTextChars, 6);
  assert.deepEqual(score.missingIds, ["c"]);
});

test("召回样例有明确标注且覆盖大规模预算压力，提取样例只使用合成证据", async () => {
  const recall = await loadCases(new URL("./recall/cases/", import.meta.url));
  assert.ok(recall.length >= 15);
  assert.ok(
    recall.filter(
      (sample) =>
        sample.rules.reduce((n, rule) => n + rule.title.length + rule.content.length + rule.rationale.length, 0) >
        30_000,
    ).length >= 3,
  );
  for (const sample of recall) {
    const ids = new Set(sample.rules.map((rule) => rule.id));
    assert.equal(ids.size, sample.rules.length);
    assert.equal(new Set(sample.expectedIds).size, sample.expectedIds.length);
    for (const id of sample.expectedIds) assert.ok(ids.has(id), `${sample.id}: ${id}`);
    for (const rule of sample.rules) if (rule.exceptionTo) assert.ok(ids.has(rule.exceptionTo));
  }
  const extraction = await loadCases(new URL("./extraction/cases/", import.meta.url));
  assert.equal(extraction.length, 6);
  for (const sample of extraction) {
    assert.equal(sample.provenance, "synthetic");
    for (const expected of sample.expected)
      for (const id of Object.values(expected.relation ?? {}))
        assert.ok(sample.existingRules.some((rule) => rule.id === id));
  }
});
