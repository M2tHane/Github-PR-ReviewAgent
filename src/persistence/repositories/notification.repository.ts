import type { Pool, PoolClient } from "pg";

export interface ReviewNotification {
  jobId: string;
  repositoryId: number;
  installationId: number;
  repository: string;
  prNumber: number;
  headSha: string;
  partial: boolean;
  attempt: number;
}

export type NotificationStatus = "pending" | "sent" | "failed" | "uncertain" | "cancelled";

export class NotificationRepository {
  constructor(private readonly pool: Pool) {}

  async withChannel(channel: string, run: (session: NotificationSession) => Promise<void>) {
    const pending = await this.pool.query(
      `SELECT 1 FROM review_notifications WHERE channel=$1
       AND (status='sending' OR status='pending' AND next_run_at<=now()) LIMIT 1`,
      [channel],
    );
    if (!pending.rowCount) return;
    const client = await this.pool.connect();
    let locked = false;
    try {
      // 会话锁覆盖本次投递；不同服务实例也不能同时给同一个群发送。进程退出时锁自动释放。
      const result = await client.query("SELECT pg_try_advisory_lock(72419,hashtext($1)) AS locked", [channel]);
      locked = result.rows[0].locked;
      if (!locked) return;
      await run(new NotificationSession(client, channel));
    } finally {
      try {
        if (locked) await client.query("SELECT pg_advisory_unlock(72419,hashtext($1))", [channel]);
      } finally {
        client.release();
      }
    }
  }
}

export class NotificationSession {
  constructor(
    private readonly client: PoolClient,
    private readonly channel: string,
  ) {}

  async claim(): Promise<ReviewNotification | undefined> {
    // 拿到排他锁后仍为 sending 的记录来自中断的进程；企微没有按消息标识查询的接口，不能重发。
    await this.client.query(
      `UPDATE review_notifications SET status='uncertain',last_error='delivery_interrupted',updated_at=now()
       WHERE channel=$1 AND status='sending'`,
      [this.channel],
    );
    await this.client.query(
      `UPDATE review_notifications SET status='failed',last_error='attempts_exhausted',updated_at=now()
       WHERE channel=$1 AND status='pending' AND attempt>=3`,
      [this.channel],
    );
    await this.client.query("INSERT INTO notification_channels(channel) VALUES($1) ON CONFLICT DO NOTHING", [
      this.channel,
    ]);
    const result = await this.client.query(
      `WITH candidate AS (
         SELECT n.job_id FROM review_notifications n
         JOIN review_publications p ON p.job_id=n.job_id AND p.status='published'
         JOIN notification_channels c ON c.channel=n.channel
         WHERE n.channel=$1 AND n.status='pending' AND n.next_run_at<=now() AND n.attempt<3
           AND (c.last_attempt_at IS NULL OR c.last_attempt_at<=now()-interval '3100 milliseconds')
         ORDER BY n.created_at,n.job_id LIMIT 1
       ), claimed AS (
         UPDATE review_notifications n SET attempt=attempt+1,next_run_at=now()+interval '60 seconds',updated_at=now()
         FROM candidate c WHERE n.job_id=c.job_id RETURNING n.*
       )
       SELECT n.job_id,n.partial,n.attempt,j.repository_id,j.installation_id,j.repository,j.pr_number,j.target_sha
       FROM claimed n JOIN jobs j ON j.id=n.job_id`,
      [this.channel],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      jobId: row.job_id,
      partial: row.partial,
      attempt: row.attempt,
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      repository: row.repository,
      prNumber: row.pr_number,
      headSha: row.target_sha,
    };
  }

  async enabled(notification: ReviewNotification): Promise<boolean> {
    const result = await this.client.query(
      "SELECT 1 FROM repositories WHERE id=$1 AND installation_id=$2 AND enabled=true AND revoked_at IS NULL",
      [notification.repositoryId, notification.installationId],
    );
    return result.rowCount === 1;
  }

  async member(repositoryId: number, githubLogin: string): Promise<string | undefined> {
    const result = await this.client.query(
      "SELECT wecom_userid FROM repository_notification_members WHERE repository_id=$1 AND github_login=$2",
      [repositoryId, githubLogin.toLowerCase()],
    );
    return result.rows[0]?.wecom_userid;
  }

  async sending(jobId: string): Promise<boolean> {
    const result = await this.client.query(
      `WITH reserved AS (
         UPDATE notification_channels SET last_attempt_at=now() WHERE channel=$1 RETURNING channel
       )
       UPDATE review_notifications n SET status='sending',updated_at=now()
       FROM reserved c WHERE n.channel=c.channel AND n.job_id=$2 AND n.status='pending'`,
      [this.channel, jobId],
    );
    return result.rowCount === 1;
  }

  async finish(jobId: string, status: NotificationStatus, error?: string, retrySeconds = 60) {
    await this.client.query(
      `UPDATE review_notifications SET status=$2,last_error=$3,
       next_run_at=now()+$4*interval '1 second',updated_at=now() WHERE job_id=$1`,
      [jobId, status, error ?? null, retrySeconds],
    );
  }
}
