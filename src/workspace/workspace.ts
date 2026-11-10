import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

// 读取固定提交里的文件，而不是工作区里可能已被改过的版本；不存在、不是普通文件或过大时返回 undefined。
export async function readBaseFile(root: string, sha: string, path: string, maxBytes = 64_000) {
  const env = gitEnv();
  const listed = await exec("git", ["-C", root, "ls-tree", "-z", sha, "--", path], { env }).catch(() => undefined);
  const [mode, type, object] = (listed?.stdout.split("\0")[0] ?? "").split(/\s+/);
  if (type !== "blob" || !["100644", "100755"].includes(mode!)) return undefined;
  const { stdout: size } = await exec("git", ["-C", root, "cat-file", "-s", object!], { env });
  if (Number(size) > maxBytes) return undefined;
  return (await exec("git", ["-C", root, "cat-file", "blob", object!], { env, maxBuffer: maxBytes + 1024 })).stdout;
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
