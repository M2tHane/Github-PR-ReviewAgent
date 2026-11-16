import type { Pool } from "pg";
import { hasSpecificScope, matchWords, REVIEW_MEMORY_CHARS, scopeMatches, toMemory } from "./memory.service.js";
import type { MemoryRecord } from "./types.js";

export type ContextMemory = MemoryRecord;
// 不传 paths 时保留全部范围，开发任务随后按实际读写的文件附规则。
export interface ContextInput {
  paths?: string[];
  text: string;
}

export async function loadMemoryContext(
  pool: Pool,
  repositoryId: number,
  input: ContextInput,
  maxChars = REVIEW_MEMORY_CHARS,
) {
  const result = await pool.query(
    `SELECT DISTINCT ON (m.id) m.*
     FROM memories m
     WHERE m.status='ACTIVE' AND m.repository_id=$1
     ORDER BY m.id,m.version DESC`,
    [repositoryId],
  );
  return compileMemoryContext(result.rows.map(toMemory), input, maxChars);
}

// 只编译已收集的 ACTIVE 最新版本；不推断语义冲突，例外关系由维护者确认。
export function compileMemoryContext(rules: MemoryRecord[], input: ContextInput, maxChars = REVIEW_MEMORY_CHARS) {
  const effective: ContextMemory[] = rules;
  const selected = effective.filter((rule) => input.paths === undefined || scopeMatches(rule, input.paths));
  const ids = new Set(selected.map((rule) => rule.id));
  const originals = new Map(effective.map((rule) => [rule.id, rule]));
  for (const rule of selected) {
    const original = rule.exceptionTo ? originals.get(rule.exceptionTo) : undefined;
    if (original && !ids.has(original.id)) {
      selected.push(original);
      ids.add(original.id);
    }
  }
  const queryWords = matchWords(input.text);
  const priority = { must: 0, should: 1, info: 2 };
  const ranked = selected
    .map((rule) => ({
      rule,
      specific: hasSpecificScope(rule),
      score: [...matchWords(`${rule.title} ${rule.content} ${rule.rationale}`)].filter((word) => queryWords.has(word))
        .length,
    }))
    .sort(
      (a, b) =>
        priority[a.rule.level] - priority[b.rule.level] ||
        Number(b.specific) - Number(a.specific) ||
        b.score - a.score ||
        a.rule.id.localeCompare(b.rule.id),
    );
  const size = (rule: MemoryRecord) => rule.title.length + rule.content.length + rule.rationale.length;
  const mustChars = selected.filter((rule) => rule.level === "must").reduce((sum, rule) => sum + size(rule), 0);
  const full: ContextMemory[] = [];
  const index: Pick<MemoryRecord, "id" | "version" | "title" | "level" | "scope">[] = [];
  let used = 0;
  for (const { rule } of ranked) {
    if (rule.level === "must" || (!index.length && used + size(rule) <= maxChars)) {
      full.push(rule);
      used += size(rule);
    } else {
      const { id, version, title, level, scope } = rule;
      index.push({ id, version, title, level, scope });
    }
  }
  return { full, index, mustOverBudget: mustChars > maxChars, total: selected.length };
}
