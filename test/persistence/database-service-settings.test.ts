import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../../src/config/config.js";
import { ServiceSettings } from "../../src/config/service-settings.js";
import { Database } from "../../src/persistence/database.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();

const config = () =>
  ({
    agentTimeoutMs: 3_600_000,
    dataRetentionDays: 90,
    revokedDataGraceDays: 30,
    vulnerabilityScan: true,
    sastScan: true,
    webhookRedelivery: true,
    workerConcurrency: 2,
    queueCapacity: 20,
    modelName: "model-a",
    modelEndpoint: { api: "openai-completions" },
  }) as Config;

test("服务设置：修改、恢复默认都写记录，另一个实例刷新后得到同样的值", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  try {
    const mine = config(),
      other = config();
    const settings = new ServiceSettings(mine, database.pool);
    const otherSettings = new ServiceSettings(other, database.pool);
    await assert.rejects(
      settings.update({ AGENT_TIMEOUT_MS: 1_800_000, DEVELOPMENT_BUDGET_TOKENS: undefined }, "alice"),
      /不能修改/,
      "未启用群内开发时不能改开发设置",
    );
    let view = await settings.update(
      { AGENT_TIMEOUT_MS: 1_800_000, MODEL_THINKING: "low", SAST_SCAN_ENABLED: false },
      "alice",
    );
    assert.equal(mine.agentTimeoutMs, 1_800_000, "本实例保存后立即生效");
    assert.equal(mine.modelEndpoint?.thinkingLevel, "low");
    const timeout = view.settings.find((item) => item.key === "AGENT_TIMEOUT_MS")!;
    assert.equal(timeout.value, 1_800_000);
    assert.equal(timeout.defaultValue, 3_600_000);
    assert.equal(timeout.updatedBy, "alice");
    await otherSettings.refresh();
    assert.equal(other.agentTimeoutMs, 1_800_000);
    assert.equal(other.sastScan, false);
    // 值没变不记录；思考强度改成“不指定”（null）和恢复默认要能区分。
    await settings.update({ AGENT_TIMEOUT_MS: 1_800_000, MODEL_THINKING: null }, "bob");
    view = await settings.update({ AGENT_TIMEOUT_MS: undefined, MODEL_THINKING: undefined }, "bob");
    assert.equal(mine.agentTimeoutMs, 3_600_000);
    assert.equal(mine.modelEndpoint?.thinkingLevel, undefined);
    assert.equal(view.settings.find((item) => item.key === "AGENT_TIMEOUT_MS")!.updatedBy, undefined);
    assert.deepEqual(
      view.audits.map((item) => [item.actor, item.key, item.oldValue, item.newValue]),
      [
        ["bob", "MODEL_THINKING", null, undefined],
        ["bob", "AGENT_TIMEOUT_MS", 1_800_000, undefined],
        ["bob", "MODEL_THINKING", "low", null],
        ["alice", "SAST_SCAN_ENABLED", undefined, false],
        ["alice", "MODEL_THINKING", undefined, "low"],
        ["alice", "AGENT_TIMEOUT_MS", undefined, 1_800_000],
      ],
    );
    await otherSettings.refresh();
    assert.equal(other.agentTimeoutMs, 3_600_000);
    assert.equal(other.sastScan, false);
  } finally {
    await database.close();
  }
});
