import type { Pool } from "pg";

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
    private readonly taskId: string,
  ) {}

  async once<T>(key: string, options: SideEffectOptions<T>): Promise<T> {
    const fullKey = `${this.taskId}:${key}`;
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
        [fullKey, this.taskId, options.kind],
      );
    }
    if (existing?.status === "pending")
      await this.pool.query("UPDATE side_effects SET attempts=attempts+1,updated_at=now() WHERE key=$1", [fullKey]);
    // perform 抛错时故意保留 pending：响应可能在远端已生效，下次接手必须先核对。
    const result = await options.perform();
    await this.pool.query("UPDATE side_effects SET status='done',result=$2,updated_at=now() WHERE key=$1", [
      fullKey,
      JSON.stringify(result),
    ]);
    return result;
  }
}
