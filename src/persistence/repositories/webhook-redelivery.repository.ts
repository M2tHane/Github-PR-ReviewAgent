import type { Pool } from "pg";

const REDELIVERY_LOCK = 4897035;

export class WebhookRedeliveryRepository {
  constructor(private pool: Pool) {}

  // 多个实例同时到点时只有拿到锁的那个执行，其余返回 undefined 跳过本轮。
  // 锁跟着这条连接走：进程崩溃时连接断开，锁自动释放。
  async withLock<T>(run: () => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      locked = (await client.query("SELECT pg_try_advisory_lock($1) locked", [REDELIVERY_LOCK])).rows[0].locked;
      return locked ? await run() : undefined;
    } finally {
      if (locked)
        await client.query("SELECT pg_advisory_unlock($1)", [REDELIVERY_LOCK]).catch(() => {
          broken = true;
        });
      client.release(broken);
    }
  }
}
