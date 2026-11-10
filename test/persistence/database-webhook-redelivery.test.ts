import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../../src/persistence/database.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();

test("漏投递补偿：两个实例同时到点时只有一个拿到锁，结束后锁释放", { skip: !fixture.url }, async () => {
  const first = new Database(fixture.url!);
  const second = new Database(fixture.url!);
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const winner = first.withWebhookRedeliveryLock(async () => {
      entered();
      await held;
      return "ran";
    });
    await running;
    let ran = false;
    assert.equal(
      await second.withWebhookRedeliveryLock(async () => {
        ran = true;
        return "ran";
      }),
      undefined,
    );
    assert.equal(ran, false);
    release();
    assert.equal(await winner, "ran");
    assert.equal(await second.withWebhookRedeliveryLock(async () => "ran"), "ran");
    // 执行中抛错也要释放锁，否则之后每一轮都会被跳过。
    await assert.rejects(
      first.withWebhookRedeliveryLock(async () => {
        throw new Error("github down");
      }),
      /github down/,
    );
    assert.equal(await second.withWebhookRedeliveryLock(async () => "ran"), "ran");
  } finally {
    await first.close();
    await second.close();
  }
});
