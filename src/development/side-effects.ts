import type { Pool } from "pg";
import { withDevelopmentLease } from "./lease.js";
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

  async started(): Promise<boolean> {
    return Boolean(
      (await this.pool.query("SELECT 1 FROM side_effects WHERE task_id=$1 LIMIT 1", [this.task.id])).rowCount,
    );
  }

  async once<T>(key: string, options: SideEffectOptions<T>): Promise<T> {
    const fullKey = `${this.task.id}:${key}`;
    // 意图先独立提交：进程在远端写入后硬退出，接手者仍然能看到 pending。
    const inserted = await withDevelopmentLease(this.pool, this.task, async (client) =>
      client.query(
        `INSERT INTO side_effects(key,task_id,kind,status,result,attempts)
         VALUES($1,$2,$3,'pending',NULL,0) ON CONFLICT(key) DO NOTHING`,
        [fullKey, this.task.id, options.kind],
      ),
    );
    const outcome = await withDevelopmentLease(this.pool, this.task, async (client) => {
      const existing = (
        await client.query<{ status: "pending" | "done"; result: T | null }>(
          "SELECT status,result FROM side_effects WHERE key=$1 FOR UPDATE",
          [fullKey],
        )
      ).rows[0];
      if (existing.status === "done") return { ok: true as const, value: existing.result as T };
      let value: T;
      try {
        const verified = inserted.rowCount ? undefined : await options.verify();
        if (verified !== undefined) value = verified;
        else {
          await client.query("UPDATE side_effects SET attempts=attempts+1,updated_at=now() WHERE key=$1", [fullKey]);
          value = await options.perform();
        }
      } catch (error) {
        // 响应可能丢失；提交 pending 与尝试次数，释放锁之后再把错误交给执行器。
        return { ok: false as const, error };
      }
      await client.query("UPDATE side_effects SET status='done',result=$2,updated_at=now() WHERE key=$1", [
        fullKey,
        JSON.stringify(value),
      ]);
      return { ok: true as const, value };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
