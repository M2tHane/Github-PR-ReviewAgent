import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitEnv } from "../workspace/workspace.js";
import { DevelopmentError, type FileChange } from "./types.js";
import { safePath } from "./policy.js";
const exec = promisify(execFile);
export async function repositoryFiles(root: string, signal: AbortSignal) {
  const { stdout } = await exec("git", ["-C", root, "ls-tree", "-r", "-z", "HEAD"], {
    env: gitEnv(),
    signal,
    maxBuffer: 8 * 1024 * 1024,
  });
  const files = new Map<string, string>();
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    files.set(entry.slice(tab + 1), entry.slice(0, 6));
  }
  return files;
}
export async function validateChanges(
  root: string,
  files: Map<string, string>,
  changes: FileChange[],
  signal: AbortSignal,
) {
  const result: Array<FileChange & { mode: string }> = [];
  for (const change of changes) {
    signal.throwIfAborted();
    safePath(change.path);
    const mode = files.get(change.path);
    const lower = change.path.toLowerCase();
    for (const [existing, kind] of files) {
      const other = existing.toLowerCase();
      if (
        (lower === other && change.path !== existing) ||
        lower.startsWith(other + "/") ||
        other.startsWith(lower + "/")
      )
        throw new DevelopmentError("修改路径与已有文件、目录或大小写冲突：" + change.path);
      if (lower === other && !["100644", "100755"].includes(kind))
        throw new DevelopmentError("不能修改符号链接或子模块：" + change.path);
    }
    for (const other of changes)
      if (other !== change && lower.startsWith(other.path.toLowerCase() + "/"))
        throw new DevelopmentError("文件改动存在路径冲突：" + change.path);
    if (!mode && change.content === null) throw new DevelopmentError("不能删除不存在的文件：" + change.path);
    if (mode) {
      const previous = await readFile(join(root, change.path), { signal });
      if (previous.includes(0) || previous.byteLength > 200_000)
        throw new DevelopmentError("不支持修改二进制或超过 200 KB 的文件：" + change.path);
      if (change.content !== null && previous.equals(Buffer.from(change.content))) continue;
    }
    result.push({ ...change, mode: mode ?? "100644" });
  }
  if (!result.length) throw new DevelopmentError("代码没有产生实际变化，无需创建 PR。", "refused");
  return result;
}
