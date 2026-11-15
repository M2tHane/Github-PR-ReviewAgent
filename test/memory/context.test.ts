import assert from "node:assert/strict";
import test from "node:test";
import { compileMemoryContext } from "../../src/memory/context.js";
import type { MemoryRecord } from "../../src/memory/types.js";

function rule(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    version: 1,
    repositoryId: 1,
    installationId: 1,
    type: "engineering_rule",
    level: "should",
    title: id,
    content: "正文",
    rationale: "理由",
    scope: { paths: ["src/**"] },
    source: { pullRequestNumber: 1, commitSha: "sha", commentIds: [1] },
    evidence: [],
    confidence: 1,
    uncertainties: [],
    status: "ACTIVE",
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}
const input = { paths: ["src/a.ts"], text: "" };
const ids = (rules: { id: string }[]) => rules.map((rule) => rule.id);

test("覆盖先于范围和例外：停用不被例外复活，改级别保留团队原级别，不修改输入", () => {
  const original = rule("original", { repositoryId: null, teamId: "a", level: "must" });
  const exception = rule("exception", { type: "exception", exceptionTo: original.id });
  const disabled = compileMemoryContext([original, exception], [{ memoryId: original.id, action: "disable" }], input);
  assert.deepEqual(ids(disabled.full), [exception.id]);
  const changed = compileMemoryContext([original], [{ memoryId: original.id, action: "level", level: "info" }], input);
  assert.equal(changed.full[0]?.level, "info");
  assert.equal(changed.full[0]?.teamLevel, "must");
  assert.equal(original.level, "must");
});

test("范围命中的项目例外带出团队原规则；多个团队同 Scope 的规则都保留", () => {
  const a = rule("a", { teamId: "a", repositoryId: null, scope: { paths: ["other/**"] } });
  const b = rule("b", { teamId: "b", repositoryId: null });
  const c = rule("c", { teamId: "c", repositoryId: null });
  const exception = rule("e", { type: "exception", exceptionTo: "a" });
  assert.deepEqual(ids(compileMemoryContext([a, b, c], [], input).full), ["b", "c"]);
  assert.deepEqual(ids(compileMemoryContext([a, b, c, exception], [], input).full), ["a", "b", "c", "e"]);
  assert.deepEqual(ids(compileMemoryContext([a, b, c], [], { text: "" }).full), ["a", "b", "c"]);
});

test("must 全给且单独报告超限，should 先于 info；索引只暴露约定字段", () => {
  const rules = [rule("a", { level: "info" }), rule("b"), rule("c", { level: "must" }), rule("d", { level: "must" })];
  const context = compileMemoryContext(rules, [], input, 1);
  assert.deepEqual(ids(context.full), ["c", "d"]);
  assert.deepEqual(ids(context.index), ["b", "a"]);
  assert.equal(context.mustOverBudget, true);
  assert.equal(context.total, 4);
  assert.deepEqual(Object.keys(context.index[0]!).sort(), ["id", "version", "title", "level", "scope"].sort());
  const two = compileMemoryContext(rules.slice(0, 2), [], input, 5);
  assert.deepEqual(ids(two.full), ["b"]);
  assert.deepEqual(ids(two.index), ["a"]);
  assert.equal(two.mustOverBudget, false);
});

test("同级别限定范围优先，再按词重叠、ID 排序；自然语言条件不参与过滤", () => {
  const rules = [
    rule("a", { scope: {} }),
    rule("b"),
    rule("d", { content: "timeout", scope: { languages: ["typescript"], conditions: ["仅用于支付"] } }),
    rule("c", { content: "timeout" }),
  ];
  assert.deepEqual(ids(compileMemoryContext(rules, [], { ...input, text: "timeout" }).full), ["c", "d", "b", "a"]);
});
