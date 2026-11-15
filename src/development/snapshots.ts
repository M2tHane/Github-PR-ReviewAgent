import { collectSnapshot, type SnapshotFile } from "./changes.js";
import type { DevelopmentStore } from "./store.js";
import type { DevelopmentTask } from "./types.js";
import { log } from "../logging.js";

// 定时保存与结束保存串行，收尾等保存完成后才释放工作区。
export function snapshotRecorder(
  store: DevelopmentStore,
  task: DevelopmentTask,
  root: string,
  sha: string,
  files: Map<string, SnapshotFile>,
) {
  let pending: Promise<unknown> = Promise.resolve();
  const save = () => {
    const next = pending.then(async () => {
      const changes = await collectSnapshot(root, sha, files, new AbortController().signal);
      return store.saveSnapshot(task, sha, changes);
    });
    pending = next.catch((error) => log("error", "development_snapshot_failed", { taskId: task.id }, error));
    return next;
  };
  const timer = setInterval(() => {
    void save();
  }, 5 * 60_000);
  timer.unref();
  return {
    async finish() {
      clearInterval(timer);
      return save();
    },
  };
}
