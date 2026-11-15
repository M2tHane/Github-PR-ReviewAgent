import type { MemoryRecord } from "../memory/types.js";

export const RULES_PATH = ".pi-review/rules.md";
export const SYNC_MARKER = "<!-- pi-review:rules-sync -->";
export const SYNC_BRANCH_PREFIX = "pi-review/rules-";
export const REFERENCE = `## 项目适用规则\n\n请先阅读并遵守 [项目适用规则](${RULES_PATH})；其中的例外只在注明的适用范围内生效。\n`;

// 不写生成时间；按级别和 ID 固定排序，完整保留编译器已经应用覆盖的正文与范围。
export function renderRules(rules: MemoryRecord[], managementUrl?: string): string {
  const originals = new Map(rules.map((rule) => [rule.id, rule.title]));
  const sections = [
    "# 项目适用规则",
    `此文件由 Pi Review 服务生成，请勿手动修改。请到${managementUrl ? `[管理页](${managementUrl})` : "管理页"}修改并确认规则，由服务通过 PR 更新。`,
    "规则按 must（必须）、should（建议）、info（参考）分组。按每条规则的适用范围判断；例外仅在其范围内覆盖原规则。",
  ];
  for (const level of ["must", "should", "info"] as const) {
    sections.push(`## ${level}`);
    const group = rules.filter((rule) => rule.level === level).sort((a, b) => a.id.localeCompare(b.id));
    if (!group.length) sections.push("暂无规则。");
    for (const rule of group) {
      const scope = (["paths", "languages", "modules", "conditions"] as const)
        .filter((key) => rule.scope[key]?.length)
        .map((key) => `- ${key}：${rule.scope[key]!.join("；")}`)
        .join("\n");
      // 标记用于 PR 相对默认分支的变化摘要；正文无须再次依赖数据库的历史版本。
      sections.push(
        `<!-- pi-review:rule ${rule.id} -->\n### ${rule.title}\n\nID：\`${rule.id}\` · 版本：${rule.version} · 级别：${rule.level}\n\n${rule.content}\n\n理由：\n\n${rule.rationale}\n\n适用范围：\n\n${scope || "整个项目。"}${rule.exceptionTo ? `\n\n这是规则「${originals.get(rule.exceptionTo) ?? rule.exceptionTo}」的例外（原规则 ID：\`${rule.exceptionTo}\`），仅在上述范围内生效。` : ""}\n<!-- /pi-review:rule -->`,
      );
    }
  }
  return sections.join("\n\n") + "\n";
}

export type RulesFiles = Record<string, string | null>;
export function referenceChanges(defaultFiles: RulesFiles, currentFiles: RulesFiles): RulesFiles {
  const existing = ["AGENTS.md", "CLAUDE.md"].filter((path) => defaultFiles[path] !== null);
  const paths = existing.length ? existing : ["AGENTS.md"];
  return Object.fromEntries(
    paths.map((path) => {
      const content = currentFiles[path] ?? defaultFiles[path] ?? "";
      return [
        path,
        content.includes(RULES_PATH)
          ? content
          : `${content}${content ? (content.endsWith("\n") ? "\n" : "\n\n") : ""}${REFERENCE}`,
      ];
    }),
  );
}

function ruleBlocks(content: string) {
  return new Map(
    [
      ...content.matchAll(/<!-- pi-review:rule ([0-9a-f-]+) -->\n### ([^\n]+)\n([\s\S]*?)<!-- \/pi-review:rule -->/g),
    ].map((match) => [match[1]!, { title: match[2]!, block: match[0] }]),
  );
}
export function syncPullRequestBody(before: string, after: string): string {
  const old = ruleBlocks(before),
    next = ruleBlocks(after);
  const added = [...next].filter(([id]) => !old.has(id)).map(([, rule]) => rule.title);
  const changed = [...next]
    .filter(([id, rule]) => old.has(id) && old.get(id)!.block !== rule.block)
    .map(([, rule]) => rule.title);
  const removed = [...old].filter(([id]) => !next.has(id)).map(([, rule]) => rule.title);
  return [
    "将本仓库实际适用的规则同步到 `.pi-review/rules.md`，供本地 Codex／Claude Code 读取。仅提出 PR，由维护者决定是否合并。",
    "相对默认分支的规则变化：",
    ...[
      ["新增", added],
      ["修改", changed],
      ["删除", removed],
    ].map(([label, titles]) => `- ${label}：${(titles as string[]).join("、") || "无"}`),
    "同时补充缺少的 AGENTS.md／CLAUDE.md 引用。规则请在管理页修改并确认。",
    SYNC_MARKER,
  ].join("\n\n");
}
