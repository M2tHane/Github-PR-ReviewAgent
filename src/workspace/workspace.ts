import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const exec = promisify(execFile);

// 运行 git 时只给必需的环境变量：不继承服务的密钥（模型 Key、数据库地址、Session 密钥等），
// 不读宿主机的全局／系统 git 配置（其中的 filter、helper 会作用到待审仓库），不执行 hooks，不拉 LFS 大文件。
const PASS_THROUGH = [
  "PATH",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
];
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASS_THROUGH) if (process.env[name]) env[name] = process.env[name];
  const count = Number(extra.GIT_CONFIG_COUNT ?? 0);
  const fixed = [
    ["core.hooksPath", "/dev/null"],
    ["credential.helper", ""],
  ];
  return {
    ...env,
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: String(count + fixed.length),
    ...Object.fromEntries(
      fixed.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${count + index}`, key],
        [`GIT_CONFIG_VALUE_${count + index}`, value],
      ]),
    ),
  };
}

export async function withWorkspace<T>(
  cloneUrl: string,
  token: string,
  baseSha: string,
  headSha: string,
  run: (root: string) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  // 非交互 Git 认证与固定快照的理由见 .agents/decisions/github-workspace-security.md。
  const root = await mkdtemp(join(tmpdir(), "pi-review-"));
  const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
  const https = cloneUrl.startsWith("https://");
  const env = gitEnv({
    // 只允许克隆地址本身的协议；认证头只发给克隆地址所在的站点，git-lfs 等按仓库配置访问别处时不会带上。
    GIT_ALLOW_PROTOCOL: https ? "https" : "file",
    ...(https
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${new URL(cloneUrl).origin}/.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
        }
      : {}),
  });
  try {
    await exec("git", ["init", "--quiet", root], { env, signal: options.signal });
    await exec("git", ["-C", root, "remote", "add", "origin", cloneUrl], { env, signal: options.signal });
    await exec("git", ["-C", root, "fetch", "--quiet", "--depth=1", "origin", baseSha, headSha], {
      env,
      signal: options.signal,
    });
    await exec("git", ["-C", root, "checkout", "--quiet", "--detach", headSha], {
      env,
      signal: options.signal,
    });
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "HEAD"], { env, signal: options.signal });
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
export async function readWorkspaceFileHead(
  root: string,
  requested: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; totalBytes: number }> {
  const file = await open(await resolveWorkspaceFile(root, requested), "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return {
      text: new TextDecoder().decode(buffer.subarray(0, bytesRead)),
      truncated: size > maxBytes,
      totalBytes: size,
    };
  } finally {
    await file.close();
  }
}

// 用 git grep 做字面搜索：跳过 .git、二进制文件和符号链接，不逐个读取整个仓库。
export async function searchWorkspace(root: string, query: string, limit: number): Promise<string[]> {
  const child = spawn("git", ["-C", root, "grep", "--no-index", "--no-color", "-n", "-I", "-F", "-e", query], {
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
  child.once("error", () => undefined);
  const matches: string[] = [];
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    matches.push(line.length > 300 ? line.slice(0, 300) : line);
    if (matches.length >= limit) {
      child.kill();
      break;
    }
  }
  return matches;
}
