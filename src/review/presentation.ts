import { memorySourceLabel } from "../memory/types.js";
import type { Finding, ReviewResult } from "./types.js";
import type { ReviewJob } from "../jobs/types.js";

export interface FindingDisplay {
  title: string;
  reason: string;
  fix: string;
  code?: string;
  language?: string;
  previousFindingId?: string;
}
// 内部保留四级严重度，对开发者只展示三档。
export const severityLabel = { critical: "🔴 必须改", high: "🔴 必须改", medium: "🟠 建议改", low: "🟡 可以不改" };
const rank = { critical: 4, high: 3, medium: 2, low: 1 };
export const shortText = (text: string, limit: number) => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : chars.join("");
};
const safe = (text: string) =>
  text.replace(
    /[<>&|\r\n]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "|": "\\|", "\r": " ", "\n": " " })[c]!,
  );

export function validateDisplay(value: unknown): asserts value is FindingDisplay {
  const d = value as FindingDisplay;
  if (
    !d ||
    !["title", "reason", "fix"].every((k) => typeof (d as any)[k] === "string" && (d as any)[k].trim()) ||
    [...(d.title + d.reason + d.fix)].length > 120 ||
    [...d.title].length > 40
  )
    throw new Error(
      "短评必须包含问题、原因和建议，正文总计不超过 120 字（收到 " +
        (d && ["title", "reason", "fix"].every((k) => typeof (d as any)[k] === "string")
          ? [...(d.title + d.reason + d.fix)].length
          : "无效字段") +
        "）",
    );
  if (
    d.code !== undefined &&
    (typeof d.code !== "string" || d.code.length > 240 || d.code.split("\n").length > 5 || d.code.includes("```"))
  )
    throw new Error("短评代码最多 5 行 / 240 字符");
  if (d.language !== undefined && (typeof d.language !== "string" || !/^[a-zA-Z0-9_+-]{0,20}$/.test(d.language)))
    throw new Error("短评代码语言无效");
  if (
    d.previousFindingId !== undefined &&
    (typeof d.previousFindingId !== "string" || d.previousFindingId.length > 100)
  )
    throw new Error("短评 previousFindingId 无效");
}

// 候选聚合与证据保留的边界见 .agents/decisions/multi-agent-review.md。
export function mergeFindings(items: Finding[], display?: FindingDisplay): Finding {
  if (!items.length) throw new Error("问题分组不能为空");
  const references = new Set(items.filter((f) => f.memory).map((f) => f.memory!.id + ":" + f.memory!.version));
  if (references.size > 1) throw new Error("不得合并不同 Memory 约束");
  if (display) validateDisplay(display);
  const primary = items[0]!;
  const candidates = items
    .flatMap((f) => f.candidates ?? [f])
    .map(({ candidates, display, relatedLocations, mergedCount, ...finding }) => finding);
  const locations = items
    .flatMap((f) => [{ path: f.path, line: f.line, side: f.side }, ...(f.relatedLocations ?? [])])
    .filter((l) => l.path);
  const relatedLocations = [...new Map(locations.map((l) => [JSON.stringify(l), l])).values()].filter(
    (l) => !(l.path === primary.path && l.line === primary.line && l.side === primary.side),
  );
  const joined = (key: "description" | "evidence" | "impact" | "suggestion") =>
    [...new Set(items.map((f) => f[key]).filter(Boolean))].join("\n\n");
  return {
    ...primary,
    severity: items.reduce((best, f) => (rank[f.severity] > rank[best] ? f.severity : best), primary.severity),
    memory: items.find((f) => f.memory)?.memory,
    evidence: joined("evidence"),
    impact: joined("impact"),
    suggestion: joined("suggestion"),
    relatedLocations,
    candidates,
    mergedCount: candidates.length - 1,
    display: display ?? (items.length === 1 ? primary.display : undefined),
  };
}

export function groupFindings(findings: Finding[], groups: unknown, displays?: unknown): Finding[] {
  if (
    !Array.isArray(groups) ||
    (displays !== undefined && (!Array.isArray(displays) || displays.length !== groups.length))
  )
    throw new Error("findingGroups / issueDisplays 结构无效");
  const seen = new Set<number>();
  const result = groups.map((group, index) => {
    if (!Array.isArray(group) || !group.length) throw new Error("问题分组不能为空");
    const members = group.map((i) => {
      if (!Number.isSafeInteger(i) || i < 0 || i >= findings.length || seen.has(i))
        throw new Error("问题分组存在未知或重复候选");
      seen.add(i);
      return findings[i]!;
    });
    if (displays !== undefined) validateDisplay(displays[index]);
    return mergeFindings(members, (displays as FindingDisplay[] | undefined)?.[index]);
  });
  if (seen.size !== findings.length) throw new Error("问题分组遗漏候选");
  return result;
}

export function displayFinding(f: Finding): FindingDisplay {
  if (f.display) return f.display;
  // 兼容历史记录；新模型输出必须通过 validateDisplay，不裁断代码补丁。
  return {
    title: shortText(f.description.split(/[。\n]/)[0]!, 32),
    reason: shortText(f.evidence, 38),
    fix: shortText(f.suggestion ?? "查看详情后调整相关实现。", 48),
  };
}
function findingText(finding: Finding) {
  const d = displayFinding(finding);
  const code = d.code ? "\n\n```" + (d.language ?? "") + "\n" + d.code + "\n```" : "";
  return `${severityLabel[finding.severity]}：${safe(d.title)}\n\n${safe(d.reason)}\n${safe(d.fix)}${code}`;
}
export function codeLocation(job: ReviewJob, f: Pick<Finding, "path" | "line" | "side">) {
  if (!f.path) return "整体变更";
  const name = safe(f.path.split("/").at(-1)!) + (f.line ? ":" + f.line : "");
  const sha = f.side === "LEFT" ? job.baseSha : job.headSha;
  return `[${name}](https://github.com/${job.repository}/blob/${sha}/${f.path.split("/").map(encodeURIComponent).join("/")}${f.line ? "#L" + f.line : ""})`;
}
function previousCommentLink(job: ReviewJob, f: Finding) {
  const id = f.repeatOf?.commentId;
  return id
    ? `[之前的评论](https://github.com/${job.repository}/pull/${job.prNumber}#discussion_r${id})`
    : "之前的评论";
}

export function reviewBody(job: ReviewJob, result: ReviewResult, partial = false, detailsUrl?: string) {
  const bySeverity = [...result.findings].sort((a, b) => rank[b.severity] - rank[a.severity]);
  const fresh = bySeverity.filter((f) => !f.repeatOf);
  const repeats = bySeverity.filter((f) => f.repeatOf);
  const hidden = fresh.filter((f) => f.restricted),
    shown = fresh.filter((f) => !f.restricted);
  const adminLink = detailsUrl ? `：[到管理页查看](${detailsUrl})` : "，请到管理页查看";
  const resolved = result.resolvedPrevious ?? 0;
  const lines = ["## Pi Review", ""];
  if (fresh.length) {
    lines.push(`发现 ${fresh.length} 个${repeats.length || resolved ? "新" : ""}问题`, "");
    for (const f of shown)
      lines.push(`- ${severityLabel[f.severity]} · ${codeLocation(job, f)} · ${safe(displayFinding(f).title)}`);
    if (hidden.length)
      lines.push(`- 🔴 必须改 · 发现 ${hidden.length} 个安全问题，为避免修复前公开，细节只在管理页显示${adminLink}`);
  } else if (repeats.length) lines.push("没有发现新问题");
  else lines.push(partial ? "⚠ 部分检查未完成，已检查的部分没发现问题" : "✅ 没发现需要改的问题");
  if (repeats.length) {
    lines.push("", `之前提过、仍未解决的 ${repeats.length} 个：`, "");
    for (const f of repeats)
      lines.push(
        f.restricted
          ? `- ${severityLabel[f.severity]} · 安全问题，细节只在管理页显示`
          : `- ${severityLabel[f.severity]} · ${previousCommentLink(job, f)} · ${safe(f.repeatOf!.title)}`,
      );
  }
  if (resolved) lines.push("", `之前的 ${resolved} 个问题这次没有再发现。`);
  const unmapped = shown.filter((f) => !f.path || !f.line || !f.side);
  if (unmapped.length)
    lines.push(
      "",
      "<details>",
      "<summary>没法定位到具体行的问题</summary>",
      "",
      unmapped.map(findingText).join("\n\n---\n\n"),
      "",
      "</details>",
    );
  if (partial && (fresh.length || repeats.length)) lines.push("", "⚠ 部分检查未完成，结果可能不全");
  lines.push("", "仅静态审查，未运行测试" + (detailsUrl ? ` · [查看详情](${detailsUrl})` : ""));
  return lines.join("\n");
}

export function inlineBody(job: ReviewJob, finding: Finding & { id: string }, detailsUrl?: string) {
  if (finding.restricted)
    return `🔴 必须改：发现安全问题，为避免修复前公开，细节只在管理页显示${detailsUrl ? `：[到管理页查看](${detailsUrl})` : "。"}`;
  const parts = [findingText(finding)];
  if (finding.memory) {
    const pr = finding.memory.source.pullRequestNumber;
    const source = pr
      ? `（来源：[PR #${pr}](https://github.com/${job.repository}/pull/${pr})）`
      : `（${safe(memorySourceLabel(finding.memory.source))}）`;
    parts.push(
      `<details>\n<summary>规则来源</summary>\n\n${safe(finding.memory.title ?? "团队已确认的规则")}${source}\n\n</details>`,
    );
  }
  // 修改建议已覆盖整组位置，这里只列出位置，不再重复完整审计文字。
  const related = finding.relatedLocations ?? [];
  if (related.length)
    parts.push(
      `<details>\n<summary>相关位置（${related.length} 处）</summary>\n\n${related.map((l) => "- " + codeLocation(job, l)).join("\n")}\n\n</details>`,
    );
  if (detailsUrl) parts.push(`[查看详情](${detailsUrl})`);
  parts.push(`<!-- pi-finding:${finding.id} -->`);
  return parts.join("\n\n");
}
