import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessesUnder } from "../pi/session.js";

// 任务的临时目录：工作区（pi-review-）、Pi 运行目录（pi-run-）和浏览器 socket 目录（pi-pw-）。
// 正常结束时都会删掉；服务被强行结束、机器重启时会留下，连同里面还在跑的进程一起清理。
const PREFIXES = ["pi-review-", "pi-run-", "pi-pw-"];

// 删除超过 maxAgeMs 没有变化的任务临时目录；比任务时限更久的目录不可能还在用。返回删除的个数。
export async function removeStaleTaskDirectories(maxAgeMs: number, roots = [tmpdir(), "/tmp"]) {
  let removed = 0;
  for (const root of new Set(roots)) {
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const path = join(root, name);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isDirectory() || Date.now() - info.mtimeMs < maxAgeMs) continue;
      await killProcessesUnder(path);
      await rm(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
