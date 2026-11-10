// 服务自有的 Pi 扩展，由 Pi 进程加载：限制文件工具的路径、给读取结果打码、写入前请服务检查、
// 读写后附上团队规则，并把服务端工具转发给服务执行。状态都留在服务里，扩展只转发。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Unsafe } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../health/secrets.js";

export const BRIDGE_PREFIX = "pi-service:";
export interface ServiceExtensionConfig {
  root: string;
  readOnlyRoots: string[];
  tools: Array<{ name: string; label: string; description: string; parameters: object }>;
  read: boolean;
  write: boolean;
}
type TextPart = { type: "text"; text: string };
const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const REDACT_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

export default function serviceExtension(pi: ExtensionAPI) {
  const config = JSON.parse(readFileSync(process.env.PI_SERVICE_CONFIG!, "utf8")) as ServiceExtensionConfig;
  const ask = async (ctx: ExtensionContext, message: object): Promise<Record<string, any>> => {
    const answer = await ctx.ui.input(BRIDGE_PREFIX + JSON.stringify(message));
    if (answer === undefined) throw new Error("服务没有响应");
    return JSON.parse(answer);
  };
  const locate = (cwd: string, path: unknown, tool: string) => {
    const resolved = piPath(cwd || config.root, typeof path === "string" && path ? path : ".");
    const target = realTarget(tool === "read" ? readVariant(resolved) : resolved);
    return { target, relativePath: relative(config.root, target).split(sep).join("/") };
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!PATH_TOOLS.has(event.toolName)) return;
    const { target, relativePath } = locate(ctx.cwd, (event.input as { path?: unknown }).path, event.toolName);
    const writing = WRITE_TOOLS.has(event.toolName);
    const roots = writing ? [config.root] : [config.root, ...config.readOnlyRoots];
    if (!roots.some((root) => inside(root, target))) return { block: true, reason: "路径超出工作区，只能访问当前仓库" };
    if (!writing) return;
    const top = relativePath.split("/")[0];
    if (!relativePath || top === ".git" || top === ".codegraph")
      return { block: true, reason: "不能修改仓库根目录、.git 或 .codegraph" };
    if (!config.write) return { block: true, reason: "本任务只读，不能修改文件" };
    const answer = await ask(ctx, { type: "write", tool: event.toolName, path: relativePath });
    if (!answer.allow) return { block: true, reason: String(answer.reason ?? "服务拒绝修改此文件") };
  });

  pi.on("tool_result", async (event, ctx) => {
    let content = event.content as Array<TextPart | { type: string }>;
    let redacted = false;
    // codegraph 返回源码片段、浏览器返回网页内容，和读取工具一样打码。
    if (
      REDACT_TOOLS.has(event.toolName) ||
      event.toolName.startsWith("codegraph_") ||
      event.toolName.startsWith("mcp__")
    )
      content = content.map((part) => {
        if (part.type !== "text") return part;
        const text = redactSecrets((part as TextPart).text);
        redacted ||= text !== (part as TextPart).text;
        return { ...part, text };
      });
    let rules: unknown;
    if (!event.isError && (event.toolName === "read" ? config.read : WRITE_TOOLS.has(event.toolName) && config.write)) {
      const { relativePath } = locate(ctx.cwd, (event.input as { path?: unknown }).path, event.toolName);
      if (relativePath && !relativePath.startsWith("../"))
        rules = (
          await ask(ctx, {
            type: event.toolName === "read" ? "read" : "written",
            path: relativePath,
            redacted,
          })
        ).rules;
    }
    if (typeof rules === "string" && rules) content = [...content, { type: "text", text: rules }];
    if (redacted || rules) return { content: content as never };
  });

  for (const tool of config.tools)
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: Unsafe(tool.parameters as never),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const answer = await ask(ctx, { type: "tool", name: tool.name, args: params });
        return { content: answer.content as never, details: {}, isError: Boolean(answer.isError) } as never;
      },
    });
}

function inside(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

// 与 Pi 文件工具解析路径的方式一致（Unicode 空格、去掉 @ 前缀、展开 ~、file:// URL），
// 否则这里检查的路径和工具实际读写的不是同一个。
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function piPath(cwd: string, input: string) {
  let path = input.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
  return resolve(cwd, path);
}

// read 找不到原路径时，Pi 还会按顺序试 macOS 截图文件名的几种写法，取第一个存在的。
function readVariant(path: string) {
  if (existsSync(path)) return path;
  const nfd = path.normalize("NFD");
  for (const variant of [
    path.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    path.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ])
    if (variant !== path && existsSync(variant)) return variant;
  return path;
}

// 不存在的路径按最近存在的上级目录解析符号链接，防止通过链接写到工作区外。
function realTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realTarget(parent), basename(path));
}
