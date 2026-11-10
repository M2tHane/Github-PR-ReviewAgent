import { createApp } from "../github/webhook/handler.js";
import { redeliverFailedWebhooks } from "../github/webhook/redelivery.js";
import { loadConfig } from "../config/config.js";
import {
  DEFAULT_PURGE_INTERVAL_MS,
  DEFAULT_REDELIVERY_INTERVAL_MS,
  ServiceSettings,
} from "../config/service-settings.js";
import { createReviewProcessor } from "../review/review.processor.js";
import { Database } from "../persistence/database.js";
import { PersistentRunner } from "../jobs/runner.js";
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

import { DevelopmentStore } from "../development/store.js";
import { DevelopmentWorker } from "../development/worker.js";

// 单进程模块边界的理由见 .agents/decisions/repository-architecture.md。
export function createApplication() {
  const config = loadConfig();
  const database = new Database(
    config.databaseUrl,
    config.workerConcurrency,
    config.development ? reviewNotificationChannel(config.development.botId) : undefined,
  );
  const memories = new MemoryService(database);
  const review = createReviewProcessor(config, undefined, database, memories);
  const extract = createDecisionProcessor(config, database);
  const reply = createReplyProcessor(config, database, memories);
  const health = createHealthProcessor(config, database, memories);
  const runner = new PersistentRunner(
    database,
    createJobDispatcher({ PR_REVIEW: review, DECISION_EXTRACT: extract, REPLY_HANDLE: reply, HEALTH_AUDIT: health }),
    500,
    { concurrency: config.workerConcurrency },
  );
  // 管理端改了间隔或并发数时立即调整；其余设置在用到时读 config，不需要额外处理。
  const settings = new ServiceSettings(config, database.pool, (keys) => {
    if (keys.includes("WORKER_CONCURRENCY")) {
      database.resizePool(config.workerConcurrency);
      runner.setConcurrency(config.workerConcurrency);
    }
    if (keys.includes("DATA_PURGE_INTERVAL_MS")) purgeTimer.reschedule();
    if (keys.includes("WEBHOOK_REDELIVERY_INTERVAL_MS")) redeliveryTimer.reschedule();
  });
  const github = new GitHubClient(config.appId, config.privateKey);
  const { server } = createApp(config, database, createAdminHandler(config, database, github, undefined, settings));
  const scheduleAbort = new AbortController();
  const development = config.development
    ? new DevelopmentWorker(config, new DevelopmentStore(database.pool), github)
    : undefined;
  let scheduling: Promise<void> | undefined;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;

  const pollSchedules = () => {
    if (scheduling || scheduleAbort.signal.aborted) return;
    scheduling = enqueueDueHealthJobs(config, database, github, scheduleAbort.signal)
      .catch((error) => {
        if (!scheduleAbort.signal.aborted) log("error", "health_schedule_poll_failed", {}, error);
      })
      .finally(() => {
        scheduling = undefined;
      });
  };

  // 数据清理：启动后先跑一次，之后按间隔（默认 6 小时，管理端可改）。多实例时由数据库锁保证同一时间只有一个在跑。
  let purging: Promise<void> | undefined;
  const purge = () => {
    if (purging || scheduleAbort.signal.aborted) return;
    if (!config.dataRetentionDays && !config.revokedDataGraceDays) return;
    purging = database
      .purgeExpired({ retentionDays: config.dataRetentionDays, revokedGraceDays: config.revokedDataGraceDays })
      .then((result) => {
        if (result.jobs || result.deliveries || result.repositories || result.sessions)
          log("info", "data_purged", { ...result });
      })
      .catch((error) => log("error", "data_purge_failed", {}, error))
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
      .withWebhookRedeliveryLock(() => redeliverFailedWebhooks(github, scheduleAbort.signal))
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
    async start() {
      // 先读一次管理端改过的设置，再开始领取任务；读不到（没跑迁移、数据库不可用）时用 .env 的值。
      await settings.refresh();
      settings.start();
      database.resizePool(config.workerConcurrency);
      runner.setConcurrency(config.workerConcurrency);
      await runner.start();
      development?.start();
      scheduleTimer = setInterval(pollSchedules, 30_000);
      pollSchedules();
      purgeTimer.reschedule();
      purge();
      redeliveryTimer.reschedule();
      redeliver();
      server.listen(config.port, () => log("info", "listening", { port: config.port }));
    },
    async stop() {
      if (scheduleTimer) clearInterval(scheduleTimer);
      settings.stop();
      purgeTimer.stop();
      redeliveryTimer.stop();
      scheduleAbort.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([closed, runner.stop(), development?.stop(), scheduling, purging, redelivering]);
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
