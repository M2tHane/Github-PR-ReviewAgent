import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function withWorkspace<T>(cloneUrl: string, token: string, baseSha: string, headSha: string, run: (root: string) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  options.signal?.throwIfAborted();
  // 非交互 Git 认证与固定快照的理由见 .agents/decisions/github-workspace-security.md。
  const root = await mkdtemp(join(tmpdir(), "pi-review-"));
  const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`, GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null", GIT_CONFIG_KEY_2: "credential.helper", GIT_CONFIG_VALUE_2: "" };
  try {
    await exec("git", ["init", "--quiet", root], { env: gitEnv, signal: options.signal });
    await exec("git", ["-C", root, "remote", "add", "origin", cloneUrl], { env: gitEnv, signal: options.signal });
    await exec("git", ["-C", root, "fetch", "--quiet", "--depth=1", "origin", baseSha, headSha], { env: gitEnv, signal: options.signal });
    await exec("git", ["-C", root, "checkout", "--quiet", "--detach", headSha], { env: gitEnv, signal: options.signal });
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "HEAD"], { env: gitEnv, signal: options.signal });
    if (stdout.trim() !== headSha) throw new Error("Workspace head SHA 不匹配");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function resolveWorkspaceFile(root: string, requested: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, requested);
  if (relative(rootReal, candidate).startsWith("..")) throw new Error("路径超出 Workspace");
  const parentReal = await realpath(dirname(candidate));
  if (relative(rootReal, parentReal).startsWith("..")) throw new Error("符号链接超出 Workspace");
  const fileReal = await realpath(candidate);
  if (relative(rootReal, fileReal).startsWith("..")) throw new Error("符号链接超出 Workspace");
  return fileReal;
}

export async function readWorkspaceFile(root: string, requested: string, signal?: AbortSignal): Promise<string> {
  return readFile(await resolveWorkspaceFile(root, requested, signal), { encoding: "utf8", signal });
}

// 只读取文件开头，避免一个大文件把整次审查的 token 预算耗光。
export async function readWorkspaceFileHead(root: string, requested: string, maxBytes: number): Promise<{ text: string; truncated: boolean; totalBytes: number }> {
  const file = await open(await resolveWorkspaceFile(root, requested), "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return { text: new TextDecoder().decode(buffer.subarray(0, bytesRead)), truncated: size > maxBytes, totalBytes: size };
  } finally {
    await file.close();
  }
}

// 用 git grep 做字面搜索：跳过 .git、二进制文件和符号链接，不逐个读取整个仓库。
export async function searchWorkspace(root: string, query: string, limit: number): Promise<string[]> {
  const child = spawn("git", ["-C", root, "grep", "--no-index", "--no-color", "-n", "-I", "-F", "-e", query], { stdio: ["ignore", "pipe", "ignore"] });
  child.once("error", () => undefined);
  const matches: string[] = [];
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    matches.push(line.length > 300 ? line.slice(0, 300) : line);
    if (matches.length >= limit) { child.kill(); break; }
  }
  return matches;
}
