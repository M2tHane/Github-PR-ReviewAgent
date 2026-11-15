import type { Database } from "../persistence/database.js";
import { LEASE_MS } from "../persistence/repositories/job.repository.js";
import { log } from "../logging.js";
import type { AgentJob } from "./types.js";
import { BudgetError, ProviderError, TimeoutError } from "../review/agent.js";
import { GitHubApiError } from "../github/client.js";

export interface RunnerOptions {
  // 同时执行的任务数；串行条件由各任务来源在领取时保证。
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
}

// 任务来源负责领取条件与状态写回；执行器只负责并发、心跳和生命周期。
export interface TaskSource<T extends { id: string }> {
  claim(options: { active: T[]; concurrency: number; leaseMs: number }): Promise<T | undefined>;
  renew(tasks: T[], leaseMs: number): Promise<Array<{ job: T; reason: string }>>;
  finish(task: T, stopped: boolean): Promise<void>;
  fail(task: T, error: Error, retry: boolean): Promise<void>;
  release(task: T): Promise<void>;
  stop?(): void;
}

export class RunnerStoppedError extends Error {
  constructor() {
    super("服务停止，任务放回队列");
  }
}
export class TaskLeaseLostError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export class JobsSource implements TaskSource<AgentJob> {
  constructor(private database: Database) {}
  claim({ active, concurrency, leaseMs }: { active: AgentJob[]; concurrency: number; leaseMs: number }) {
    // 多槽位时至少给 PR 任务留一个槽位，健康检查的调度规则只属于 jobs 来源。
    const health = active.filter((job) => job.jobType === "HEALTH_AUDIT").length;
    return this.database.claimNext({ allowHealth: health < Math.max(1, concurrency - 1), leaseMs });
  }
  renew(tasks: AgentJob[], leaseMs: number) {
    return this.database.renewLeases(tasks, leaseMs);
  }
  finish(task: AgentJob, stopped: boolean) {
    return stopped && task.status === "cancelled" ? this.database.releaseJob(task) : this.database.finishJob(task);
  }
  fail(task: AgentJob, error: Error, retry: boolean) {
    return this.database.failJob(task, error, retry);
  }
  release(task: AgentJob) {
    return this.database.releaseJob(task);
  }
  stop() {
    this.database.stopReviews();
  }
}

// 可以多实例运行：每个任务领取时写租约，心跳续租；实例崩溃后租约过期，其他实例接手。
export class PersistentRunner<T extends { id: string } = AgentJob> {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private renewing?: Promise<void>;
  private active = new Map<string, { job: T; controller: AbortController; done: Promise<void> }>();
  private concurrency: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;

  constructor(
    private source: TaskSource<T>,
    private execute: (job: T, signal: AbortSignal) => Promise<void>,
    private pollMs = 500,
    options: RunnerOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.min(5_000, this.leaseMs / 3);
  }

  setConcurrency(value: number) {
    this.concurrency = Math.max(1, value);
  }

  async start() {
    this.heartbeat = setInterval(() => {
      if (!this.renewing)
        this.renewing = this.renew().finally(() => {
          this.renewing = undefined;
        });
    }, this.heartbeatMs);
    this.heartbeat.unref();
    this.polling = this.tick();
  }

  // 中止执行并等收尾，期间继续续租，避免清理工作区时被别的实例接手。
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.source.stop?.();
    for (const entry of this.active.values()) entry.controller.abort(new RunnerStoppedError());
    await this.polling;
    await Promise.all([...this.active.values()].map((entry) => entry.done));
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.renewing;
  }

  private async tick() {
    if (this.stopped) return;
    try {
      while (!this.stopped && this.active.size < this.concurrency) {
        const job = await this.source.claim({
          active: [...this.active.values()].map((entry) => entry.job),
          concurrency: this.concurrency,
          leaseMs: this.leaseMs,
        });
        if (!job) break;
        // stop 可能发生在数据库领取期间；此时直接释放，不再启动处理器。
        if (this.stopped) {
          await this.source.release(job);
          break;
        }
        const controller = new AbortController();
        const done = this.run(job, controller.signal).finally(() => this.active.delete(job.id));
        this.active.set(job.id, { job, controller, done });
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

  private async run(job: T, signal: AbortSignal) {
    try {
      try {
        await this.execute(job, signal);
        await this.source.finish(job, this.stopped);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("未知错误");
        if (this.stopped) {
          await this.source.release(job);
          log("info", "job_released", { jobId: job.id }, failure);
          return;
        }
        await this.source.fail(job, failure, transient(failure));
        log("error", "job_failed", { jobId: job.id }, failure);
      }
    } catch (error) {
      // 写回失败时保留租约，由下一次领取恢复。
      log("error", "runner_error", { jobId: job.id }, error);
    }
  }

  private async renew() {
    if (!this.active.size) return;
    try {
      const stops = await this.source.renew(
        [...this.active.values()].map((entry) => entry.job),
        this.leaseMs,
      );
      for (const { job, reason } of stops) {
        this.active.get(job.id)?.controller.abort(new TaskLeaseLostError(reason));
        log("info", "job_stop_requested", { jobId: job.id, reason });
      }
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
