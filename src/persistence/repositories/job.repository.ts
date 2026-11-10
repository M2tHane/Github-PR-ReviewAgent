import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import type { AgentJob, ReviewJob } from "../../jobs/types.js";
import { transaction } from "../transaction.js";
import { rowToJob } from "../rows.js";
import { log } from "../../logging.js";

export interface JobAcceptor {
  accept(
    input: Omit<ReviewJob, "id" | "status">,
    meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null },
  ): Promise<{ kind: "accepted" | "duplicate" | "full"; job?: ReviewJob }>;
  acceptReply?(
    input: import("./reply.repository.js").ReviewReplyInput,
  ): Promise<{ kind: "accepted" | "duplicate" | "ignored"; job?: ReviewJob }>;
  isDevelopmentPullRequest?(
    repositoryId: number,
    prNumber: number,
    branch: string | undefined,
    headSha: string,
  ): Promise<boolean>;
  cancelReview?(repositoryId: number, prNumber: number): Promise<void>;
  restoreRepositories?(repositoryIds: number[]): Promise<void>;
  check?(): Promise<void>;
  isStopping?(): boolean;
  revokeInstallation?(input: {
    deliveryId: string;
    event: string;
    action: string;
    installationId: number;
    repositoryIds?: number[];
  }): Promise<{ duplicate: boolean }>;
}

// 所有实例领取任务时排队拿这把锁，"同一个 PR 同一时间只跑一个任务"的判断才不会被并发打破。领取本身只要几毫秒。
const CLAIM_LOCK = 4897034;
export const LEASE_MS = 60_000;
// 临时故障最多执行 5 次，等待 30 秒、1、2、4 分钟（单次最长 15 分钟），能撑过一次几分钟的服务故障。
// 服务方给了 Retry-After 时照它等，最长 1 小时。
export const MAX_ATTEMPTS = 5;
export function retryDelaySeconds(attempt: number, retryAfterSeconds?: number) {
  if (retryAfterSeconds !== undefined) return Math.min(3600, Math.max(0, retryAfterSeconds));
  return Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
}

export class JobRepository {
  private activeReviews = new Map<string, { job: AgentJob; controller: AbortController }>();
  private stopping = false;
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  constructor(readonly pool: Pool) {}
  isStopping() {
    return this.stopping;
  }
  async accept(
    input: Omit<ReviewJob, "id" | "status">,
    meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = await client.query(
        "INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING delivery_id",
        [input.deliveryId, meta.event, meta.action, input.repositoryId, input.installationId],
      );
      if (!delivery.rowCount) {
        const existing = await client.query(
          "SELECT * FROM jobs WHERE delivery_id=$1 ORDER BY created_at DESC LIMIT 1",
          [input.deliveryId],
        );
        await client.query("COMMIT");
        return {
          kind: "duplicate" as const,
          job: existing.rows[0] ? (rowToJob(existing.rows[0]) as ReviewJob) : undefined,
        };
      }
      await client.query(
        "INSERT INTO repositories(id,installation_id,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,revoked_at=NULL,updated_at=now()",
        [input.repositoryId, input.installationId, input.repository],
      );
      const repository = await client.query("SELECT enabled FROM repositories WHERE id=$1", [input.repositoryId]);
      if (!repository.rows[0]?.enabled) {
        await client.query("COMMIT");
        return { kind: "accepted" as const };
      }
      if (meta.action === "closed") {
        this.abortReviews(input.repositoryId, input.prNumber, undefined, "cancelled");
        await this.requestCancel(client, input.repositoryId, input.prNumber, undefined, "cancelled");
        await client.query(
          "UPDATE jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND status='queued'",
          [input.repositoryId, input.prNumber],
        );
        if (!meta.merged) {
          await client.query("COMMIT");
          return { kind: "accepted" as const };
        }
      }
      const jobType = meta.action === "closed" ? "DECISION_EXTRACT" : "PR_REVIEW";
      const targetSha = meta.action === "closed" ? meta.mergeCommitSha : input.headSha;
      if (!targetSha) throw new Error("merged PR 缺少 merge_commit_sha");
      if (jobType === "PR_REVIEW") {
        this.abortReviews(input.repositoryId, input.prNumber, targetSha);
        await this.requestCancel(client, input.repositoryId, input.prNumber, targetSha, "superseded");
        await client.query(
          "UPDATE jobs SET status='superseded',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND target_sha<>$3 AND status='queued'",
          [input.repositoryId, input.prNumber, targetSha],
        );
      }
      const id = randomUUID();
      const inserted = await client.query(
        "INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') ON CONFLICT DO NOTHING RETURNING *",
        [
          id,
          input.deliveryId,
          jobType,
          input.repositoryId,
          input.installationId,
          input.repository,
          input.prNumber,
          targetSha,
          input.baseSha,
          { title: input.title, body: input.body, cloneUrl: input.cloneUrl, originalHeadSha: input.headSha },
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query(
            "SELECT * FROM jobs WHERE repository_id=$1 AND pr_number=$2 AND target_sha=$3 AND job_type=$4 ORDER BY created_at DESC LIMIT 1",
            [input.repositoryId, input.prNumber, targetSha, jobType],
          )
        ).rows[0];
      await client.query("COMMIT");
      return {
        kind: inserted.rowCount ? ("accepted" as const) : ("duplicate" as const),
        job: rowToJob(row) as ReviewJob,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJob(id: string) {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id=$1", [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
  }

  registerReviewAbort(job: AgentJob, controller: AbortController) {
    if (this.stopping) controller.abort("cancelled");
    else this.activeReviews.set(job.id, { job, controller });
  }

  unregisterReviewAbort(job: AgentJob) {
    this.activeReviews.delete(job.id);
  }

  private abortReviews(repositoryId: number, prNumber: number, exceptHead?: string, reason = "superseded") {
    for (const { job, controller } of this.activeReviews.values())
      if (
        job.jobType !== "HEALTH_AUDIT" &&
        job.repositoryId === repositoryId &&
        job.prNumber === prNumber &&
        job.headSha !== exceptHead
      )
        controller.abort(reason);
  }

  // 正在别的实例上跑的任务：写进 cancel_requested，那个实例续租时看到就停下。本实例上的直接中止。
  private async requestCancel(
    client: Pool | PoolClient,
    repositoryId: number,
    prNumber: number | undefined,
    exceptHead: string | undefined,
    reason: "cancelled" | "superseded",
  ) {
    await client.query(
      "UPDATE jobs SET cancel_requested=$4,updated_at=now() WHERE status='running' AND repository_id=$1 AND ($2::int IS NULL OR job_type<>'HEALTH_AUDIT' AND pr_number=$2) AND ($3::text IS NULL OR target_sha<>$3)",
      [repositoryId, prNumber ?? null, exceptHead ?? null, reason],
    );
  }

  async cancelReview(repositoryId: number, prNumber: number) {
    this.abortReviews(repositoryId, prNumber, undefined, "cancelled");
    await this.requestCancel(this.pool, repositoryId, prNumber, undefined, "cancelled");
  }

  async cancelRepository(repositoryId: number) {
    for (const { job, controller } of this.activeReviews.values())
      if (job.repositoryId === repositoryId) controller.abort("cancelled");
    await this.requestCancel(this.pool, repositoryId, undefined, undefined, "cancelled");
  }

  // 续租本实例正在跑的任务，并返回需要中止的任务：别的实例要求取消、任务已被取消，或租约已被别人接手。
  async renewLeases(jobs: AgentJob[], leaseMs = LEASE_MS) {
    const tokens = jobs.map((job) => job.leaseToken).filter((token): token is string => Boolean(token));
    if (!tokens.length) return [];
    const rows = (
      await this.pool.query(
        `WITH renewed AS (
           UPDATE jobs SET lease_expires_at=now()+make_interval(secs=>$2)
           WHERE lease_token=ANY($1::uuid[]) AND status='running' RETURNING lease_token,cancel_requested)
         SELECT t.token::text token,r.lease_token IS NOT NULL owned,r.cancel_requested,j.status
         FROM unnest($1::uuid[]) t(token)
         LEFT JOIN renewed r ON r.lease_token=t.token
         LEFT JOIN jobs j ON j.lease_token=t.token`,
        [tokens, leaseMs / 1000],
      )
    ).rows;
    const stops: Array<{ job: AgentJob; reason: "cancelled" | "superseded" }> = [];
    for (const row of rows) {
      const job = jobs.find((item) => item.leaseToken === row.token)!;
      if (row.owned && row.cancel_requested) stops.push({ job, reason: row.cancel_requested });
      else if (!row.owned && (row.status === "cancelled" || row.status === "superseded"))
        stops.push({ job, reason: row.status });
      else if (!row.owned && !row.status) stops.push({ job, reason: "cancelled" });
    }
    for (const { job, reason } of stops) this.activeReviews.get(job.id)?.controller.abort(reason);
    return stops;
  }

  async revokeInstallation(input: {
    deliveryId: string;
    event: string;
    action: string;
    installationId: number;
    repositoryIds?: number[];
  }) {
    const client = await this.pool.connect();
    try {
      const result = await transaction(client, async () => {
        const delivery = await client.query(
          "INSERT INTO webhook_deliveries(delivery_id,event,action,installation_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery_id",
          [input.deliveryId, input.event, input.action, input.installationId],
        );
        if (!delivery.rowCount) return { duplicate: true, repositories: [] as number[] };
        const rows = (
          await client.query(
            // 暂停安装可以恢复，只停用；卸载或移除仓库才记撤销时间，过了宽限期会删除数据。
            "UPDATE repositories SET enabled=false,revoked_at=CASE WHEN $3 THEN COALESCE(revoked_at,now()) ELSE revoked_at END,updated_at=now() WHERE installation_id=$1 AND ($2::bigint[] IS NULL OR id=ANY($2::bigint[])) RETURNING id",
            [input.installationId, input.repositoryIds ?? null, input.action !== "suspend"],
          )
        ).rows;
        const repositories = rows.map((row) => Number(row.id));
        await client.query(
          "UPDATE jobs SET status='cancelled',last_error='GitHub App 授权已撤销',finished_at=now(),updated_at=now() WHERE repository_id=ANY($1::bigint[]) AND (status='queued' OR status='running' AND job_type IN ('PR_REVIEW','REPLY_HANDLE','HEALTH_AUDIT'))",
          [repositories],
        );
        return { duplicate: false, repositories };
      });
      for (const repositoryId of result.repositories) this.cancelRepository(repositoryId);
      return { duplicate: result.duplicate };
    } finally {
      client.release();
    }
  }

  // 重新安装或重新加入仓库：取消待删除标记，数据不再被清理。
  async restoreRepositories(repositoryIds: number[]) {
    if (!repositoryIds.length) return;
    await this.pool.query("UPDATE repositories SET revoked_at=NULL,updated_at=now() WHERE id=ANY($1::bigint[])", [
      repositoryIds,
    ]);
  }

  stopReviews() {
    this.stopping = true;
    for (const { controller } of this.activeReviews.values()) controller.abort("cancelled");
  }

  // 租约过期（执行它的实例崩溃或失联）的任务重新排队；已被要求取消的直接结束；失联三次的不再重试，防止一个任务反复拖垮实例。
  private async requeueExpired(client: Pool | PoolClient) {
    const result = await client.query(
      `WITH expired AS (
         UPDATE jobs SET
           status=CASE WHEN cancel_requested IS NOT NULL THEN cancel_requested WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,
           next_run_at=CASE WHEN cancel_requested IS NULL AND attempt<3 THEN now() END,
           finished_at=CASE WHEN cancel_requested IS NOT NULL OR attempt>=3 THEN now() END,
           last_error=CASE WHEN cancel_requested IS NOT NULL THEN last_error WHEN attempt>=3 THEN '执行实例多次失联，已停止重试' ELSE '执行实例失联，重新排队' END,
           started_at=NULL,lease_token=NULL,locked_by=NULL,lease_expires_at=NULL,cancel_requested=NULL,updated_at=now()
         WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<now())
         RETURNING id),
       runs AS (
         UPDATE agent_runs SET status='cancelled',error_summary='执行实例失联，旧 Session 已结束',finished_at=now()
         WHERE status='running' AND job_id IN (SELECT id FROM expired))
       SELECT count(*)::int n FROM expired`,
    );
    return Number(result.rows[0].n);
  }

  async recoverExpired() {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_LOCK]);
        return this.requeueExpired(client);
      });
    } finally {
      client.release();
    }
  }

  // allowHealth=false 时不领健康检查，给 PR 任务留出槽位。
  async claimNext(options: { allowHealth?: boolean; leaseMs?: number } = {}): Promise<AgentJob | undefined> {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_LOCK]);
        const recovered = await this.requeueExpired(client);
        if (recovered) log("info", "jobs_recovered", { count: recovered });
        // 同一个 PR 的任务（Review、Reply、规则抽取）一次只跑一个：Reply 要按回复时间顺序处理，
        // 同一 PR 的 Review 和 Reply 读写同一批 finding。规则抽取只写入候选、不影响召回，不需要跨 PR 串行。
        // 同仓库不同 PR 的任务可以同时跑；健康检查是只读快照，不受这个限制。
        const result = await client.query(
          `SELECT * FROM jobs j WHERE status='queued' AND (next_run_at IS NULL OR next_run_at<=now())
             AND ($1 OR job_type<>'HEALTH_AUDIT')
             AND (job_type='HEALTH_AUDIT' OR NOT EXISTS (
               SELECT 1 FROM jobs r WHERE r.status='running' AND r.job_type<>'HEALTH_AUDIT' AND r.repository_id=j.repository_id
                 AND r.pr_number=j.pr_number))
           ORDER BY (job_type='HEALTH_AUDIT'),COALESCE((payload->>'humanReplyCreatedAt')::timestamptz,created_at),COALESCE((payload->>'sourceCommentId')::bigint,0),created_at
           FOR UPDATE SKIP LOCKED LIMIT 1`,
          [options.allowHealth ?? true],
        );
        if (!result.rows[0]) return undefined;
        const updated = await client.query(
          "UPDATE jobs SET status='running',attempt=attempt+1,started_at=now(),updated_at=now(),lease_token=$2,locked_by=$3,lease_expires_at=now()+make_interval(secs=>$4),cancel_requested=NULL WHERE id=$1 RETURNING *",
          [result.rows[0].id, randomUUID(), this.workerId, (options.leaseMs ?? LEASE_MS) / 1000],
        );
        return rowToJob(updated.rows[0]);
      });
    } finally {
      client.release();
    }
  }

  // 服务停止时中止的任务放回队列，这次不计入尝试次数；已被要求取消的按取消处理。
  async releaseJob(job: AgentJob) {
    await this.pool.query(
      "UPDATE jobs SET status=COALESCE(cancel_requested,'queued'),attempt=CASE WHEN cancel_requested IS NULL THEN GREATEST(attempt-1,0) ELSE attempt END,next_run_at=CASE WHEN cancel_requested IS NULL THEN now() END,finished_at=CASE WHEN cancel_requested IS NOT NULL THEN now() END,started_at=NULL,last_error=CASE WHEN cancel_requested IS NULL THEN '服务停止，任务重新排队' ELSE last_error END,lease_token=NULL,locked_by=NULL,lease_expires_at=NULL,cancel_requested=NULL,updated_at=now() WHERE id=$1 AND status='running' AND ($2::uuid IS NULL OR lease_token=$2)",
      [job.id, job.leaseToken ?? null],
    );
  }

  // 带租约的任务只有持有租约的实例能结束：租约过期被别人接手后，旧实例的结果不再写回。
  async finishJob(job: AgentJob) {
    if (job.status === "queued") return;
    const status = job.status === "running" ? "succeeded" : job.status;
    await this.pool.query(
      "UPDATE jobs SET status=$2,last_error=$3,finished_at=now(),updated_at=now(),lease_token=NULL,locked_by=NULL,lease_expires_at=NULL,cancel_requested=NULL WHERE id=$1 AND status NOT IN ('cancelled','superseded') AND ($4::uuid IS NULL OR lease_token=$4)",
      [job.id, status, status === "succeeded" ? null : (job.error ?? null), job.leaseToken ?? null],
    );
  }

  async failJob(job: AgentJob, error: Error, retry: boolean) {
    const delay = retryDelaySeconds(
      job.attempt ?? 1,
      (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds,
    );
    const status =
      job.status === "uncertain"
        ? "uncertain"
        : retry && (job.attempt ?? 1) < MAX_ATTEMPTS
          ? "queued"
          : job.status === "timeout"
            ? "timeout"
            : "failed";
    const updated = await this.pool.query(
      "UPDATE jobs SET status=$2,last_error=$3,next_run_at=CASE WHEN $2='queued' THEN now()+($4 || ' seconds')::interval ELSE NULL END,finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,updated_at=now(),lease_token=NULL,locked_by=NULL,lease_expires_at=NULL,cancel_requested=NULL WHERE id=$1 AND status NOT IN ('cancelled','superseded') AND ($5::uuid IS NULL OR lease_token=$5) RETURNING status",
      [job.id, status, error.message, delay, job.leaseToken ?? null],
    );
    job.status = updated.rows[0]?.status ?? (await this.getJob(job.id))?.status ?? status;
  }
}
