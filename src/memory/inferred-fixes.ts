import type { Pool } from "pg";
import type { GitHubClient } from "../github/client.js";
import type { ReviewJob } from "../jobs/types.js";
import { log } from "../logging.js";

// hunk 的旧侧范围以 finding 当时的 head 为坐标；纯新增块（旧侧行数 0）按插入位置算，常见的"补一个判断"也算改到附近。
export function patchTouchesLine(patch: string, line: number) {
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(match[1]),
      count = match[2] === undefined ? 1 : Number(match[2]);
    if (start <= line + 3 && start + Math.max(count, 1) - 1 >= line - 3) return true;
  }
  return false;
}

export async function inferMergedFixes(
  pool: Pool,
  github: Pick<GitHubClient, "compareFiles">,
  token: string,
  job: ReviewJob,
  // PR 合并前最后的 head。不用合并提交：squash／rebase 合并的提交不以 finding 的 head 为祖先，行号对不上。
  finalHead: string,
) {
  // 最后一个 head 的 Review 仍认作重复的问题没有修好，附近改过也不推断。
  const { rows } = await pool.query<{ id: string; head_sha: string; path: string; line: number }>(
    `SELECT id,head_sha,path,line FROM review_findings f
     WHERE repository_id=$1 AND pr_number=$2 AND status IN ('OPEN','STILL_VALID','NEEDS_CLARIFICATION')
       AND path IS NOT NULL AND line IS NOT NULL AND side='RIGHT'
       AND NOT (presentation ? 'repeatOf') AND inferred_fixed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM review_findings r
         WHERE r.repository_id=$1 AND r.pr_number=$2 AND r.head_sha=$3 AND r.presentation->'repeatOf'->>'id'=f.id
       )`,
    [job.repositoryId, job.prNumber, finalHead],
  );
  for (const head of new Set(rows.map((row) => row.head_sha))) {
    let files: Awaited<ReturnType<GitHubClient["compareFiles"]>>["files"];
    try {
      const compared = await github.compareFiles(token, job.repository, head, finalHead);
      // 强推后旧 head 不再是祖先，旧侧行号不再对应 finding 的位置，不推断。
      if (compared.status !== "ahead") continue;
      files = compared.files;
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
        [fixed.map((row) => row.id), finalHead],
      );
  }
}
