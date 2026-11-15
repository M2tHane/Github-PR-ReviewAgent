import { createApp, createProbeServer } from "../github/webhook/handler.js";
import { redeliverFailedWebhooks } from "../github/webhook/redelivery.js";
import { removeStaleTaskDirectories } from "../workspace/cleanup.js";
import { loadConfig } from "../config/config.js";
import {
  DEFAULT_PURGE_INTERVAL_MS,
  DEFAULT_REDELIVERY_INTERVAL_MS,
  ServiceSettings,
} from "../config/service-settings.js";
import { createReviewProcessor } from "../review/review.processor.js";
import { Database } from "../persistence/database.js";
import { JobsSource, PersistentRunner } from "../jobs/runner.js";
import { createDecisionProcessor } from "../memory/decision.processor.js";
import { MemoryService } from "../memory/memory.service.js";
import { createAdminHandler } from "../admin/handler.js";
import { createReplyProcessor } from "../reply/reply.processor.js";
import { createHealthProcessor } from "../health/health.processor.js";
import { enqueueDueHealthJobs } from "../health/health.scheduler.js";
import { GitHubClient } from "../github/client.js";
import { createJobDispatcher } from "../jobs/dispatcher.js";
import { log } from "../logging.js";
import { reviewNotificationChannel } from "../notifications/wecom.js";

import { DevelopmentStore, developmentSource } from "../development/store.js";
import { createDevelopmentProcessor } from "../development/processor.js";
import { DevelopmentWorker } from "../development/worker.js";
import { RepositoryAccess } from "../config/repository-access.js";

const services = {
  Database,
  PersistentRunner,
  DevelopmentWorker,
  enqueueDueHealthJobs,
  removeStaleTaskDirectories,
  redeliverFailedWebhooks,
};

// 同一构建产物按角色装配；默认 all。职责划分见 .agents/decisions/execution-engine.md。
export function createApplication(config = loadConfig(), overrides: Partial<typeof services> = {}) {
  const dependencies = { ...services, ...overrides };
  const edge = config.processRole !== "worker";
  const worker = config.processRole !== "edge";
  const executionConcurrency = () => (worker ? config.workerConcurrency + config.development.concurrency : 0);
  const database = new dependencies.Database(
    config.databaseUrl,
    executionConcurrency(),
    config.development.wecom ? reviewNotificationChannel(config.development.wecom.botId) : undefined,
  );
  const github = new GitHubClient(config.appId, config.privateKey);
  const developmentStore = new DevelopmentStore(database.pool);
  const memories = worker ? new MemoryService(database) : undefined;
  const runner = worker
    ? new dependencies.PersistentRunner(
        new JobsSource(database),
        createJobDispatcher({
          PR_REVIEW: createReviewProcessor(config, undefined, database, memories!),
          DECISION_EXTRACT: createDecisionProcessor(config, database, memories!),
          REPLY_HANDLE: createReplyProcessor(config, database, memories!),
          HEALTH_AUDIT: createHealthProcessor(config, database, memories!),
        }),
        500,
        { concurrency: config.workerConcurrency },
      )
    : undefined;
  const developmentRunner = worker
    ? new dependencies.PersistentRunner(
        developmentSource(developmentStore),
        createDevelopmentProcessor(config, developmentStore, github),
        500,
        { concurrency: config.development.concurrency },
      )
    : undefined;
  const development =
    edge && config.development.wecom ? new dependencies.DevelopmentWorker(config, developmentStore, github) : undefined;
  // 管理端改了间隔或并发数时立即调整；其余设置在用到时读 config，不需要额外处理。
  const settings = new ServiceSettings(config, database.pool, (keys) => {
    if (!worker) return;
    if (keys.includes("WORKER_CONCURRENCY") || keys.includes("DEVELOPMENT_CONCURRENCY"))
      database.resizePool(executionConcurrency());
    if (keys.includes("WORKER_CONCURRENCY")) runner!.setConcurrency(config.workerConcurrency);
    if (keys.includes("DEVELOPMENT_CONCURRENCY")) developmentRunner!.setConcurrency(config.development.concurrency);
    // 首次 refresh 在启动前，只加载新值；运行中的更改才重排定时器。
    if (started && keys.includes("DATA_PURGE_INTERVAL_MS")) purgeTimer.reschedule();
    if (started && keys.includes("WEBHOOK_REDELIVERY_INTERVAL_MS")) redeliveryTimer.reschedule();
  });
  const repositoryAccess = new RepositoryAccess(config, database.pool);
  const server = edge
    ? createApp(config, database, createAdminHandler(config, database, github, undefined, settings, repositoryAccess))
        .server
    : createProbeServer(database);
  const scheduleAbort = new AbortController();
  let started = false;
  let scheduling: Promise<void> | undefined;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;

  const pollSchedules = () => {
    if (scheduling || scheduleAbort.signal.aborted) return;
    scheduling = dependencies
      .enqueueDueHealthJobs(config, database, github, scheduleAbort.signal)
      .catch((error) => {
        if (!scheduleAbort.signal.aborted) log("error", "health_schedule_poll_failed", {}, error);
      })
      .finally(() => {
        scheduling = undefined;
      });
  };

  // 数据清理：启动后先跑一次，之后按间隔（默认 6 小时，管理端可改）。多实例时由数据库锁保证同一时间只有一个在跑。
  // 同时清理本机上中断任务留下的临时目录：超过最长任务时限加 10 分钟还没变化的，不可能还在用。
  let purging: Promise<void> | undefined;
  const purge = () => {
    if (purging || scheduleAbort.signal.aborted) return;
    const longest = Math.max(config.agentTimeoutMs, config.development.timeoutMs, config.healthTimeoutMs ?? 0);
    const cleaning = dependencies
      .removeStaleTaskDirectories(longest + 10 * 60_000)
      .then((removed) => removed && log("info", "stale_task_directories_removed", { removed }))
      .catch((error) => log("error", "stale_task_directories_failed", {}, error));
    const data =
      !config.dataRetentionDays && !config.revokedDataGraceDays
        ? undefined
        : database
            .purgeExpired({ retentionDays: config.dataRetentionDays, revokedGraceDays: config.revokedDataGraceDays })
            .then((result) => {
              if (result.jobs || result.deliveries || result.repositories || result.sessions)
                log("info", "data_purged", { ...result });
            })
            .catch((error) => log("error", "data_purge_failed", {}, error));
    purging = Promise.all([cleaning, data])
      .then(() => undefined)
      .finally(() => {
        purging = undefined;
      });
  };

  // 漏投递补偿：启动后先查一次，之后按间隔（默认 5 分钟，管理端可改）。多实例时由数据库锁保证同一时间只有一个在查；
  // 数据库不可用时拿不到锁也就不重投——那时重投只会再失败，白白用掉次数。
  let redelivering: Promise<void> | undefined;
  const redeliver = () => {
    if (redelivering || scheduleAbort.signal.aborted) return;
    if (!config.webhookRedelivery) return;
    redelivering = database
      .withWebhookRedeliveryLock(() => dependencies.redeliverFailedWebhooks(github, scheduleAbort.signal))
      .then(() => undefined)
      .catch((error) => {
        if (!scheduleAbort.signal.aborted) log("error", "webhook_redelivery_failed", {}, error);
      })
      .finally(() => {
        redelivering = undefined;
      });
  };

  const purgeTimer = repeat(purge, () => config.dataPurgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS);
  const redeliveryTimer = repeat(redeliver, () => config.webhookRedeliveryIntervalMs ?? DEFAULT_REDELIVERY_INTERVAL_MS);

  return {
    server,
    async start() {
      // 先读一次管理端改过的设置，再开始领取任务；读不到（没跑迁移、数据库不可用）时用 .env 的值。
      await settings.refresh();
      await repositoryAccess.refresh();
      settings.start();
      repositoryAccess.start();
      database.resizePool(executionConcurrency());
      if (worker) {
        runner!.setConcurrency(config.workerConcurrency);
        await runner!.start();
        developmentRunner!.setConcurrency(config.development.concurrency);
        await developmentRunner!.start();
        scheduleTimer = setInterval(pollSchedules, 30_000);
        pollSchedules();
        purgeTimer.reschedule();
        purge();
        redeliveryTimer.reschedule();
        redeliver();
      }
      started = true;
      development?.start();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, () => {
          server.off("error", reject);
          log("info", "listening", { port: config.port, role: config.processRole });
          resolve();
        });
      });
    },
    async stop() {
      if (scheduleTimer) clearInterval(scheduleTimer);
      settings.stop();
      purgeTimer.stop();
      redeliveryTimer.stop();
      scheduleAbort.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([
        closed,
        runner?.stop(),
        developmentRunner?.stop(),
        development?.stop(),
        scheduling,
        purging,
        redelivering,
        repositoryAccess.stop(),
      ]);
      await database.close();
    },
  };
}

// 按间隔重复执行；间隔每次现读，reschedule 从现在起按新间隔重新计时（不立即执行）。
function repeat(run: () => void, intervalMs: () => number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      run();
      schedule();
    }, intervalMs());
  };
  return {
    reschedule: schedule,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
