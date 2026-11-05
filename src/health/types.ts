import type { FindingSeverity, EvidenceLevel } from "../review/types.js";

export interface HealthScope {
  includePaths: string[];
  excludePaths: string[];
  outputLanguage: string;
  budgetTokens: number;
}

export type HealthDimension = "code" | "ci" | "dependencies" | "documentation" | "security";
export interface HealthMissingData {
  source: string;
  reason: string;
  detail: string;
}
export interface HealthSource {
  id: string;
  kind: "check" | "workflow";
  name: string;
  sha: string;
  status: string;
  conclusion: string | null;
  at: string;
  url: string;
  target: boolean;
}
export type HealthReference =
  | { kind: "code"; path: string; line: number; detail: string }
  | { kind: "ci"; sourceId: string; detail: string }
  | { kind: "memory"; id: string; version: number; detail: string }
  | { kind: "vulnerability"; id: string; detail: string }
  | { kind: "secret"; id: string; detail: string }
  | { kind: "sast"; id: string; detail: string };
export type DependencyEcosystem = "npm" | "Go" | "crates.io" | "PyPI" | "Maven";
export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "unknown";
// 一条已知漏洞落在某个锁文件里的某个依赖版本上；全部字段来自锁文件和 OSV，不经过模型。
export interface VulnerabilityRecord {
  id: string;
  aliases: string[];
  summary: string;
  severity: VulnerabilitySeverity;
  ecosystem: DependencyEcosystem;
  package: string;
  version: string;
  manifestPath: string;
  line?: number;
  dev: boolean;
  fixedVersions: string[];
  url: string;
}
export interface DependencyAudit {
  status: "disabled" | "no_manifest" | "complete" | "incomplete";
  manifests: Array<{ path: string; ecosystem: DependencyEcosystem; dependencies: number }>;
  queried: number;
  vulnerabilities: VulnerabilityRecord[];
}
// 疑似密钥只记位置和类型，不保存原文。
export interface SecretRecord {
  id: string;
  rule: string;
  label: string;
  path: string;
  line: number;
}
export interface SecretScan {
  status: "complete" | "incomplete";
  scannedFiles: number;
  records: SecretRecord[];
}
// Semgrep 规则命中：只是"写法危险"的候选，不代表一定能被利用。不保存代码原文。
export interface SastRecord {
  id: string;
  rule: string;
  label: string;
  severity: "high" | "medium" | "low";
  path: string;
  line: number;
  message: string;
}
export interface SastScan {
  status: "disabled" | "complete" | "incomplete";
  scannedFiles: number;
  records: SastRecord[];
}
export interface HealthFinding {
  id: string;
  dimension: HealthDimension;
  severity: FindingSeverity;
  evidenceLevel: EvidenceLevel;
  description: string;
  impact: string;
  suggestion: string;
  references: HealthReference[];
}
export interface HealthResult {
  summary: string;
  findings: HealthFinding[];
  limitations: string[];
}
export interface HealthReport {
  version: 1;
  jobId: string;
  repositoryId: number;
  repository: string;
  headSha: string;
  defaultBranch: string;
  windowStart: string;
  windowEnd: string;
  collectedAt: string;
  completedAt: string;
  status: "succeeded" | "partial";
  scope: HealthScope;
  model: string;
  durationMs: number;
  usage: import("../review/agent.js").AgentUsage;
  comparisonKey: string;
  coverage: {
    eligibleFiles: number;
    files: Array<{ path: string; totalLines: number; readLines: number }>;
    skippedFiles: Array<{ path: string; reason: string }>;
    memoryReferences: Array<{ id: string; version: number }>;
  };
  sources: HealthSource[];
  missingData: HealthMissingData[];
  // health-v2 起才有；旧报告没有这一项。
  dependencyAudit?: DependencyAudit;
  secretScan?: SecretScan;
  sastScan?: SastScan;
  result: HealthResult;
}
