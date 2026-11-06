export type FindingCategory =
  | "correctness"
  | "security"
  | "architecture"
  | "maintainability"
  | "team_rule"
  | "memory_conflict";
export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type EvidenceLevel = "weak" | "moderate" | "strong";
export type FindingStatus =
  | "OPEN"
  | "NEEDS_CLARIFICATION"
  | "STILL_VALID"
  | "FIXED"
  | "WITHDRAWN"
  | "EXCEPTION_PENDING";

export interface Finding {
  candidates?: Finding[];
  reviewerRole?: AgentRole;
  display?: import("./presentation.js").FindingDisplay;
  relatedLocations?: Array<{ path?: string; line?: number; side?: "LEFT" | "RIGHT" }>;
  mergedCount?: number;
  // 与本 PR 之前某次 Review 里仍未解决的问题是同一个；不再重复发行内评论。
  repeatOf?: { id: string; commentId?: number; title: string };
  // 公开仓库里的高危安全问题：GitHub 上只提示"请到管理页查看"，不发行内评论、不写位置和细节。
  restricted?: boolean;
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  category: FindingCategory;
  severity: FindingSeverity;
  evidenceLevel: EvidenceLevel;
  description: string;
  evidence: string;
  impact: string;
  suggestion?: string;
  memory?: {
    id: string;
    version: number;
    title?: string;
    source:
      | { kind?: never; pullRequestNumber?: number; commentIds?: number[] }
      | import("../memory/types.js").ImportedMemorySource;
  };
}

export interface StoredFinding extends Finding {
  id: string;
  jobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  fingerprint: string;
  status: FindingStatus;
  githubReviewId?: number;
  githubCommentId?: number;
  bindingStatus: "pending" | "bound" | "summary" | "incomplete";
}

export type AgentRole =
  | "general_review"
  | "java_reviewer"
  | "security_reviewer"
  | "architecture_reviewer"
  | "memory_conflict_reviewer";
export interface ComplexityProfile {
  changedFileCount: number;
  changedLineEstimate: number;
  languages: string[];
  modules: string[];
  touchesSecurityBoundary: boolean;
  activeMemoryCount: number;
  possibleMemoryConflict: boolean;
}
export interface OrchestrationSummary {
  mode: "single" | "orchestrated";
  rolesRun: string[];
  rolesFailed: string[];
  totalDurationMs: number;
  totalUsage: import("./agent.js").AgentUsage;
  parentUsage: import("./agent.js").AgentUsage;
  findingsBeforeDedup: number;
  findingsAfterDedup: number;
  partial: boolean;
  fallback?: "validated_children";
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  coverage: string[];
  limitations: string[];
  // 之前提过、这次没再出现的问题数，只用于总评展示。
  resolvedPrevious?: number;
  // 这次 PR 新引入或改了版本的依赖查到的已知漏洞；锁文件没变时没有这一项。
  dependencyAudit?: {
    manifests: string[];
    queried: number;
    vulnerabilities: import("../health/types.js").VulnerabilityRecord[];
  };
}
