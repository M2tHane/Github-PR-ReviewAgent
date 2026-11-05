import { SAST_TARGETS, scanWithSemgrep } from "../health/sast.js";
import type { SastRecord } from "../health/types.js";
import { displayFinding, shortText } from "./presentation.js";
import { addedLines } from "./secret-check.js";
import type { Finding, StoredFinding } from "./types.js";

export type RuleHit = Pick<SastRecord, "rule" | "label" | "severity" | "path" | "line" | "message">;

// 对改动的源码文件跑 Semgrep，只保留落在新增行上的命中，作为线索交给模型确认。
export async function scanChangedFiles(
  root: string,
  files: Array<{ filename: string; status?: string; patch?: string }>,
  semgrepPath: string,
  signal: AbortSignal,
): Promise<{ hits: RuleHit[]; limitations: string[] }> {
  const added = new Map(
    files
      .filter((file) => file.status !== "removed" && SAST_TARGETS.test(file.filename))
      .map((file) => [file.filename, addedLines(file.patch)] as const)
      .filter(([, lines]) => lines.size),
  );
  if (!added.size) return { hits: [], limitations: [] };
  const { scan, missingData } = await scanWithSemgrep(root, [...added.keys()], semgrepPath, signal);
  return {
    hits: scan.records
      .filter((record) => added.get(record.path)?.has(record.line))
      .map(({ rule, label, severity, path, line, message }) => ({ rule, label, severity, path, line, message })),
    limitations: missingData.map((item) => `规则扫描：${item.detail}`),
  };
}

// 模型没有在命中位置附近写安全意见的高风险命中，由服务端补一条，并标明需要人工确认。
export function uncoveredRuleFindings(hits: RuleHit[], findings: Finding[], previous: StoredFinding[]): Finding[] {
  const covered = (hit: RuleHit) =>
    findings.some((finding) =>
      [finding, ...(finding.relatedLocations ?? []).map((location) => ({ ...finding, ...location }))].some(
        (item) =>
          item.category === "security" &&
          item.path === hit.path &&
          item.line !== undefined &&
          Math.abs(item.line - hit.line) <= 2,
      ),
    );
  return hits
    .filter((hit) => hit.severity === "high" && !covered(hit))
    .map((hit) => {
      const title = shortText(`疑似${hit.label}，需人工确认`, 40);
      const prior = previous.find((item) => item.path === hit.path && displayFinding(item).title === title);
      return {
        category: "security",
        severity: "medium",
        evidenceLevel: "weak",
        path: hit.path,
        line: hit.line,
        side: "RIGHT",
        description: `规则扫描在新增代码里发现疑似${hit.label}：${hit.message} 模型没有确认这一处，需要人工核对输入是否可能来自外部。`,
        evidence: `Semgrep 规则 ${hit.rule} 命中 ${hit.path}:${hit.line}。`,
        impact: hit.message,
        suggestion: "确认这里的数据来源；如果可能来自用户输入，按规则说明改为参数化或参数数组调用。",
        display: {
          title,
          reason: shortText(hit.message.split("。")[0]!, 50),
          fix: "核对数据来源，必要时参数化或传参数数组",
          ...(prior ? { previousFindingId: prior.id } : {}),
        },
      } satisfies Finding;
    });
}
