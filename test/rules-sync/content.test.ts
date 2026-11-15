import assert from "node:assert/strict";
import test from "node:test";
import { compileMemoryContext } from "../../src/memory/context.js";
import type { MemoryRecord } from "../../src/memory/types.js";
import { renderRules, referenceChanges, syncPullRequestBody, RULES_PATH } from "../../src/rules-sync/content.js";

const rule = (id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id,
  version: 1,
  repositoryId: 1,
  installationId: 1,
  title: `规则 ${id}`,
  content: "完整正文\n" + "全文".repeat(16000),
  rationale: "理由",
  scope: { paths: ["other/**"], languages: ["typescript"], modules: ["model"], conditions: ["支付时"] },
  level: "should",
  type: "engineering_rule",
  status: "ACTIVE",
  source: { pullRequestNumber: 1, commitSha: "sha", commentIds: [] },
  evidence: [],
  confidence: 1,
  uncertainties: [],
  createdAt: "",
  updatedAt: "",
  ...extra,
});
test("全文、确定排序、覆盖级别与停用、例外标明原规则；无路径过滤无预算截断", () => {
  const rules = [
    rule("a", { teamId: "team", level: "must" }),
    rule("b"),
    rule("c", { type: "exception", exceptionTo: "b" }),
    rule("d"),
  ];
  const overrides = [
    { memoryId: "a", action: "level" as const, level: "info" as const },
    { memoryId: "d", action: "disable" as const },
  ];
  const output = (list: MemoryRecord[]) =>
    renderRules(
      compileMemoryContext(list, overrides, { text: "" }, Number.MAX_SAFE_INTEGER).full,
      "https://service/#rules",
    );
  const text = output(rules);
  assert.equal(text, output([...rules].reverse()));
  assert.ok(text.includes(rules[0]!.content));
  assert.ok(text.indexOf("## info") < text.indexOf("### 规则 a"));
  assert.ok(!text.includes("### 规则 d"));
  assert.match(text, /这是规则「规则 b」的例外/);
  assert.match(text, /conditions：支付时/);
  assert.match(text, /版本：1/);
});
test("引用保留原文、只补缺少的引用；没有入口文件时只建 AGENTS.md", () => {
  assert.deepEqual(Object.keys(referenceChanges({ "AGENTS.md": null, "CLAUDE.md": null }, {})), ["AGENTS.md"]);
  const files = { "AGENTS.md": "原有内容\n", "CLAUDE.md": `原文 @${RULES_PATH}` };
  const next = referenceChanges(files, files);
  assert.ok(next["AGENTS.md"]!.startsWith(files["AGENTS.md"]));
  assert.equal(next["CLAUDE.md"], files["CLAUDE.md"]);
  assert.deepEqual(referenceChanges(files, next), next);
  assert.deepEqual(Object.keys(referenceChanges({ "AGENTS.md": null, "CLAUDE.md": "Claude" }, {})), ["CLAUDE.md"]);
});
test("PR 摘要比较默认分支：新增、修改、删除，包含级别变化", () => {
  const before = renderRules([rule("a"), rule("b")], "https://service");
  const after = renderRules([rule("a", { version: 2, content: "更新" }), rule("c")], "https://service");
  const body = syncPullRequestBody(before, after);
  assert.match(body, /新增：规则 c/);
  assert.match(body, /修改：规则 a/);
  assert.match(body, /删除：规则 b/);
  assert.ok(body.endsWith("<!-- pi-review:rules-sync -->"));
});
