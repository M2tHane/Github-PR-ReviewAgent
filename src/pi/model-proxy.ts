import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

// Pi 进程只拿到占位 key；代理转发时换成真实 key，模型凭据不进入 Agent 的进程环境和配置文件。
export const KEY_PLACEHOLDER = "pi-service-key-placeholder";
const DROP_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding"]);
const DROP_RESPONSE = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);
// Pi 自身的重试关闭；会话中途的限流、过载和网络抖动由代理有限次重试，避免整个会话作废、从头重跑。
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 10_000;

export interface ProxyHooks {
  // 转发前调用：预留预算并返回实际发送的请求体；抛错则不转发，Pi 收到错误响应。
  prepare(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  // 重试前调用：按剩余预算对同一请求重新预留；抛错则不重试，Pi 收到上一次的上游结果。
  // answered 为 true 表示上一次尝试收到了上游的错误响应，请求明确没被处理，不计消耗；
  // 为 false 表示没收到响应（网络错误），上游是否处理未知，上一次的预留计入未知消耗。
  retry(body: Record<string, unknown>, answered: boolean): Promise<Record<string, unknown>>;
  rejected(error: Error): void;
}

// 每次 Agent 运行一个本地代理，只转发到配置的模型服务地址。retryDelaysMs 是每次重试前的等待，测试可缩短。
export async function startModelProxy(
  upstream: string,
  apiKey: string,
  hooks: ProxyHooks,
  retryDelaysMs = RETRY_DELAYS_MS,
) {
  const base = upstream.replace(/\/+$/, "");
  const inflight = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    inflight.add(controller);
    response.on("close", () => controller.abort());
    try {
      if (request.method !== "GET" && request.method !== "POST") throw new ProxyRejection("只允许 GET 和 POST");
      let body: string | undefined, prepared: Record<string, unknown> | undefined;
      if (request.method === "POST") {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse((await readBody(request)).toString("utf8"));
        } catch {
          throw new ProxyRejection("模型请求体不是有效 JSON");
        }
        try {
          prepared = await hooks.prepare(parsed);
          body = JSON.stringify(prepared);
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
      let upstreamResponse: Response | undefined, failure: unknown;
      // 只在还没向 Pi 写出任何内容时重试；被取消的请求不重试，等待期间取消立即结束。
      for (let attempt = 0; ; attempt++) {
        try {
          upstreamResponse = await fetch(url, { method: request.method, headers, body, signal: controller.signal });
          failure = undefined;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          upstreamResponse = undefined;
          failure = error;
        }
        const delay =
          prepared && attempt < retryDelaysMs.length
            ? retryDelay(upstreamResponse, retryDelaysMs[attempt]!)
            : undefined;
        if (delay === undefined) break;
        await sleep(delay, undefined, { signal: controller.signal });
        try {
          body = JSON.stringify(await hooks.retry(prepared!, upstreamResponse !== undefined));
        } catch {
          break;
        }
        await upstreamResponse?.body?.cancel().catch(() => undefined);
      }
      if (!upstreamResponse) throw failure;
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

// 返回重试前的等待毫秒数，不重试时返回 undefined。上游给的 Retry-After 超过 10 秒时不在会话里等，原样交给 Pi。
function retryDelay(response: Response | undefined, fallback: number) {
  if (!response) return fallback;
  if (!RETRY_STATUS.has(response.status)) return undefined;
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return fallback;
  const ms = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  if (Number.isNaN(ms)) return fallback;
  return ms > MAX_RETRY_AFTER_MS ? undefined : Math.max(0, ms);
}

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
