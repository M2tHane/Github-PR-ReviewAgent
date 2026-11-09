import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// Pi 进程只拿到占位 key；代理转发时换成真实 key，模型凭据不进入 Agent 的进程环境和配置文件。
export const KEY_PLACEHOLDER = "pi-service-key-placeholder";
const DROP_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding"]);
const DROP_RESPONSE = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);

export interface ProxyHooks {
  // 转发前调用：预留预算并返回实际发送的请求体；抛错则不转发，Pi 收到错误响应。
  prepare(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  rejected(error: Error): void;
}

// 每次 Agent 运行一个本地代理，只转发到配置的模型服务地址。
export async function startModelProxy(upstream: string, apiKey: string, hooks: ProxyHooks) {
  const base = upstream.replace(/\/+$/, "");
  const inflight = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    inflight.add(controller);
    response.on("close", () => controller.abort());
    try {
      if (request.method !== "GET" && request.method !== "POST") throw new ProxyRejection("只允许 GET 和 POST");
      let body: string | undefined;
      if (request.method === "POST") {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse((await readBody(request)).toString("utf8"));
        } catch {
          throw new ProxyRejection("模型请求体不是有效 JSON");
        }
        try {
          body = JSON.stringify(await hooks.prepare(parsed));
        } catch (error) {
          hooks.rejected(error as Error);
          throw new ProxyRejection((error as Error).message);
        }
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined && !DROP_REQUEST.has(name))
          headers[name] = (Array.isArray(value) ? value.join(", ") : value).replaceAll(KEY_PLACEHOLDER, apiKey);
      const url = base + (request.url ?? "/").replaceAll(KEY_PLACEHOLDER, encodeURIComponent(apiKey));
      const upstreamResponse = await fetch(url, { method: request.method, headers, body, signal: controller.signal });
      response.writeHead(
        upstreamResponse.status,
        Object.fromEntries([...upstreamResponse.headers].filter(([name]) => !DROP_RESPONSE.has(name))),
      );
      if (upstreamResponse.body) for await (const chunk of upstreamResponse.body) response.write(chunk);
      response.end();
    } catch (error) {
      if (response.headersSent) return void response.destroy();
      const rejected = error instanceof ProxyRejection;
      // 上游网络错误保留原始说明，交给 Pi 记成 provider error，任务按错误类型决定是否重试。
      const detail = error instanceof Error ? `${error.message}${causeText(error)}` : String(error);
      response.writeHead(rejected ? 400 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: detail, type: rejected ? "pi_service_rejected" : "upstream" } }));
    } finally {
      inflight.delete(controller);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const controller of inflight) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class ProxyRejection extends Error {}

function causeText(error: Error) {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause ? `: ${cause.code ?? ""} ${cause.message ?? ""}`.trimEnd() : "";
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new ProxyRejection("模型请求体超过 64 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
