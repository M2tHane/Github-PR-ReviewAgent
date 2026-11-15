import type { Pool, PoolClient } from "pg";
import { TaskLeaseLostError } from "../jobs/runner.js";
import { transaction } from "../persistence/transaction.js";
import type { DevelopmentTask } from "./types.js";

// 持锁覆盖本地写入及在途 GitHub 请求；领取方跳过锁住的任务，心跳等待本次事务结束。
export async function withDevelopmentLease<T>(
  pool: Pool,
  task: DevelopmentTask,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await transaction(client, async () => {
      const owned = await client.query(
        "SELECT id FROM development_tasks WHERE id=$1 AND owner_token=$2 AND lease_expires_at>now() FOR SHARE",
        [task.id, task.owner_token],
      );
      if (!owned.rowCount) throw new TaskLeaseLostError("任务执行权已失效");
      return run(client);
    });
  } finally {
    client.release();
  }
}
