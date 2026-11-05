import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readWorkspaceFile } from "../workspace/workspace.js";
import { SECRET_LIMITS, redactSecrets, scanSecrets } from "../health/secrets.js";
import { displayFinding } from "./presentation.js";
import type { Finding, StoredFinding } from "./types.js";

export function addedLines(patch: string | undefined) {
  const lines = new Set<number>();
  let right = 0;
  for (const text of patch?.split("\n") ?? []) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      right = Number(header[1]);
      continue;
    }
    if (!right || text.startsWith("\\") || text.startsWith("-")) continue;
    if (text.startsWith("+")) lines.add(right);
    right++;
  }
  return lines;
}

// 扫描改动后文件的全文（多行私钥也能识别），只保留落在新增行上的命中。结果不含密钥原文。
// 没扫到的文件写进 limitations，PR 上会说明"这些文件没检查密钥"，不能当成没有密钥。
export async function checkAddedSecrets(
  root: string,
  files: Array<{ filename: string; status?: string; patch?: string }>,
  previous: StoredFinding[],
  signal: AbortSignal,
): Promise<{ findings: Finding[]; limitations: string[] }> {
  const findings: Finding[] = [],
    skipped: string[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    const added = addedLines(file.patch);
    if (file.status === "removed" || !added.size) continue;
    try {
      const info = await lstat(join(root, file.filename));
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.size > SECRET_LIMITS.fileBytes) {
        skipped.push(file.filename);
        continue;
      }
      const content = await readWorkspaceFile(root, file.filename, signal);
      for (const record of scanSecrets(file.filename, content)) {
        if (!added.has(record.line)) continue;
        const title = `新增代码里有疑似${record.label}`;
        const prior = previous.find((item) => item.path === record.path && displayFinding(item).title === title);
        findings.push({
          category: "security",
          severity: "critical",
          evidenceLevel: "strong",
          path: record.path,
          line: record.line,
          side: "RIGHT",
          description: `${record.path}:${record.line} 新增的内容符合${record.label}的格式（原文已隐藏）。`,
          evidence: `规则 ${record.rule} 命中第 ${record.line} 行。`,
          impact: "密钥提交进 Git 后，能看到仓库的人都能拿到；即使之后删除，历史提交里仍然保留。",
          suggestion: "先在对应平台作废并更换这个密钥，再改为从环境变量或密钥管理服务读取。",
          display: {
            title,
            reason: "密钥提交进 Git 后，删掉代码也还留在历史里",
            fix: "先作废并更换密钥，再改为从环境变量读取",
            ...(prior ? { previousFindingId: prior.id } : {}),
          },
        });
      }
    } catch {
      signal.throwIfAborted();
      skipped.push(file.filename);
    }
  }
  const limitations = skipped.length
    ? [
        `${skipped.length} 个改动文件过大或无法读取，没有检查新增密钥：${skipped.slice(0, 5).join("、")}${skipped.length > 5 ? " 等" : ""}。`,
      ]
    : [];
  return { findings, limitations };
}

// 兜底：模型写的意见里如果原样带出了密钥，保存和发布前一律打码。
export function redactFinding(finding: Finding) {
  finding.description = redactSecrets(finding.description);
  finding.evidence = redactSecrets(finding.evidence);
  finding.impact = redactSecrets(finding.impact);
  if (finding.suggestion) finding.suggestion = redactSecrets(finding.suggestion);
  if (finding.display)
    finding.display = {
      ...finding.display,
      title: redactSecrets(finding.display.title),
      reason: redactSecrets(finding.display.reason),
      fix: redactSecrets(finding.display.fix),
      ...(finding.display.code ? { code: redactSecrets(finding.display.code) } : {}),
    };
  for (const candidate of finding.candidates ?? []) redactFinding(candidate);
}
