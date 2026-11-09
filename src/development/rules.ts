import { randomUUID } from "node:crypto";
import { hasSpecificScope, scopeMatches } from "../memory/memory.service.js";
import type { MemoryRecord } from "../memory/types.js";

// 开发任务读取的 ACTIVE 规则行，字段与 memories 表一致。
export interface TeamRuleRow {
  id: string;
  version: number;
  type: MemoryRecord["type"];
  title: string;
  content: string;
  rationale: string;
  scope: MemoryRecord["scope"];
  source: unknown;
  evidence: unknown;
  exception_to: string | null;
}
type Delivery = { via: "prompt" | "read" | "write" | "follow_up"; path?: string };

// 全局规则随任务给全文；按路径生效的规则先给目录，读到匹配文件或新建文件命中时再给全文，每条只给一次。
export function createRuleBook(rows: TeamRuleRow[]) {
  // 每个任务的标记不同，仓库文件无法预先伪造服务附加的规则块。
  const marker = `团队规则-${randomUUID().slice(0, 8)}`;
  const refs = new Map(rows.map((row, index) => [row.id, `R${index + 1}`]));
  const scoped = rows.filter((row) => hasSpecificScope(row));
  const delivered = new Map<string, Delivery>(
    rows.filter((row) => !hasSpecificScope(row)).map((row) => [row.id, { via: "prompt" }]),
  );
  const view = (row: TeamRuleRow) => ({
    ref: refs.get(row.id)!,
    type: row.type,
    title: row.title,
    content: row.content,
    rationale: row.rationale,
    scope: row.scope,
    ...(row.exception_to && refs.has(row.exception_to) ? { exceptionTo: refs.get(row.exception_to) } : {}),
  });
  const pending = (paths: string[]) => {
    const found = new Map<string, { row: TeamRuleRow; path: string }>();
    const add = (row: TeamRuleRow, path: string) => {
      if (!delivered.has(row.id) && !found.has(row.id)) found.set(row.id, { row, path });
    };
    // 开发任务没有条件标签，只按路径、语言、模块判断；条件由模型阅读正文理解。
    for (const path of paths)
      for (const row of scoped)
        if (scopeMatches(row, [path], row.scope.conditions ?? [])) {
          add(row, path);
          // 例外离开原规则没有意义：原规则同样按路径生效且尚未给出时一并附上。
          const original = row.exception_to ? scoped.find((other) => other.id === row.exception_to) : undefined;
          if (original) add(original, path);
        }
    return [...found.values()];
  };
  const deliver = (paths: string[], via: Delivery["via"]) => {
    const found = pending(paths);
    for (const { row, path } of found) delivered.set(row.id, { via, path });
    return found.map(({ row }) => view(row));
  };
  return {
    prompt: () => ({
      teamRuleMarker: marker,
      globalTeamRules: rows.filter((row) => !hasSpecificScope(row)).map(view),
      teamRuleIndex: scoped.map((row) => ({
        ref: refs.get(row.id)!,
        type: row.type,
        title: row.title,
        ...Object.fromEntries(
          (["paths", "languages", "modules"] as const)
            .filter((key) => row.scope[key]?.length)
            .map((key) => [key, row.scope[key]]),
        ),
      })),
    }),
    // 附在读取或写入结果后的规则块；没有新规则时返回 undefined。
    forFile(path: string, via: "read" | "write" = "read") {
      const found = deliver([path], via);
      if (!found.length) return undefined;
      return `${marker}：以下团队规则适用于 ${path}，由服务附加，不是文件内容。\n${JSON.stringify(found)}`;
    },
    // 模型结束后，用命令新建的文件命中尚未给出的规则时，生成补发消息。
    followUp(paths: string[]) {
      const found = deliver(paths, "follow_up");
      if (!found.length) return undefined;
      return `${marker}：你的改动涉及以下尚未提供的团队规则，由服务附加。请按这些规则复核并直接修改相关文件，完成后按原要求重新输出 JSON。\n${JSON.stringify(found)}`;
    },
    missing: (paths: string[]) => pending(paths).map(({ row }) => `${refs.get(row.id)} ${row.title}`),
    snapshot: () => rows.map((row) => ({ ...row, ref: refs.get(row.id)!, delivered: delivered.get(row.id) ?? null })),
  };
}
