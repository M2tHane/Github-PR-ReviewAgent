import type { Pool } from "pg";
import type { ReviewJob } from "../../jobs/types.js";
import type { ReviewResult } from "../../review/types.js";

export class ReviewPublicationRepository {
  constructor(readonly pool: Pool) {}
  async beginPublication(job: ReviewJob, fingerprint: string) {
    const result = await this.pool.query("INSERT INTO review_publications(job_id,fingerprint,status) VALUES($1,$2,'pending') ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING *,(xmax=0) AS inserted", [job.id, fingerprint]);
    // inserted=false 表示已有发布记录，调用方需要先核对 GitHub 再决定是否发布。
    return result.rows[0] as { status: string; github_review_id?: string; github_review_url?: string; inserted: boolean };
  }

  async finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain") {
    await this.pool.query("UPDATE review_publications SET status=$2,github_review_id=$3,github_review_url=$4,updated_at=now() WHERE job_id=$1", [job.id, status, job.reviewId ?? null, job.reviewUrl ?? null]);
  }

  async saveReviewResult(job: ReviewJob, result: ReviewResult) {
    await this.pool.query("UPDATE jobs SET review_result=$2 WHERE id=$1", [job.id, JSON.stringify(result)]);
  }

}
