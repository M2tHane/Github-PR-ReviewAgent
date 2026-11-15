import type { Pool } from "pg";
import { TaskLeaseLostError } from "../jobs/runner.js";
import type { DevelopmentTask } from "./types.js";

export interface SideEffectOptions<T> {
  kind: string;
  perform: () => Promise<T>;
  verify: () => Promise<T | undefined>;
}

/**
 * 开发任务所有 GitHub 写操作的最小幂等台账。
 * pending 表示请求可能已经到达远端；接手时先只读核对，核对不到才重做。
 */
export class DevelopmentSideEffects {
  constructor(
    private readonly pool: Pool,
    private readonly task: DevelopmentTask,
  ) {}

  async result<T>(key: string): Promise<T | undefined> {
    const row = (
      await this.pool.query<{ status: "pending" | "done"; result: T | null }>(
        "SELECT status,result FROM side_effects WHERE key=$1",
        [`${this.task.id}:${key}`],
      )
    ).rows[0];
    return row?.status === "done" ? (row.result as T) : undefined;
  }

  private async assertOwner() {
    const owned = await this.pool.query(
      "SELECT 1 FROM development_tasks WHERE id=$1 AND owner_token=$2 AND (status IN ('running','publishing') OR status=$3) AND lease_expires_at>now()",
      [this.task.id, this.task.owner_token, this.task.status],
    );
    if (!owned.rowCount) throw new TaskLeaseLostError("任务执行权已失效");
  }

  async once<T>(key: string, options: SideEffectOptions<T>): Promise<T> {
    await this.assertOwner();
    const fullKey = `${this.task.id}:${key}`;
    const existing = (
      await this.pool.query<{ status: "pending" | "done"; result: T | null }>(
        "SELECT status,result FROM side_effects WHERE key=$1",
        [fullKey],
      )
    ).rows[0];
    if (existing?.status === "done") return existing.result as T;
    if (existing?.status === "pending") {
      const verified = await options.verify();
      if (verified !== undefined) {
        await this.assertOwner();
        await this.pool.query(
          "UPDATE side_effects SET status='done',result=$2,updated_at=now() WHERE key=$1 AND status='pending'",
          [fullKey, JSON.stringify(verified)],
        );
        return verified;
      }
    } else {
      await this.pool.query(
        `INSERT INTO side_effects(key,task_id,kind,status,result,attempts)
         VALUES($1,$2,$3,'pending',NULL,1)
         ON CONFLICT(key) DO UPDATE SET attempts=side_effects.attempts+1,updated_at=now()`,
        [fullKey, this.task.id, options.kind],
      );
    }
    if (existing?.status === "pending")
      await this.pool.query("UPDATE side_effects SET attempts=attempts+1,updated_at=now() WHERE key=$1", [fullKey]);
    // perform 抛错时故意保留 pending：响应可能在远端已生效，下次接手必须先核对。
    await this.assertOwner();
    const result = await options.perform();
    await this.assertOwner();
    await this.pool.query("UPDATE side_effects SET status='done',result=$2,updated_at=now() WHERE key=$1", [
      fullKey,
      JSON.stringify(result),
    ]);
    return result;
  }
}
