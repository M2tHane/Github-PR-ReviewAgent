import type { Actor } from "../memory/memory.service.js";
import type { AgentUsage } from "../review/agent.js";
import type { OrchestrationSummary, ReviewResult } from "../review/types.js";
import type { HealthScope } from "../health/types.js";
import type { AgentJob } from "../jobs/types.js";

export type Session = Actor & { token: string; csrf: string; expiresAt: number };
export type Repository = {
  id: number;
  installationId: number;
  fullName: string;
  enabled: boolean;
  includePaths: string[];
  excludePaths: string[];
  outputLanguage: string;
  budgetTokens: number;
  healthSchedule: "off" | "daily" | "weekly";
  healthNextRunAt: string | null;
  healthLastError: string | null;
};

export function repository(row: Record<string, unknown>): Repository {
  return {
    id: Number(row.id),
    installationId: Number(row.installation_id),
    fullName: String(row.full_name),
    enabled: Boolean(row.enabled),
    includePaths: row.include_paths as string[],
    excludePaths: row.exclude_paths as string[],
    outputLanguage: String(row.output_language),
    budgetTokens: Number(row.budget_tokens),
    healthSchedule: row.health_schedule as Repository["healthSchedule"],
    healthNextRunAt: row.health_next_run_at instanceof Date ? row.health_next_run_at.toISOString() : null,
    healthLastError: row.health_last_error ? String(row.health_last_error) : null,
  };
}

// 管理 API 返回的任务行：jobs 表的原始列（snake_case），加上各接口 JOIN 出来的附加列。前后端共用这一份定义。
export type JobPayload = {
  title?: string;
  body?: string;
  cloneUrl?: string;
  originalHeadSha?: string;
  defaultBranch?: string;
  windowStart?: string;
  windowEnd?: string;
  trigger?: "manual" | "schedule";
  scheduledFor?: string;
  scope?: HealthScope;
  [key: string]: unknown;
};
export type AgentRunRow = {
  id: string;
  role: string;
  status: "running" | "succeeded" | "partial" | "failed" | "timeout" | "cancelled";
  model: string | null;
  input_budget_tokens: number;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage: Partial<AgentUsage>;
  orchestration: OrchestrationSummary | null;
  coverage: string[];
  limitations: string[];
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
};
export type JobRow = {
  id: string;
  delivery_id: string | null;
  job_type: NonNullable<AgentJob["jobType"]>;
  repository_id: number;
  installation_id: number;
  repository: string;
  pr_number: number | null;
  target_sha: string;
  base_sha: string | null;
  payload: JobPayload;
  review_result: ReviewResult | null;
  status: AgentJob["status"];
  attempt: number;
  next_run_at: string | null;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  // 列表接口
  github_review_url?: string | null;
  finding_count?: number;
  new_severity_counts?: Record<string, number>;
  repeat_count?: number;
  agent_runs?: AgentRunRow[];
  // 详情接口
  finding_statuses?: Array<{ id: string; status: string }>;
  // 健康检查列表
  has_report?: boolean;
  health_summary?: string | null;
};
