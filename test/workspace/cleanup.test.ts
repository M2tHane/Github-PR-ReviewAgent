import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStaleTaskDirectories } from "../../src/workspace/cleanup.js";

test("中断任务留下的临时目录：超时的连同里面的进程一起清理，最近的和无关的目录保留", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stale = join(root, "pi-review-stale"),
    fresh = join(root, "pi-run-fresh"),
    other = join(root, "other-stale");
  for (const dir of [stale, fresh, other]) await mkdir(dir);
  // 模拟中断任务里还在跑的服务：工作目录在旧工作区里，自己一个进程组。
  const child = spawn("sleep", ["60"], { cwd: stale, detached: true, stdio: "ignore" });
  child.unref();
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  await utimes(stale, hourAgo, hourAgo);
  await utimes(other, hourAgo, hourAgo);
  assert.equal(await removeStaleTaskDirectories(30 * 60_000, [root]), 1);
  assert.equal(existsSync(stale), false);
  assert(existsSync(fresh) && existsSync(other));
  assert.throws(() => process.kill(child.pid!, 0), "旧工作区里的进程被结束");
});
