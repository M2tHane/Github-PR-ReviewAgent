import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../config/config.js";
import {
  DevelopmentError,
  type DevelopmentSettings,
  type DevelopmentTask,
  type GroupRequest,
  type TaskStatus,
} from "./types.js";

export class DevelopmentStore {
  constructor(readonly pool: Pool) {}
  async isDevelopmentPullRequest(repositoryId: number, prNumber: number, branch: string | undefined, headSha: string) {
    const known = await this.pool.query("SELECT 1 FROM development_tasks WHERE repository_id=$1 AND pr_number=$2", [
      repositoryId,
      prNumber,
    ]);
    if (known.rowCount) return true;
    if (!branch?.startsWith("bot/development/")) return false;
    const matched = await this.pool.query(
      `UPDATE development_tasks SET pr_number=$2 WHERE repository_id=$1 AND branch=$3 AND head_sha=$4
      AND pr_number IS NULL AND status IN ('publishing','succeeded','uncertain') RETURNING id`,
      [repositoryId, prNumber, branch, headSha],
    );
    return Boolean(matched.rowCount);
  }
  async settings(repositoryId: number): Promise<DevelopmentSettings | undefined> {
    return (
      await this.pool.query(
        `SELECT chat_id AS "chatId",target_branch AS "targetBranch",enabled,members,protections,version
      FROM development_settings WHERE repository_id=$1`,
        [repositoryId],
      )
    ).rows[0];
  }
  async saveSettings(repositoryId: number, value: DevelopmentSettings, actor: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM repositories WHERE id=$1 FOR UPDATE", [repositoryId]);
      const current = (
        await client.query("SELECT version FROM development_settings WHERE repository_id=$1 FOR UPDATE", [repositoryId])
      ).rows[0];
      if ((current?.version ?? 0) !== value.version) throw new DevelopmentError("设置已被其他人修改，请刷新后再保存");
      await client.query(
        `INSERT INTO development_settings(repository_id,chat_id,target_branch,enabled,members,protections,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(repository_id) DO UPDATE SET chat_id=$2,target_branch=$3,enabled=$4,members=$5,
        protections=$6,updated_by=$7,version=development_settings.version+1,updated_at=now()`,
        [
          repositoryId,
          value.chatId,
          value.targetBranch,
          value.enabled,
          JSON.stringify(value.members),
          JSON.stringify(value.protections),
          actor,
        ],
      );
      await client.query("INSERT INTO development_settings_audits(repository_id,actor,settings) VALUES($1,$2,$3)", [
        repositoryId,
        actor,
        JSON.stringify(value),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new DevelopmentError("该群已经绑定其他仓库");
      throw error;
    } finally {
      client.release();
    }
    return this.settings(repositoryId);
  }
  async accept(botId: string, input: GroupRequest, config: Pick<Config, "allowedRepositories" | "queueCapacity">) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4897040)");
      if (
        (
          await client.query("SELECT id FROM development_tasks WHERE bot_id=$1 AND message_id=$2", [
            botId,
            input.messageId,
          ])
        ).rowCount
      ) {
        await client.query("COMMIT");
        return "duplicate" as const;
      }
      const binding = (
        await client.query(
          `SELECT s.*,r.full_name,r.installation_id FROM development_settings s JOIN repositories r ON r.id=s.repository_id
        WHERE s.chat_id=$1 AND s.enabled AND r.enabled AND r.revoked_at IS NULL FOR SHARE OF s,r`,
          [input.chatId],
        )
      ).rows[0];
      if (!binding || !config.allowedRepositories.has(binding.full_name.toLowerCase()))
        throw new DevelopmentError("此群未绑定已启用的开发仓库，请联系管理员。", "refused");
      const member = (binding.members as DevelopmentSettings["members"]).find((m) => m.userid === input.requester);
      if (!member) throw new DevelopmentError("你尚未被设置为该仓库的管理员或开发，不能发起开发任务。", "refused");
      const count = (
        await client.query(
          "SELECT count(*)::int n FROM development_tasks WHERE bot_id=$1 AND status IN ('queued','running','publishing')",
          [botId],
        )
      ).rows[0].n;
      if (count >= config.queueCapacity)
        throw new DevelopmentError("开发任务队列已满，请稍后重新发起任务。", "refused");
      const id = randomUUID();
      await client.query(
        `INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,
        settings_version,role,prompt,images,reply_req_id,reply_expires_at,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued')`,
        [
          id,
          botId,
          input.messageId,
          input.chatId,
          input.requester,
          binding.repository_id,
          binding.installation_id,
          binding.full_name,
          binding.target_branch,
          `bot/development/${id}`,
          binding.version,
          member.role,
          input.text,
          JSON.stringify(input.images),
          input.replyRequestId,
          new Date(input.receivedAt.getTime() + 24 * 60 * 60 * 1000),
        ],
      );
      await client.query("COMMIT");
      return "accepted" as const;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async claim(botId: string): Promise<DevelopmentTask | undefined> {
    return (
      await this.pool.query(
        `UPDATE development_tasks SET status='running',owner_token=$2,started_at=now(),updated_at=now() WHERE id=(
      SELECT id FROM development_tasks WHERE bot_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1) RETURNING *`,
        [botId, randomUUID()],
      )
    ).rows[0];
  }
  async permission(task: DevelopmentTask, config: Pick<Config, "allowedRepositories">) {
    const row = (
      await this.pool.query(
        `SELECT s.protections FROM development_settings s JOIN repositories r ON r.id=s.repository_id
      WHERE s.repository_id=$1 AND s.version=$2 AND s.chat_id=$3 AND s.target_branch=$4 AND s.enabled AND r.enabled
      AND EXISTS (SELECT 1 FROM development_tasks t WHERE t.id=$9 AND t.owner_token=$10 AND t.status IN ('running','publishing'))
      AND r.revoked_at IS NULL AND r.installation_id=$5 AND r.full_name=$6 AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.members) m WHERE m->>'userid'=$7 AND m->>'role'=$8)`,
        [
          task.repository_id,
          task.settings_version,
          task.chat_id,
          task.target_branch,
          task.installation_id,
          task.repository,
          task.requester,
          task.role,
          task.id,
          task.owner_token,
        ],
      )
    ).rows[0];
    if (!row || !config.allowedRepositories.has(task.repository.toLowerCase()))
      throw new DevelopmentError(
        "任务已取消：仓库、群绑定、成员身份或保护设置已变化，请按新设置重新发起。",
        "cancelled",
      );
    return {
      protections: row.protections as DevelopmentSettings["protections"],
    };
  }
  async finish(task: DevelopmentTask, status: TaskStatus, result: string) {
    await this.pool.query(
      "UPDATE development_tasks SET status=$2,result=$3,images='[]',duration_ms=(EXTRACT(EPOCH FROM (now()-started_at))*1000)::integer,updated_at=now() WHERE id=$1 AND owner_token=$4",
      [task.id, status, result, task.owner_token],
    );
  }
  async checkpoint(
    task: DevelopmentTask,
    fields: {
      baseSha?: string;
      headSha?: string;
      title?: string;
      rules?: unknown;
      usage?: unknown;
      durationMs?: number;
      publishing?: boolean;
      prNumber?: number;
      model?: string;
    },
  ) {
    const result = await this.pool.query(
      `UPDATE development_tasks SET base_sha=COALESCE($3,base_sha),head_sha=COALESCE($4,head_sha),
      title=COALESCE($5,title),rule_snapshot=COALESCE($6,rule_snapshot),usage=COALESCE($7,usage),duration_ms=COALESCE($8,duration_ms),
      status=CASE WHEN $9 THEN 'publishing' ELSE status END,pr_number=COALESCE($10,pr_number),model=COALESCE($11,model),updated_at=now()
      WHERE id=$1 AND owner_token=$2 AND status IN ('running','publishing')`,
      [
        task.id,
        task.owner_token,
        fields.baseSha,
        fields.headSha,
        fields.title,
        fields.rules === undefined ? null : JSON.stringify(fields.rules),
        fields.usage === undefined ? null : JSON.stringify(fields.usage),
        fields.durationMs,
        fields.publishing ?? false,
        fields.prNumber,
        fields.model,
      ],
    );
    if (!result.rowCount) throw new DevelopmentError("任务执行权已失效", "cancelled");
  }
  async recover(botId: string) {
    await this.pool.query(
      `UPDATE development_tasks SET status=CASE WHEN status='publishing' THEN 'uncertain' ELSE 'cancelled' END,
      result=CASE WHEN status='publishing' THEN '服务中断，PR 发布结果待核对；不会自动重复提交。' ELSE '服务中断，开发任务已取消，请重新发起。' END,
      images='[]',owner_token=NULL,updated_at=now() WHERE bot_id=$1 AND status IN ('running','publishing')`,
      [botId],
    );
    await this.pool.query(
      "UPDATE development_tasks SET notification_status='uncertain',notification_error='delivery_interrupted' WHERE bot_id=$1 AND notification_status='sending'",
      [botId],
    );
  }
  async list(repositoryId: number) {
    return (
      await this.pool.query(
        `SELECT id,requester,status,branch,target_branch,base_sha,head_sha,pr_number,title,result,model,usage,duration_ms,
      notification_status,notification_error,created_at FROM development_tasks WHERE repository_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [repositoryId],
      )
    ).rows;
  }
  async withLeader(botId: string, run: (client: PoolClient) => Promise<void>) {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      locked = (await client.query("SELECT pg_try_advisory_lock(4897041,hashtext($1)) locked", [botId])).rows[0].locked;
      if (locked) await run(client);
    } finally {
      if (locked)
        await client.query("SELECT pg_advisory_unlock(4897041,hashtext($1))", [botId]).catch(() => {
          broken = true;
        });
      client.release(broken);
    }
  }
}
