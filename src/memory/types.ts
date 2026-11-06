export interface DecisionProposal {
  type:
    | "architecture_decision"
    | "engineering_rule"
    | "security_rule"
    | "coding_convention"
    | "exception"
    | "deprecated_pattern";
  title: string;
  content: string;
  rationale: string;
  scope: { paths?: string[]; languages?: string[]; modules?: string[]; conditions?: string[] };
  source: { pullRequestNumber: number; commitSha: string; commentIds: number[] };
  evidence: Array<{ kind: "human_comment" | "code"; reference: string; detail: string }>;
  relation?: { duplicateOf?: string; conflictsWith?: string[]; supersedes?: string; exceptionTo?: string };
  confidence: number;
  uncertainties: string[];
}

export type ImportedMemorySource = {
  kind: "markdown_import" | "project_import";
  importedBy: number;
  importedByLogin: string;
  importedAt: string;
  documentName?: string;
  documentSha256?: string;
  documentRuleId?: string;
  repositoryId?: number;
  repositoryName?: string;
  memoryId?: string;
  memoryVersion?: number;
  pullRequestNumber?: never;
  commitSha?: never;
  commentIds?: never;
};
export type MemorySource = (DecisionProposal["source"] & { kind?: never }) | ImportedMemorySource;

export function memorySourceLabel(source: MemorySource | { kind?: never; pullRequestNumber?: number }) {
  if (source.kind === "markdown_import") return `Markdown 导入 · ${source.documentName} · ${source.documentRuleId}`;
  if (source.kind === "project_import") return `项目导入 · ${source.repositoryName} · v${source.memoryVersion}`;
  return source.pullRequestNumber ? `来源 PR #${source.pullRequestNumber}` : "来源未记录";
}

export interface MemoryRecord {
  activeVersion?: number;
  id: string;
  version: number;
  repositoryId: number;
  installationId: number;
  type: DecisionProposal["type"];
  title: string;
  content: string;
  rationale: string;
  scope: DecisionProposal["scope"];
  source: MemorySource;
  evidence: DecisionProposal["evidence"];
  confidence: number | null;
  uncertainties: string[];
  status: "CANDIDATE" | "ACTIVE" | "SUPERSEDED" | "DEPRECATED" | "REJECTED";
  exceptionTo?: string;
  supersedes?: string;
  supersededBy?: string;
  approvedBy?: number;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
