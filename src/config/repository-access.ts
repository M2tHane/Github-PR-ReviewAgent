import type { Pool } from "pg";
import type { Config } from "./config.js";
import { log } from "../logging.js";

// 保存启动时的固定基线；后续原地更新 Set，所有既有调用方都能看到管理页的变更。
export class RepositoryAccess {
  readonly configured: ReadonlySet<string>;
  private refreshing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: Pick<Config, "allowedRepositories">,
    private readonly pool: Pool,
  ) {
    this.configured = new Set([...config.allowedRepositories].map((name) => name.toLowerCase()));
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  // 写入之后必须再读一次，不能复用写入前尚未结束的查询。
  async refreshAfterUpdate() {
    await this.refreshing;
    await this.refresh();
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => {
      // 数据库暂时不可用时保留最近成功加载的白名单，并明确记录失败。
      void this.refresh().catch((error) => log("error", "repository_access_refresh_failed", {}, error));
    }, intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.refreshing;
  }

  private async load() {
    const result = await this.pool.query("SELECT full_name FROM repositories WHERE allowed AND revoked_at IS NULL");
    const next = new Set([...this.configured, ...result.rows.map((row) => String(row.full_name).toLowerCase())]);
    this.config.allowedRepositories.clear();
    for (const name of next) this.config.allowedRepositories.add(name);
  }
}
