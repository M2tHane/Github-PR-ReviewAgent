import type { Pool } from "pg";
import type { GitHubClient } from "../github/client.js";
import type { ReviewJob } from "../jobs/types.js";
import { log } from "../logging.js";

// hunk 的旧侧范围以 finding 当时的 head 为坐标；纯新增块没有旧侧行，不能据此推断。
export function patchTouchesLine(patch: string, line: number) {
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(match[1]),
      count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0 && start <= line + 3 && start + count - 1 >= line - 3) return true;
  }
  return false;
}

export async function inferMergedFixes(
  pool: Pool,
  github: Pick<GitHubClient, "compareFiles">,
  token: string,
  job: ReviewJob,
) {
  const { rows } = await pool.query<{ id: string; head_sha: string; path: string; line: number }>(
    `SELECT id,head_sha,path,line FROM review_findings
     WHERE repository_id=$1 AND pr_number=$2 AND status IN ('OPEN','STILL_VALID','NEEDS_CLARIFICATION')
       AND path IS NOT NULL AND line IS NOT NULL AND side='RIGHT'
       AND NOT (presentation ? 'repeatOf') AND inferred_fixed_at IS NULL`,
    [job.repositoryId, job.prNumber],
  );
  for (const head of new Set(rows.map((row) => row.head_sha))) {
    let files: Awaited<ReturnType<GitHubClient["compareFiles"]>>;
    try {
      files = await github.compareFiles(token, job.repository, head, job.headSha);
    } catch (error) {
      log("error", "inferred_fix_compare_failed", {
        jobId: job.id,
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        headSha: head,
        error,
      });
      continue;
    }
    const fixed = rows.filter(
      (row) =>
        row.head_sha === head &&
        files.some(
          (file) =>
            (file.previous_filename ?? file.filename) === row.path &&
            file.patch !== undefined &&
            patchTouchesLine(file.patch, row.line),
        ),
    );
    if (fixed.length)
      await pool.query(
        `UPDATE review_findings SET inferred_fixed_at=now(),inferred_fixed_sha=$2
       WHERE id=ANY($1::text[]) AND inferred_fixed_at IS NULL AND status IN ('OPEN','STILL_VALID','NEEDS_CLARIFICATION')`,
        [fixed.map((row) => row.id), job.headSha],
      );
  }
}
