import type { Pool, PoolClient } from "pg";

export interface RetentionPolicy {
  // 任务和它的审查结果、Agent 记录保留多少天；0 表示永久保留。
  retentionDays: number;
  // 撤销授权后再等多少天删除这个仓库的全部数据（含团队规则）；0 表示不删除。
  revokedGraceDays: number;
}
export interface PurgeResult {
  skipped?: "locked";
  jobs: number;
  deliveries: number;
  repositories: number;
  // 开发任务的执行记录（Agent 会话）；PR 任务的会话随任务一起删除，不单独计数。
  sessions: number;
}

const BATCH = 500;
const PURGE_LOCK = 4897033;

export class RetentionRepository {
  constructor(private pool: Pool) {}

  // 每批最多删 500 条，避免长时间锁表；多个实例同时跑时只有拿到锁的那个会执行。
  async purgeExpired(policy: RetentionPolicy, now = new Date()): Promise<PurgeResult> {
    const result: PurgeResult = { jobs: 0, deliveries: 0, repositories: 0, sessions: 0 };
    const client = await this.pool.connect();
    try {
      if (!(await client.query("SELECT pg_try_advisory_lock($1) locked", [PURGE_LOCK])).rows[0].locked)
        return { ...result, skipped: "locked" };
      try {
        if (policy.revokedGraceDays > 0)
          result.repositories = await this.purgeRevoked(client, days(now, policy.revokedGraceDays), result);
        if (policy.retentionDays > 0) {
          const cutoff = days(now, policy.retentionDays);
          // PR 相关任务按 PR 整组删除：这个 PR 最近一次活动早于保留期才删，
          // 还在活跃的 PR 保留全部历史，"之前提过的问题"去重和线程回复才不会断。
          result.jobs += await batches(
            client,
            BATCH,
            [cutoff],
            `
            DELETE FROM jobs WHERE id IN (
              SELECT j.id FROM jobs j
              WHERE j.job_type<>'HEALTH_AUDIT' AND j.status NOT IN ('queued','running')
                AND NOT EXISTS (
                  SELECT 1 FROM jobs r
                  WHERE r.repository_id=j.repository_id AND r.pr_number=j.pr_number AND r.job_type<>'HEALTH_AUDIT'
                    AND (r.status IN ('queued','running') OR r.updated_at>=$1))
              LIMIT $2)`,
          );
          // 健康检查：每个仓库保留最近一份报告，管理页总有一份可看、可对比。
          result.jobs += await batches(
            client,
            BATCH,
            [cutoff],
            `
            DELETE FROM jobs WHERE id IN (
              SELECT j.id FROM jobs j
              WHERE j.job_type='HEALTH_AUDIT' AND j.status NOT IN ('queued','running') AND j.updated_at<$1
                AND j.id IS DISTINCT FROM (
                  SELECT h.job_id FROM health_reports h JOIN jobs l ON l.id=h.job_id
                  WHERE l.repository_id=j.repository_id ORDER BY h.created_at DESC LIMIT 1)
              LIMIT $2)`,
          );
          // 开发任务记录保留，只删过期的执行过程记录。
          result.sessions += await batches(
            client,
            BATCH,
            [cutoff],
            `
            DELETE FROM agent_sessions WHERE id IN (
              SELECT id FROM agent_sessions WHERE development_task_id IS NOT NULL AND created_at<$1 LIMIT $2)`,
          );
          // 投递记录只用于去重；没有任务引用、又过了保留期的才删。
          result.deliveries += await batches(
            client,
            BATCH,
            [cutoff],
            `
            DELETE FROM webhook_deliveries WHERE delivery_id IN (
              SELECT d.delivery_id FROM webhook_deliveries d
              WHERE d.received_at<$1 AND NOT EXISTS (SELECT 1 FROM jobs WHERE delivery_id=d.delivery_id)
              LIMIT $2)`,
          );
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [PURGE_LOCK]);
      }
      return result;
    } finally {
      client.release();
    }
  }

  private async purgeRevoked(client: PoolClient, cutoff: Date, result: PurgeResult) {
    const repositories = (
      await client.query("SELECT id FROM repositories WHERE revoked_at<$1 ORDER BY id LIMIT 100", [cutoff])
    ).rows.map((row) => row.id);
    let removed = 0;
    for (const id of repositories) {
      result.jobs += await batches(
        client,
        BATCH,
        [id],
        "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE repository_id=$1 AND status NOT IN ('queued','running') LIMIT $2)",
      );
      await client.query("BEGIN");
      try {
        // 还有没结束的任务就下次再删仓库本身。
        const active = await client.query("SELECT 1 FROM jobs WHERE repository_id=$1 LIMIT 1", [id]);
        if (!active.rowCount) {
          await client.query(
            "DELETE FROM memory_audits WHERE memory_id IN (SELECT id FROM memories WHERE repository_id=$1)",
            [id],
          );
          await client.query("DELETE FROM memories WHERE repository_id=$1", [id]);
          await client.query("DELETE FROM decision_clues WHERE repository_id=$1", [id]);
          await client.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [id]);
          removed += (await client.query("DELETE FROM repositories WHERE id=$1 AND revoked_at<$2", [id, cutoff]))
            .rowCount!;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return removed;
  }
}

function days(now: Date, count: number) {
  return new Date(now.getTime() - count * 86_400_000);
}

async function batches(client: PoolClient, size: number, params: unknown[], sql: string) {
  let total = 0;
  for (;;) {
    const deleted = (await client.query(sql, [...params, size])).rowCount ?? 0;
    total += deleted;
    if (deleted < size) return total;
  }
}
