import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readWorkspaceFile } from "../workspace/workspace.js";
import type { HealthMissingData, SecretRecord } from "./types.js";

export const SECRET_LIMITS = { files: 5000, fileBytes: 1_048_576, totalBytes: 50 * 1_048_576, records: 200 };

// 规则参考 gitleaks 的常见格式。专有格式误报很少；通用的"变量名 = 字符串"还要求足够随机且不像占位符。
const PLACEHOLDER = /example|replace|your[_-]|xxxx|changeme|change[_-]me|placeholder|dummy|sample|\$\{|<|\*\*\*/i;
function entropy(value: string) {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
}
const RULES: Array<{
  id: string;
  label: string;
  pattern: RegExp;
  secret?: number;
  accept?: (value: string) => boolean;
}> = [
  {
    id: "private-key",
    label: "私钥",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "github-token",
    label: "GitHub Token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g,
  },
  { id: "aws-access-key", label: "AWS Access Key", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { id: "slack-token", label: "Slack Token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google-api-key", label: "Google API Key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-key", label: "Stripe Key", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g },
  { id: "anthropic-key", label: "Anthropic API Key", pattern: /\bsk-ant-[A-Za-z0-9_-]{80,}/g },
  {
    id: "openai-key",
    label: "OpenAI API Key",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "generic-secret",
    label: "疑似密钥",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{16,200})["']/gi,
    secret: 1,
    accept: (value) => !PLACEHOLDER.test(value) && entropy(value) >= 3.5,
  },
];

function matches(content: string) {
  const found: Array<{ rule: (typeof RULES)[number]; start: number; end: number }> = [];
  for (const rule of RULES)
    for (const match of content.matchAll(rule.pattern)) {
      const value = rule.secret ? match[rule.secret]! : match[0];
      if (rule.accept && !rule.accept(value)) continue;
      const start = match.index! + match[0].indexOf(value);
      if (found.some((item) => start < item.end && start + value.length > item.start)) continue;
      found.push({ rule, start, end: start + value.length });
    }
  return found.sort((a, b) => a.start - b.start);
}

// 只保留位置和类型，绝不保存原文。
export function scanSecrets(path: string, content: string): SecretRecord[] {
  return matches(content).map(({ rule, start }) => {
    const line = content.slice(0, start).split("\n").length;
    return {
      id: "secret_" + createHash("sha256").update(`${path}:${line}:${rule.id}`).digest("hex").slice(0, 16),
      rule: rule.id,
      label: rule.label,
      path,
      line,
    };
  });
}

// 把密钥替换成说明文字，保持行数不变，代码证据的行号仍然有效。
export function redactSecrets(text: string): string {
  let result = "",
    last = 0;
  for (const { rule, start, end } of matches(text)) {
    result += text.slice(last, start) + text.slice(start, end).replace(/[^\r\n]+/g, `[已隐藏的${rule.label}]`);
    last = end;
  }
  return result + text.slice(last);
}

// known 是健康检查已经读过的文件原文（打码前），这里直接复用，不再读第二遍。
export async function collectSecrets(
  root: string,
  paths: string[],
  signal: AbortSignal,
  known: Map<string, string> = new Map(),
) {
  const records: SecretRecord[] = [],
    missingData: HealthMissingData[] = [];
  let scannedFiles = 0,
    totalBytes = 0,
    skipped = 0;
  for (const path of paths) {
    signal.throwIfAborted();
    if (scannedFiles >= SECRET_LIMITS.files) {
      skipped++;
      continue;
    }
    try {
      let content = known.get(path),
        size = content === undefined ? 0 : Buffer.byteLength(content);
      if (content === undefined) {
        const info = await lstat(join(root, path));
        if (!info.isFile() || info.isSymbolicLink()) continue;
        size = info.size;
      }
      if (size > SECRET_LIMITS.fileBytes || totalBytes + size > SECRET_LIMITS.totalBytes) {
        skipped++;
        continue;
      }
      content ??= await readWorkspaceFile(root, path, signal);
      if (content.includes("\0")) continue;
      scannedFiles++;
      totalBytes += size;
      records.push(...scanSecrets(path, content));
    } catch {
      signal.throwIfAborted();
      skipped++;
    }
  }
  if (skipped)
    missingData.push({
      source: "secrets",
      reason: "scan_limit",
      detail: `${skipped} 个文件过大、无法读取或超出数量上限，没有扫描密钥。`,
    });
  if (records.length > SECRET_LIMITS.records)
    missingData.push({
      source: "secrets",
      reason: "record_limit",
      detail: `疑似密钥共 ${records.length} 处，报告只保留前 ${SECRET_LIMITS.records} 处。`,
    });
  return { records: records.slice(0, SECRET_LIMITS.records), scannedFiles, missingData };
}
