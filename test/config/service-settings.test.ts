import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../../src/config/config.js";
import { SETTINGS, ServiceSettings, settingError } from "../../src/config/service-settings.js";

const definition = (key: string) => SETTINGS.find((item) => item.key === key)!;

function config(development = false): Config {
  return {
    agentTimeoutMs: 3_600_000,
    dataRetentionDays: 90,
    revokedDataGraceDays: 30,
    vulnerabilityScan: true,
    sastScan: true,
    webhookRedelivery: true,
    workerConcurrency: 2,
    queueCapacity: 20,
    modelName: "model-a",
    modelEndpoint: { api: "openai-completions", thinkingLevel: "high" },
    ...(development ? { development: { botId: "b", secret: "s", timeoutMs: 3_600_000, concurrency: 3 } } : {}),
  } as Config;
}

// 只认 service_settings 的查询；rows 可以在测试中途替换，模拟别的实例改了设置。
function pool(rows: Array<{ key: string; value: unknown }>) {
  const state = { rows, fail: false };
  return {
    state,
    pool: {
      query: async (sql: string) => {
        if (state.fail) throw new Error("database down");
        if (sql.startsWith("SELECT key,value"))
          return { rows: state.rows.map((row) => ({ ...row, updated_by: "admin", updated_at: new Date(0) })) };
        return { rows: [] };
      },
    } as any,
  };
}

test("服务设置校验：范围、整单位、0 和留空的含义", () => {
  assert.equal(settingError(definition("AGENT_TIMEOUT_MS"), 3_600_000), undefined);
  assert.match(settingError(definition("AGENT_TIMEOUT_MS"), 90_000_000)!, /范围是 1–1440 分钟/);
  assert.match(settingError(definition("AGENT_TIMEOUT_MS"), 90_000)!, /整分钟/);
  assert.match(settingError(definition("AGENT_TIMEOUT_MS"), "60000")!, /整数/);
  assert.equal(settingError(definition("DATA_RETENTION_DAYS"), 0), undefined, "0 表示永久保留");
  assert.match(settingError(definition("DATA_RETENTION_DAYS"), 3)!, /范围是 7–3650 天，或 0（永久保留）/);
  assert.match(settingError(definition("WORKER_CONCURRENCY"), 0)!, /范围/);
  assert.equal(settingError(definition("DEVELOPMENT_BUDGET_TOKENS"), null), undefined, "留空表示不限制");
  assert.match(settingError(definition("AGENT_TIMEOUT_MS"), null)!, /不能为空/);
  assert.equal(settingError(definition("MODEL_THINKING"), null), undefined);
  assert.match(settingError(definition("MODEL_THINKING"), "max")!, /不是可选的值/);
  assert.equal(settingError(definition("MODEL_NAME"), "gpt-6.1-sol"), undefined);
  assert.match(settingError(definition("MODEL_NAME"), "a b")!, /只能包含/);
  assert.match(settingError(definition("SAST_SCAN_ENABLED"), "true")!, /开或关/);
});

test("服务设置：数据库里的值写进 config，删除记录后回到默认值，坏值和未启用的功能跳过", async () => {
  const value = config();
  const { pool: fake, state } = pool([
    { key: "AGENT_TIMEOUT_MS", value: 1_800_000 },
    { key: "WORKER_CONCURRENCY", value: 4 },
    { key: "MODEL_THINKING", value: null },
    { key: "DATA_RETENTION_DAYS", value: 1 },
    { key: "DEVELOPMENT_CONCURRENCY", value: 5 },
    { key: "UNKNOWN", value: 1 },
  ]);
  const changes: string[][] = [];
  const settings = new ServiceSettings(value, fake, (keys) => changes.push(keys));
  await settings.refresh();
  assert.equal(value.agentTimeoutMs, 1_800_000);
  assert.equal(value.workerConcurrency, 4);
  assert.equal(value.modelEndpoint?.thinkingLevel, undefined);
  assert.equal(value.dataRetentionDays, 90, "超出范围的存储值不生效");
  assert.equal(value.development, undefined);
  assert.deepEqual(changes, [["AGENT_TIMEOUT_MS", "MODEL_THINKING", "WORKER_CONCURRENCY"]]);
  // 没有变化时不通知；别的实例恢复默认后回到启动时的值。
  await settings.refresh();
  assert.equal(changes.length, 1);
  state.rows = [{ key: "WORKER_CONCURRENCY", value: 4 }];
  await settings.refresh();
  assert.equal(value.agentTimeoutMs, 3_600_000);
  assert.equal(value.modelEndpoint?.thinkingLevel, "high");
  assert.deepEqual(changes[1], ["AGENT_TIMEOUT_MS", "MODEL_THINKING"]);
  // 数据库不可用时保留当前值，不抛错。
  state.fail = true;
  await settings.refresh();
  assert.equal(value.workerConcurrency, 4);
  const listed = SETTINGS.filter((item) => !item.development).length;
  state.fail = false;
  assert.equal((await settings.list()).settings.length, listed, "未启用群内开发时不列开发相关设置");
});

test("服务设置：启用群内开发时开发任务的时限、并发和额度可改", async () => {
  const value = config(true);
  const settings = new ServiceSettings(
    value,
    pool([
      { key: "DEVELOPMENT_CONCURRENCY", value: 5 },
      { key: "DEVELOPMENT_BUDGET_TOKENS", value: 200_000 },
      { key: "DEVELOPMENT_TIMEOUT_MS", value: 7_200_000 },
    ]).pool,
  );
  await settings.refresh();
  assert.deepEqual(value.development, {
    botId: "b",
    secret: "s",
    timeoutMs: 7_200_000,
    concurrency: 5,
    budgetTokens: 200_000,
  });
});

test("服务设置：提交的值先全部校验，有一项不通过就都不写", async () => {
  const queries: string[] = [];
  const settings = new ServiceSettings(config(), {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
    connect: async () => {
      throw new Error("不应写库");
    },
  } as any);
  await assert.rejects(
    settings.update({ AGENT_TIMEOUT_MS: 1_800_000, DATA_RETENTION_DAYS: 2 }, "admin"),
    /已结束任务的保留天数：范围是 7–3650 天/,
  );
  await assert.rejects(settings.update({ DEVELOPMENT_CONCURRENCY: 2 }, "admin"), /不能修改/);
  await assert.rejects(settings.update({ PORT: 1 }, "admin"), /不能修改/);
  assert.deepEqual(queries, []);
});
