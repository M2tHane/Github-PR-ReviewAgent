import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "../../config/config.js";
import type { JobAcceptor } from "../../persistence/database.js";
import { JobQueue } from "../../jobs/queue.js";
import type { ReviewJob } from "../../jobs/types.js";
import { readBody, send } from "./http.js";
import { verifySignature } from "./signature.js";
import { handleInstallation } from "./events/installation.js";
import { handleReviewComment } from "./events/review-comment.js";
import { handlePullRequest } from "./events/pull-request.js";

// 服务实际处理的事件；其余事件验签后直接忽略。漏投递补偿（redelivery.ts）也只补这些。
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "pull_request_review_comment",
  "installation",
  "installation_repositories",
]);

export function createApp(
  config: Config,
  target: JobAcceptor | ((job: ReviewJob) => Promise<void>),
  fallback?: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const queue = typeof target === "function" ? new JobQueue(config.queueCapacity, target) : undefined;
  const accept =
    typeof target === "function"
      ? (
          input: Omit<ReviewJob, "id" | "status">,
          _meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null },
        ) => Promise.resolve(queue!.enqueue(input))
      : target.accept.bind(target);
  const server = createServer(async (request, response) => {
    // 部署平台用的探针：healthz 只看进程活着；readyz 还要数据库可用、服务没有在停止。
    if (request.method === "GET" && request.url === "/healthz") return send(response, 200, { ok: true });
    if (request.method === "GET" && request.url === "/readyz") {
      if (typeof target === "function") return send(response, 200, { ok: true });
      if (target.isStopping?.()) return send(response, 503, { ok: false, reason: "stopping" });
      try {
        await target.check?.();
        return send(response, 200, { ok: true });
      } catch {
        return send(response, 503, { ok: false, reason: "database" });
      }
    }
    if (request.method !== "POST" || request.url !== "/github/webhook")
      return fallback ? fallback(request, response) : send(response, 404, { error: "not found" });
    const eventName = request.headers["x-github-event"];
    const deliveryId = request.headers["x-github-delivery"];
    const signature = request.headers["x-hub-signature-256"];
    if (typeof eventName !== "string" || typeof deliveryId !== "string" || typeof signature !== "string")
      return send(response, 400, { error: "缺少 GitHub header" });
    if (Number(request.headers["content-length"]) > config.webhookMaxBytes)
      return send(response, 413, { error: "请求体过大" });
    let body: Buffer;
    try {
      body = await readBody(request, config.webhookMaxBytes);
    } catch (error) {
      return send(response, error instanceof RangeError ? 413 : 400, { error: "请求体读取失败" });
    }
    if (!verifySignature(body, signature, config.webhookSecret)) return send(response, 401, { error: "签名无效" });
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return send(response, 400, { error: "JSON 无效" });
    }
    if (!HANDLED_EVENTS.has(eventName)) return send(response, 200, { ignored: true });
    if (eventName === "installation" || eventName === "installation_repositories")
      return handleInstallation(target, eventName, deliveryId, payload, response);
    if (eventName === "pull_request_review_comment")
      return handleReviewComment(config, target, deliveryId, payload, response);
    return handlePullRequest(config, target, accept, deliveryId, eventName, payload, response);
  });
  return { server, queue };
}
