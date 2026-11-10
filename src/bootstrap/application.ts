import { createApp } from "../github/webhook/handler.js";
import { REDELIVERY_INTERVAL_MS, redeliverFailedWebhooks } from "../github/webhook/redelivery.js";
import { loadConfig } from "../config/config.js";
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
  const { server } = createApp(config, database, createAdminHandler(config, database));
  const scheduleAbort = new AbortController();
  const github = new GitHubClient(config.appId, config.privateKey);
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

  // 数据清理：启动后先跑一次，之后每 6 小时一次。多实例时由数据库锁保证同一时间只有一个在跑。
  let purging: Promise<void> | undefined;
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
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

  // 漏投递补偿：启动后先查一次，之后每 5 分钟一次。多实例时由数据库锁保证同一时间只有一个在查；
  // 数据库不可用时拿不到锁也就不重投——那时重投只会再失败，白白用掉次数。
  let redelivering: Promise<void> | undefined;
  let redeliveryTimer: ReturnType<typeof setInterval> | undefined;
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

  return {
    async start() {
      await runner.start();
      development?.start();
      scheduleTimer = setInterval(pollSchedules, 30_000);
      pollSchedules();
      purgeTimer = setInterval(purge, 6 * 60 * 60_000);
      purge();
      redeliveryTimer = setInterval(redeliver, REDELIVERY_INTERVAL_MS);
      redeliver();
      server.listen(config.port, () => log("info", "listening", { port: config.port }));
    },
    async stop() {
      if (scheduleTimer) clearInterval(scheduleTimer);
      if (purgeTimer) clearInterval(purgeTimer);
      if (redeliveryTimer) clearInterval(redeliveryTimer);
      scheduleAbort.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([closed, runner.stop(), development?.stop(), scheduling, purging, redelivering]);
      await database.close();
    },
  };
}
