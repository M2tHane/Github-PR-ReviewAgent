import type { Database } from "../persistence/database.js";
import { LEASE_MS } from "../persistence/repositories/job.repository.js";
import { log } from "../logging.js";
import type { AgentJob } from "./types.js";
import { BudgetError, ProviderError, TimeoutError } from "../review/agent.js";
import { GitHubApiError } from "../github/client.js";

export interface RunnerOptions {
  // 同时执行的任务数。同一个 PR 的任务仍然串行，由领取时的数据库条件保证。
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
}

// 可以多实例运行：每个任务领取时写租约，心跳续租；实例崩溃后租约过期，其他实例接手。
export class PersistentRunner {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private active = new Map<string, { job: AgentJob; done: Promise<void> }>();
  private concurrency: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;

  constructor(
    private database: Database,
    private execute: (job: AgentJob) => Promise<void>,
    private pollMs = 500,
    options: RunnerOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.min(5_000, this.leaseMs / 3);
  }

  // 管理端改了并发数：调大时下一轮就多领；调小时正在跑的任务不受影响，跑完后按新值领取。
  setConcurrency(value: number) {
    this.concurrency = Math.max(1, value);
  }

  async start() {
    this.heartbeat = setInterval(() => void this.renew(), this.heartbeatMs);
    this.heartbeat.unref();
    this.polling = this.tick();
  }

  // 停止：不再领取新任务，中止正在跑的任务并放回队列（不计入尝试次数），等它们收尾后返回。
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.database.stopReviews();
    await this.polling;
    await Promise.all([...this.active.values()].map((entry) => entry.done));
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  private async tick() {
    if (this.stopped) return;
    try {
      while (!this.stopped && this.active.size < this.concurrency) {
        // 有多个槽位时至少留一个给 PR 任务，健康检查不会把 PR 审查全部挡住。
        const health = [...this.active.values()].filter((entry) => entry.job.jobType === "HEALTH_AUDIT").length;
        const job = await this.database.claimNext({
          allowHealth: health < Math.max(1, this.concurrency - 1),
          leaseMs: this.leaseMs,
        });
        if (!job) break;
        const done = this.run(job).finally(() => this.active.delete(job.id));
        this.active.set(job.id, { job, done });
      }
    } catch (error) {
      log("error", "runner_error", {}, error);
    } finally {
      if (!this.stopped)
        this.timer = setTimeout(() => {
          this.polling = this.tick();
        }, this.pollMs);
    }
  }

  private async run(job: AgentJob) {
    try {
      try {
        await this.execute(job);
        if (this.stopped && job.status === "cancelled") await this.database.releaseJob(job);
        else await this.database.finishJob(job);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("未知错误");
        if (this.stopped) {
          await this.database.releaseJob(job);
          log("info", "job_released", { jobId: job.id, jobType: job.jobType }, failure);
          return;
        }
        await this.database.failJob(job, failure, transient(failure));
        log(
          "error",
          "job_failed",
          {
            jobId: job.id,
            jobType: job.jobType,
            deliveryId: "deliveryId" in job ? job.deliveryId : undefined,
            repositoryId: job.repositoryId,
            prNumber: "prNumber" in job ? job.prNumber : undefined,
            headSha: job.headSha,
            attempt: job.attempt,
            status: job.status,
          },
          failure,
        );
      }
    } catch (error) {
      // 写回状态失败（例如数据库断开）：租约到期后会被重新排队。
      log("error", "runner_error", { jobId: job.id }, error);
    }
  }

  private async renew() {
    if (!this.active.size) return;
    try {
      const stops = await this.database.renewLeases(
        [...this.active.values()].map((entry) => entry.job),
        this.leaseMs,
      );
      for (const { job, reason } of stops) log("info", "job_stop_requested", { jobId: job.id, reason });
    } catch (error) {
      log("error", "lease_renew_failed", { jobs: this.active.size }, error);
    }
  }
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// 能否重试先看错误类型：模型服务错误按服务方说明判断，GitHub 按状态码（含 403 二级限流），网络错误按错误码。
// 整次执行超时不重试：多半是 PR 太大，重跑结果一样，只会耗尽预算；模型服务自己报的超时仍按 ProviderError 判断。
// 最后才按文字匹配，兜底没有类型的错误（例如 fetch 抛出的 TypeError）。
export function transient(error: Error): boolean {
  if (error instanceof ProviderError) return error.retryable;
  if (error instanceof GitHubApiError)
    return (
      error.status === 429 || error.status >= 500 || (error.status === 403 && error.retryAfterSeconds !== undefined)
    );
  if (error instanceof BudgetError) return false;
  if (error instanceof TimeoutError) return false;
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    current = current.cause;
  }
  return /\b429\b|\b5\d\d\b|fetch failed|network|ECONN|ETIMEDOUT|超时/i.test(error.message);
}
