import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createApplication } from "../../src/bootstrap/application.js";
import { stopOnSignals } from "../../src/bootstrap/signals.js";
import type { Config, ProcessRole } from "../../src/config/config.js";
import { loadDevelopmentConfig } from "../../src/development/config.js";
import { DevelopmentWorker } from "../../src/development/worker.js";
import { PersistentRunner } from "../../src/jobs/runner.js";
import { Database } from "../../src/persistence/database.js";

async function fixture(t: TestContext, role: ProcessRole, withBot = true) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const events: string[] = [];
  const rows = [
    { key: "WORKER_CONCURRENCY", value: 4 },
    { key: "DEVELOPMENT_CONCURRENCY", value: 5 },
    { key: "QUEUE_CAPACITY", value: 50 },
    { key: "WEBHOOK_REDELIVERY_INTERVAL_MS", value: 60_000 },
    { key: "DATA_PURGE_INTERVAL_MS", value: 3_600_000 },
  ];
  const config: Config = {
    processRole: role,
    development: loadDevelopmentConfig(withBot ? { WECOM_BOT_ID: "bot", WECOM_BOT_SECRET: "secret" } : {}),
    appId: "1",
    privateKey: "unused",
    webhookSecret: "secret",
    allowedRepositories: new Set(["o/r"]),
    databaseUrl: "postgresql://unused/unused",
    modelProvider: "test",
    modelName: "test",
    modelApiKey: "unused",
    port: 0,
    webhookMaxBytes: 1000,
    queueCapacity: 20,
    agentTimeoutMs: 3_600_000,
    vulnerabilityScan: false,
    sastScan: false,
    semgrepPath: "unused",
    workerConcurrency: 2,
    dataRetentionDays: 90,
    revokedDataGraceDays: 30,
    webhookRedelivery: true,
  };
  const allowedRows = [{ full_name: "O/Added" }];
  const allowedSet = config.allowedRepositories;
  const state = { databaseDown: false, stopping: false };
  let database!: Database;
  let runnerDrain: Promise<void> | undefined;
  let botDrain: Promise<void> | undefined;
  let cleanupDrain: Promise<void> | undefined;
  let probeDrain: Promise<void> | undefined;
  const runners: object[] = [];
  const concurrency = new Map<object, number>();
  class FakeDatabase extends Database {
    constructor(...args: ConstructorParameters<typeof Database>) {
      super(...args);
      database = this;
      t.mock.method(this.pool, "query", async (sql: string) => {
        if (sql === "SELECT full_name FROM repositories WHERE allowed AND revoked_at IS NULL") {
          events.push("repositories.read");
          return { rows: allowedRows.map((row) => ({ ...row })) };
        }
        assert.match(sql, /^SELECT key,value,updated_by,updated_at FROM service_settings$/);
        events.push("settings.read");
        return { rows: rows.map((row) => ({ ...row, updated_by: "admin", updated_at: new Date(0) })) };
      });
      t.mock.method(this as Database, "purgeExpired", async () => {
        events.push("purge");
        return { jobs: 0, deliveries: 0, repositories: 0, sessions: 0 };
      });
      t.mock.method(this as Database, "withWebhookRedeliveryLock", async <T>(run: () => Promise<T>) => {
        events.push("redelivery.lock");
        return run();
      });
    }
    override isStopping() {
      return state.stopping;
    }
    override async check() {
      events.push("database.check");
      await probeDrain;
      if (state.databaseDown) throw new Error("database unavailable");
    }
    override async close() {
      events.push("database.close");
      await super.close();
    }
  }
  class FakeRunner<T extends { id: string }> extends PersistentRunner<T> {
    override setConcurrency(value: number) {
      concurrency.set(this, value);
    }
    override async start() {
      runners.push(this);
      events.push("runner.start");
    }
    override async stop() {
      events.push("runner.stop");
      await runnerDrain;
      events.push("runner.drained");
    }
  }
  class FakeBot extends DevelopmentWorker {
    override start() {
      events.push("bot.start");
    }
    override async stop() {
      events.push("bot.stop");
      await botDrain;
      events.push("bot.drained");
    }
  }
  const app = createApplication(config, {
    Database: FakeDatabase,
    PersistentRunner: FakeRunner,
    DevelopmentWorker: FakeBot,
    enqueueDueHealthJobs: async () => {
      events.push("health.schedule");
    },
    removeStaleTaskDirectories: async () => {
      events.push("cleanup");
      await cleanupDrain;
      return 0;
    },
    redeliverFailedWebhooks: async () => {
      events.push("redelivery");
      return { redelivered: 0, failed: 0, abandoned: 0, truncated: false };
    },
  });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= app.stop());
  t.after(stop);
  await app.start();
  const address = app.server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    app,
    config,
    database,
    state,
    events,
    rows,
    allowedRows,
    allowedSet,
    concurrency,
    runners,
    stop,
    count: (event: string) => events.filter((value) => value === event).length,
    request: (path: string, method = "GET") => fetch(origin + path, { method, headers: { connection: "close" } }),
    drainRunners: (promise: Promise<void>) => {
      runnerDrain = promise;
    },
    drainBot: (promise: Promise<void>) => {
      botDrain = promise;
    },
    drainCleanup: (promise: Promise<void>) => {
      cleanupDrain = promise;
    },
    drainProbe: (promise: Promise<void>) => {
      probeDrain = promise;
    },
  };
}

for (const role of ["edge", "worker", "all"] as const) {
  test(`${role} 只启动所属组件，保留探针并持续同步服务设置`, async (t) => {
    const f = await fixture(t, role);
    const worker = role !== "edge";
    const edge = role !== "worker";
    assert.equal(f.count("runner.start"), worker ? 2 : 0);
    assert.equal(f.count("bot.start"), edge ? 1 : 0);
    for (const event of ["health.schedule", "purge", "cleanup", "redelivery.lock", "redelivery"])
      assert.equal(f.count(event), worker ? 1 : 0, event);
    assert.equal(f.events[0], "settings.read", "先加载设置再启动任务");
    assert.equal(f.config.queueCapacity, 50);
    assert.equal(f.config.allowedRepositories, f.allowedSet);
    assert.deepEqual([...f.allowedSet], ["o/r", "o/added"]);
    assert(f.events.indexOf("repositories.read") < f.events.indexOf(worker ? "runner.start" : "bot.start"));
    assert.equal(f.database.pool.options.max, worker ? 32 : 5);
    assert.deepEqual(
      f.runners.map((runner) => f.concurrency.get(runner)),
      worker ? [4, 5] : [],
    );
    assert.equal((await f.request("/healthz")).status, 200);
    assert.equal((await f.request("/readyz")).status, 200);
    assert.equal((await f.request("/github/webhook", "POST")).status, edge ? 400 : 404);
    assert.equal((await f.request("/api/session")).status, edge ? 401 : 404);
    assert.equal((await f.request("/")).status, edge ? 200 : 404);
    f.state.databaseDown = true;
    assert.equal((await f.request("/readyz")).status, 503);
    assert.equal((await f.request("/healthz")).status, 200);
    f.state.databaseDown = false;
    f.state.stopping = true;
    assert.equal((await f.request("/readyz")).status, 503);
    f.state.stopping = false;

    f.allowedRows[0]!.full_name = "O/Other";
    f.rows[0]!.value = 6;
    f.rows[1]!.value = 7;
    f.rows[2]!.value = 60;
    f.rows[3]!.value = 120_000;
    f.rows[4]!.value = 7_200_000;
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(f.config.queueCapacity, 60, "edge 和 worker 均应用后续管理修改");
    assert.equal(f.config.allowedRepositories, f.allowedSet);
    assert.deepEqual([...f.allowedSet], ["o/r", "o/other"]);
    assert.equal(f.database.pool.options.max, worker ? 44 : 5);
    assert.deepEqual(
      f.runners.map((runner) => f.concurrency.get(runner)),
      worker ? [6, 7] : [],
    );
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(f.count("redelivery"), worker ? 1 : 0, "间隔修改后旧计时器不再触发");
    t.mock.timers.tick(90_000);
    await setImmediate();
    assert.equal(f.count("redelivery"), worker ? 2 : 0);
    assert.equal(f.count("purge"), worker ? 1 : 0);
    await f.stop();
    assert.equal(f.count("runner.stop"), worker ? 2 : 0);
    assert.equal(f.count("bot.stop"), edge ? 1 : 0);
    assert.equal(f.events.at(-1), "database.close");
    const stoppedEvents = [...f.events];
    t.mock.timers.tick(8 * 3_600_000);
    await setImmediate();
    assert.deepEqual(f.events, stoppedEvents, "停止后不再同步设置或触发定时任务");
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`worker 收到 ${signal} 后等两个执行器和清理收尾才退出`, async (t) => {
    const drained = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    t.after(() => {
      drained.resolve();
      cleaned.resolve();
    });
    const f = await fixture(t, "worker");
    f.drainRunners(drained.promise);
    f.drainCleanup(cleaned.promise);
    t.mock.timers.tick(3_600_000);
    await setImmediate();
    const runtime = new EventEmitter();
    const exited = Promise.withResolvers<number>();
    const exits: number[] = [];
    stopOnSignals(
      f,
      Object.assign(runtime, {
        exit(code: number) {
          exits.push(code);
          exited.resolve(code);
        },
      }),
    );
    runtime.emit(signal);
    runtime.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    await setImmediate();
    assert.equal(f.count("runner.stop"), 2, "重复信号不重复停止");
    assert.equal(f.app.server.listening, false);
    assert.equal(f.count("database.close"), 0);
    assert.deepEqual(exits, []);
    drained.resolve();
    await setImmediate();
    assert.equal(f.count("database.close"), 0, "临时目录清理也必须收尾");
    cleaned.resolve();
    assert.equal(await exited.promise, 0);
    assert.equal(f.events.at(-1), "database.close");
    assert.deepEqual(exits, [0]);
  });
}

test("edge 停止时等已接收 HTTP 请求和企微发送收尾", async (t) => {
  const requestDone = Promise.withResolvers<void>();
  const botDone = Promise.withResolvers<void>();
  t.after(() => {
    requestDone.resolve();
    botDone.resolve();
  });
  const f = await fixture(t, "edge");
  f.drainProbe(requestDone.promise);
  f.drainBot(botDone.promise);
  const response = f.request("/readyz");
  while (!f.count("database.check")) await setImmediate();
  const stopped = f.stop();
  await setImmediate();
  assert.equal(f.app.server.listening, false);
  assert.equal(f.count("bot.stop"), 1);
  assert.equal(f.count("database.close"), 0);
  botDone.resolve();
  await setImmediate();
  assert.equal(f.count("database.close"), 0, "HTTP 请求尚未完成");
  requestDone.resolve();
  assert.equal((await response).status, 200);
  await stopped;
  assert.equal(f.events.at(-1), "database.close");
});

test("未配置企微的 all 仍启动两个执行器", async (t) => {
  const f = await fixture(t, "all", false);
  assert.equal(f.count("runner.start"), 2);
  assert.equal(f.count("bot.start"), 0);
});
