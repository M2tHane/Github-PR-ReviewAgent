import { createApp } from "../github/webhook/handler.js";
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
import { NotificationRepository } from "../persistence/repositories/notification.repository.js";
import { NotificationWorker } from "../notifications/worker.js";

import { DevelopmentStore } from "../development/store.js";
import { DevelopmentWorker } from "../development/worker.js";

// 单进程模块边界的理由见 .agents/decisions/repository-architecture.md。
export function createApplication() {
  const config = loadConfig();
  const database = new Database(config.databaseUrl, config.workerConcurrency, config.wecom?.channel);
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
  const notifications = config.wecom
    ? new NotificationWorker(config, config.wecom, new NotificationRepository(database.pool), github)
    : undefined;
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
        if (result.jobs || result.deliveries || result.repositories) log("info", "data_purged", { ...result });
      })
      .catch((error) => log("error", "data_purge_failed", {}, error))
      .finally(() => {
        purging = undefined;
      });
  };

  return {
    async start() {
      await runner.start();
      notifications?.start();
      development?.start();
      scheduleTimer = setInterval(pollSchedules, 30_000);
      pollSchedules();
      purgeTimer = setInterval(purge, 6 * 60 * 60_000);
      purge();
      server.listen(config.port, () => log("info", "listening", { port: config.port }));
    },
    async stop() {
      if (scheduleTimer) clearInterval(scheduleTimer);
      if (purgeTimer) clearInterval(purgeTimer);
      scheduleAbort.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([closed, runner.stop(), notifications?.stop(), development?.stop(), scheduling, purging]);
      await database.close();
    },
  };
}
