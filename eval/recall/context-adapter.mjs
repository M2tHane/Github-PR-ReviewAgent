import { compileMemoryContext } from "../../dist/src/memory/context.js";

export async function select({ memories, input, maxChars }) {
  // 旧样例没有 level，沿用数据库迁移的默认 should。
  const rules = memories.map((rule) => ({ ...rule, level: rule.level ?? "should" }));
  const { full: rulesFull, index: rulesIndex } = compileMemoryContext(rules, [], input, maxChars);
  return { rulesFull, rulesIndex };
}
