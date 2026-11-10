import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 在 Pi 进程里运行的 codegraph 工具。每个 Pi 进程只启动一个常驻的 `codegraph serve --mcp`：
// codegraph 每个新进程的第一次查询要先加载索引（实测约 6 秒），之后的查询只要几十毫秒。
// 启动时先预热一次，和模型的第一次思考并行。查询固定在当前工作区，模型不能指定其他项目目录。
const CALL_TIMEOUT_MS = 60_000;

const Kind = Type.Optional(
  Type.Union(
    ["function", "method", "class", "interface", "type", "variable", "route", "component"].map((kind) =>
      Type.Literal(kind),
    ),
  ),
);
const TOOLS: Array<{ name: string; label: string; description: string; parameters: TSchema }> = [
  {
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Return source for several related symbols grouped by file, plus the call paths between them.",
    parameters: Type.Object({
      query: Type.String({ description: "Specific symbols, files, or code terms to explore." }),
      maxFiles: Type.Optional(Type.Number({ default: 12 })),
    }),
  },
  {
    name: "codegraph_search",
    label: "CodeGraph Search",
    description: "Quick symbol search by name. Returns locations only.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name." }),
      kind: Kind,
      limit: Type.Optional(Type.Number({ default: 10 })),
    }),
  },
  {
    name: "codegraph_callers",
    label: "CodeGraph Callers",
    description: "Find all functions or methods that call a specific symbol.",
    parameters: Type.Object({ symbol: Type.String(), limit: Type.Optional(Type.Number({ default: 20 })) }),
  },
  {
    name: "codegraph_callees",
    label: "CodeGraph Callees",
    description: "Find all functions or methods that a specific symbol calls.",
    parameters: Type.Object({ symbol: Type.String(), limit: Type.Optional(Type.Number({ default: 20 })) }),
  },
  {
    name: "codegraph_impact",
    label: "CodeGraph Impact",
    description: "Analyze the impact radius of changing a symbol.",
    parameters: Type.Object({ symbol: Type.String(), depth: Type.Optional(Type.Number({ default: 2 })) }),
  },
  {
    name: "codegraph_node",
    label: "CodeGraph Node",
    description: "Get one symbol's details plus its callers and callees.",
    parameters: Type.Object({
      symbol: Type.String(),
      includeCode: Type.Optional(Type.Boolean({ default: false })),
    }),
  },
  {
    name: "codegraph_files",
    label: "CodeGraph Files",
    description: "Get the project file structure from the CodeGraph index. path is a root-relative prefix.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      pattern: Type.Optional(Type.String()),
      format: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("flat"), Type.Literal("grouped")])),
      includeMetadata: Type.Optional(Type.Boolean({ default: true })),
      maxDepth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: "codegraph_status",
    label: "CodeGraph Status",
    description: "Get CodeGraph index status.",
    parameters: Type.Object({}),
  },
];

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class CodegraphClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = "";
  private stderr = "";
  constructor(private readonly cwd: string) {}

  // 进程意外退出后，下一次调用重新启动。
  private start() {
    if (this.ready) return this.ready;
    const child = spawn("codegraph", ["serve", "--mcp", "--path", this.cwd], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-1000);
    });
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code) =>
      fail(new Error(`codegraph 已退出（${code}）${this.stderr ? `：${this.stderr.trim()}` : ""}`)),
    );
    child.stdin.on("error", () => undefined);
    this.ready = this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-review-service", version: "1" },
    }).then(() => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }
  private receive(line: string) {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else entry.resolve(message.result);
  }
  private send(method: string, params: object, signal?: AbortSignal) {
    const child = this.child;
    if (!child) return Promise.reject(new Error("codegraph 未启动"));
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      // 超时说明 codegraph 卡住了：结束它，下次调用重新启动。
      const timer = setTimeout(() => {
        done();
        reject(new Error(`codegraph 查询超过 ${CALL_TIMEOUT_MS / 1000} 秒未返回`));
        if (this.child === child) child.kill();
      }, CALL_TIMEOUT_MS);
      const abort = () => {
        done();
        reject(new Error("codegraph 查询已取消"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.start();
    const result = await this.send("tools/call", { name, arguments: { ...args, projectPath: this.cwd } }, signal);
    const text = (result?.content ?? [])
      .filter((part: { type?: string }) => part?.type === "text")
      .map((part: { text: string }) => part.text)
      .join("\n");
    if (result?.isError) throw new Error(text || "codegraph 查询失败");
    return text || JSON.stringify(result);
  }
  stop() {
    // 先关输入让 codegraph 自己退出，再结束 npm 启动器。
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}

export default function codegraphExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const client = new CodegraphClient(cwd);
  for (const tool of TOOLS)
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id, params, signal) {
        const args = { ...(params as Record<string, unknown>) };
        delete args.projectPath;
        // codegraph_files 的 path 是相对项目根的前缀；模型给了工作区内的绝对路径时换成相对路径。
        if (tool.name === "codegraph_files" && typeof args.path === "string" && isAbsolute(args.path)) {
          const inside = relative(cwd, args.path);
          if (inside && !inside.startsWith("..") && !isAbsolute(inside)) args.path = inside.split(sep).join("/");
          else delete args.path;
        }
        return { content: [{ type: "text" as const, text: await client.call(tool.name, args, signal) }], details: {} };
      },
    });
  // 预热：先查一次状态，让 codegraph 加载索引。失败不影响任务，真正查询时会重新启动。
  pi.on("session_start", () => {
    void client.call("codegraph_status", {}).catch(() => undefined);
  });
  pi.on("session_shutdown", () => client.stop());
}
