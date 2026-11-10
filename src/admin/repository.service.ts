import type { Database } from "../persistence/database.js";
import { GitHubClient } from "../github/client.js";
import { repository, type JobPage, type Overview, type Repository, type Session } from "./dto.js";
import { SESSION_SUMMARY } from "../persistence/repositories/agent-session.repository.js";

export const JOB_TYPES = ["PR_REVIEW", "REPLY_HANDLE", "DECISION_EXTRACT", "HEALTH_AUDIT"];
export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timeout",
  "superseded",
  "cancelled",
  "uncertain",
];
// 需要人排查的任务状态；概览计数和运行记录的默认筛选共用。
export const ATTENTION_STATUSES = ["failed", "timeout", "uncertain"];
export const MAX_PAGE_SIZE = 100;

export type JobFilter = { type?: string; repositoryId?: number; statuses?: string[]; page: number; pageSize: number };

// 列表行：新问题按严重度计数，和之前仍未解决的重复问题分开。
const JOB_COLUMNS = `j.*,
  (SELECT count(*)::int FROM review_findings f WHERE f.job_id=j.id) finding_count,
  (SELECT COALESCE(jsonb_object_agg(severity, n), '{}') FROM (
     SELECT severity, count(*)::int n FROM review_findings f
     WHERE f.job_id=j.id AND NOT (f.presentation ? 'repeatOf') GROUP BY severity
   ) s) new_severity_counts,
  (SELECT count(*)::int FROM review_findings f WHERE f.job_id=j.id AND f.presentation ? 'repeatOf') repeat_count,
  p.github_review_url`;
const RUN_COLUMNS = `,
  COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'job_id' ORDER BY a.started_at) FROM agent_runs a WHERE a.job_id=j.id),'[]') agent_runs,
  COALESCE((SELECT jsonb_agg(${SESSION_SUMMARY("s")} ORDER BY s.started_at) FROM agent_sessions s WHERE s.job_id=j.id),'[]') agent_sessions`;
const listRow = ({ review_result, ...row }: Record<string, unknown>) => ({
  ...row,
  report_available: Boolean(review_result),
});

export function createRepositoryService(database: Database, github: GitHubClient) {
  async function allowedRepositories(user: Session) {
    const result = await database.pool.query("SELECT * FROM repositories ORDER BY full_name");
    const values: Repository[] = [];
    // 每次请求重新授权；只在本次聚合读取复用，不缓存权限结论。
    for (let offset = 0; offset < result.rows.length; offset += 4) {
      const batch = result.rows.slice(offset, offset + 4);
      const checks = await Promise.allSettled(
        batch.map((row) => github.hasMaintainerPermission(user.token, String(row.full_name))),
      );
      for (const [index, check] of checks.entries()) {
        if (check.status === "rejected") throw check.reason;
        if (check.value) values.push(repository(batch[index]!));
      }
    }
    return values;
  }

  // 分页的任务列表；筛选和总数都在数据库里算，页面不再只看最近 200 条。
  async function listJobs(ids: number[], filter: JobFilter): Promise<JobPage> {
    const scoped = filter.repositoryId === undefined ? ids : ids.filter((id) => id === filter.repositoryId);
    const page = { page: filter.page, pageSize: filter.pageSize };
    if (!scoped.length) return { items: [], total: 0, ...page };
    const where = `j.repository_id=ANY($1::bigint[]) AND ($2::text IS NULL OR j.job_type=$2) AND ($3::text[] IS NULL OR j.status=ANY($3))`;
    const values = [scoped, filter.type ?? null, filter.statuses?.length ? filter.statuses : null];
    const [rows, count] = await Promise.all([
      database.pool.query(
        `SELECT ${JOB_COLUMNS}${RUN_COLUMNS}
         FROM jobs j LEFT JOIN review_publications p ON p.job_id=j.id
         WHERE ${where} ORDER BY j.created_at DESC, j.id DESC LIMIT $4 OFFSET $5`,
        [...values, filter.pageSize, (filter.page - 1) * filter.pageSize],
      ),
      database.pool.query(`SELECT count(*)::int total FROM jobs j WHERE ${where}`, values),
    ]);
    return { items: rows.rows.map(listRow) as JobPage["items"], total: Number(count.rows[0].total), ...page };
  }

  // 概览页的数字：全部由数据库统计，不受列表分页影响。
  async function overview(ids: number[]): Promise<Overview> {
    const quality = { days: 30, reviews: 0, findings: 0, fixed: 0, withdrawn: 0, exception: 0, discussing: 0, open: 0 };
    if (!ids.length) return { attention: 0, reviewsThisWeek: 0, latestReviews: [], quality };
    const [counts, latest, findings] = await Promise.all([
      database.pool.query(
        `SELECT
           count(*) FILTER (WHERE status=ANY($2::text[]) AND created_at >= now() - interval '7 days')::int attention,
           count(*) FILTER (WHERE job_type='PR_REVIEW' AND created_at >= now() - interval '7 days')::int reviews_week,
           count(*) FILTER (WHERE job_type='PR_REVIEW' AND status IN ('succeeded','partial') AND created_at >= now() - interval '30 days')::int reviews_month
         FROM jobs WHERE repository_id=ANY($1::bigint[])`,
        [ids, ATTENTION_STATUSES],
      ),
      // 每个 PR 只取最近一次审查。
      database.pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (repository_id, pr_number) id, created_at FROM jobs
           WHERE job_type='PR_REVIEW' AND repository_id=ANY($1::bigint[])
           ORDER BY repository_id, pr_number, created_at DESC
         ), picked AS (SELECT id FROM latest ORDER BY created_at DESC LIMIT 8)
         SELECT ${JOB_COLUMNS}
         FROM jobs j LEFT JOIN review_publications p ON p.job_id=j.id
         WHERE j.id IN (SELECT id FROM picked) ORDER BY j.created_at DESC`,
        [ids],
      ),
      // 已发布的新意见（不含“之前提过”的重复项）按开发者回复后的状态分布。
      database.pool.query(
        `SELECT count(*)::int findings,
           count(*) FILTER (WHERE status='FIXED')::int fixed,
           count(*) FILTER (WHERE status='WITHDRAWN')::int withdrawn,
           count(*) FILTER (WHERE status='EXCEPTION_PENDING')::int exception,
           count(*) FILTER (WHERE status IN ('STILL_VALID','NEEDS_CLARIFICATION'))::int discussing,
           count(*) FILTER (WHERE status='OPEN')::int open
         FROM review_findings
         WHERE repository_id=ANY($1::bigint[]) AND created_at >= now() - interval '30 days'
           AND binding_status<>'pending' AND NOT (presentation ? 'repeatOf')`,
        [ids],
      ),
    ]);
    return {
      attention: Number(counts.rows[0].attention),
      reviewsThisWeek: Number(counts.rows[0].reviews_week),
      latestReviews: latest.rows.map(listRow) as Overview["latestReviews"],
      quality: { ...quality, reviews: Number(counts.rows[0].reviews_month), ...findings.rows[0] },
    };
  }
  return { allowedRepositories, listJobs, overview };
}
