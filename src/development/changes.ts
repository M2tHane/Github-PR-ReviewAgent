import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gitEnv } from "../workspace/workspace.js";
import { DevelopmentError, type FileChange } from "./types.js";
import { safePath } from "./policy.js";
const exec = promisify(execFile);
const MAX_FILES = 30;
const MAX_BYTES = 200_000;
const REDACTED = "[已隐藏的";
// Agent 能用 bash 改 .git/config；收集改动时用命令行配置盖掉会执行外部命令的项。
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

export interface SnapshotFile {
  mode: string;
  object: string;
  size: number;
}

// 在 Agent 运行前记下快照里每个文件的模式、对象和大小；之后 Agent 改动 .git 也不影响比较基准。
export async function repositoryFiles(root: string, sha: string, signal: AbortSignal) {
  const { stdout } = await exec("git", ["-C", root, "ls-tree", "-r", "-z", "--long", sha], {
    env: gitEnv(),
    signal,
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = new Map<string, SnapshotFile>();
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, , object, size] = entry.slice(0, tab).split(/\s+/);
    files.set(entry.slice(tab + 1), { mode: mode!, object: object!, size: Number(size) || 0 });
  }
  return files;
}

// 把工作区和快照逐个比较，得到要提交的完整改动；未跟踪文件按 .gitignore 过滤，.codegraph 不算改动。
export async function collectChanges(root: string, sha: string, files: Map<string, SnapshotFile>, signal: AbortSignal) {
  const result: Array<FileChange & { mode: string }> = [];
  for (const [path, file] of files) {
    signal.throwIfAborted();
    safePath(path);
    if (file.mode === "160000") continue;
    const stat = await lstat(join(root, path)).catch(() => undefined);
    if (file.mode === "120000") {
      const target = stat?.isSymbolicLink() ? await readlink(join(root, path), "buffer") : undefined;
      if (!target || blobId(target, file.object) !== file.object)
        throw new DevelopmentError(`不能修改或删除符号链接：${path}`);
      continue;
    }
    if (!stat) {
      result.push({ path, content: null, mode: file.mode });
      continue;
    }
    if (!stat.isFile()) throw new DevelopmentError(`不能把文件改成符号链接或目录：${path}`);
    const content = await readFile(join(root, path), { signal });
    if (blobId(content, file.object) === file.object) continue;
    result.push({ path, content: textOf(path, content), mode: file.mode });
  }
  for (const path of await untracked(root, sha, signal)) {
    signal.throwIfAborted();
    if (path.split("/")[0] === ".codegraph") continue;
    if (path.endsWith("/")) throw new DevelopmentError(`不能新增嵌套的 Git 仓库：${path}`);
    const stat = await lstat(join(root, path));
    if (!stat.isFile()) throw new DevelopmentError(`不能新建符号链接：${path}`);
    const content = await readFile(join(root, path), { signal });
    result.push({ path, content: textOf(path, content), mode: stat.mode & 0o111 ? "100755" : "100644" });
  }
  if (!result.length) throw new NoChangesError();
  if (result.length > MAX_FILES)
    throw new DevelopmentError(`改动了 ${result.length} 个文件，超过 ${MAX_FILES} 个的上限：请缩小需求范围。`);
  await checkChanges(root, files, result, signal);
  return result;
}

async function checkChanges(
  root: string,
  files: Map<string, SnapshotFile>,
  changes: Array<FileChange & { mode: string }>,
  signal: AbortSignal,
) {
  const lowered = new Set<string>();
  for (const change of changes) {
    safePath(change.path);
    const lower = change.path.toLowerCase();
    if (lowered.has(lower)) throw new DevelopmentError("文件改动存在大小写冲突：" + change.path);
    lowered.add(lower);
    const previous = files.get(change.path);
    if (!previous)
      for (const existing of files.keys()) {
        const other = existing.toLowerCase();
        if (lower === other || lower.startsWith(other + "/") || other.startsWith(lower + "/"))
          throw new DevelopmentError("新文件与已有文件、目录或大小写冲突：" + change.path);
      }
    if (!previous || change.content === null) continue;
    if (previous.size > MAX_BYTES) throw new DevelopmentError("不支持修改超过 200 KB 的文件：" + change.path);
    const { stdout } = await exec("git", ["-C", root, ...SAFE_GIT, "cat-file", "blob", previous.object], {
      env: gitEnv(),
      signal,
      encoding: "buffer",
      maxBuffer: MAX_BYTES + 1024,
    });
    if (stdout.includes(0)) throw new DevelopmentError("不支持修改二进制文件：" + change.path);
    // 读取结果里的凭据已被替换；占位符写回文件说明模型照抄了打码内容，会丢掉原来的值。
    if (change.content.includes(REDACTED) && !stdout.toString("utf8").includes(REDACTED))
      throw new DevelopmentError("改动把打码后的凭据占位符写进了文件：" + change.path);
  }
}

function textOf(path: string, content: Buffer) {
  if (content.byteLength > MAX_BYTES || content.includes(0))
    throw new DevelopmentError("改动后的文件过大或不是文本：" + path);
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) throw new DevelopmentError("改动后的文件不是 UTF-8 文本：" + path);
  return text;
}

// 与快照比较时用 Git 的对象哈希；对象 ID 长度决定仓库用 SHA-1 还是 SHA-256。
function blobId(content: Buffer, object: string) {
  return createHash(object.length === 64 ? "sha256" : "sha1")
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest("hex");
}

// 用快照建一个临时索引再列未跟踪文件，Agent 自己 git add 或 commit 过的新文件同样算作改动。
async function untracked(root: string, sha: string, signal: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "dev-index-"));
  try {
    const env = gitEnv({ GIT_INDEX_FILE: join(dir, "index") });
    await exec("git", ["-C", root, ...SAFE_GIT, "read-tree", sha], { env, signal });
    const { stdout } = await exec(
      "git",
      ["-C", root, ...SAFE_GIT, "ls-files", "--others", "--exclude-standard", "-z"],
      { env, signal, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SnapshotChange {
  path: string;
  content: string | null;
  mode: string;
}

// 补丁快照保留完整文件内容（base64），不套用发布时的文件数／单文件大小限制。
// 它仍沿用 .gitignore、路径和符号链接过滤，确保恢复不会把 Workspace 之外的内容带回任务。
export async function collectSnapshot(
  root: string,
  sha: string,
  files: Map<string, SnapshotFile>,
  signal: AbortSignal,
): Promise<SnapshotChange[]> {
  const result: SnapshotChange[] = [];
  for (const [path, file] of files) {
    signal.throwIfAborted();
    safePath(path);
    const stat = await lstat(join(root, path)).catch(() => undefined);
    if (file.mode === "160000") continue;
    if (file.mode === "120000") {
      const target = stat?.isSymbolicLink() ? await readlink(join(root, path), "buffer") : undefined;
      if (!target || blobId(target, file.object) !== file.object)
        throw new DevelopmentError(`不能修改或删除符号链接：${path}`);
      continue;
    }
    if (!stat) {
      result.push({ path, content: null, mode: file.mode });
      continue;
    }
    if (!stat.isFile()) throw new DevelopmentError(`不能把文件改成符号链接或目录：${path}`);
    const content = await readFile(join(root, path), { signal });
    if (blobId(content, file.object) !== file.object)
      result.push({ path, content: content.toString("base64"), mode: file.mode });
  }
  for (const path of await untracked(root, sha, signal)) {
    signal.throwIfAborted();
    safePath(path);
    if (path.split("/")[0] === ".codegraph") continue;
    if (path.endsWith("/")) throw new DevelopmentError(`不能新增嵌套的 Git 仓库：${path}`);
    const stat = await lstat(join(root, path));
    if (!stat.isFile()) throw new DevelopmentError(`不能新建符号链接：${path}`);
    const content = await readFile(join(root, path), { signal });
    result.push({ path, content: content.toString("base64"), mode: stat.mode & 0o111 ? "100755" : "100644" });
  }
  return result;
}

export interface EncodedSnapshot {
  changes: SnapshotChange[];
}

export function encodeSnapshot(changes: SnapshotChange[]) {
  return Buffer.from(JSON.stringify({ changes } satisfies EncodedSnapshot), "utf8");
}

export function decodeSnapshot(data: Buffer | Uint8Array): SnapshotChange[] {
  const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as EncodedSnapshot;
  if (!parsed || !Array.isArray(parsed.changes)) throw new Error("开发快照格式无效");
  return parsed.changes;
}

export async function applySnapshot(root: string, changes: SnapshotChange[]) {
  for (const change of changes) {
    safePath(change.path);
    const path = join(root, change.path);
    if (change.content === null) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(change.content, "base64"));
    await chmod(path, change.mode === "100755" ? 0o755 : 0o644);
  }
}

// 工作区和快照相比没有任何改动。
export class NoChangesError extends DevelopmentError {
  constructor() {
    super("代码没有产生实际变化，无需创建 PR。", "refused");
  }
}
