import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryAccess } from "../../src/config/repository-access.js";

test("白名单修改等待旧刷新结束后再读数据库，刷新失败保留最近值并报错", async () => {
  const config = { allowedRepositories: new Set(["Owner/Fixed"]) };
  const set = config.allowedRepositories;
  let calls = 0;
  const oldRead = Promise.withResolvers<{ rows: Array<{ full_name: string }> }>();
  const access = new RepositoryAccess(config, {
    query: async () => {
      calls++;
      if (calls === 1) return oldRead.promise;
      if (calls === 2) return { rows: [{ full_name: "Owner/New" }] };
      throw new Error("database unavailable");
    },
  } as any);
  const refreshing = access.refresh();
  const updated = access.refreshAfterUpdate();
  assert.equal(calls, 1);
  oldRead.resolve({ rows: [{ full_name: "Owner/Old" }] });
  await refreshing;
  await updated;
  assert.equal(config.allowedRepositories, set);
  assert.deepEqual([...set], ["owner/fixed", "owner/new"]);
  assert.deepEqual([...access.configured], ["owner/fixed"]);
  await assert.rejects(access.refresh(), /database unavailable/);
  assert.deepEqual([...set], ["owner/fixed", "owner/new"]);
});
