import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import { sessionSteps } from "../pi/session-record.js";
import type { Repository, Session } from "./dto.js";
import { json } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Agent 执行过程：按步骤展示，或下载整理后的 Pi 会话原始记录（JSONL）。权限和所属任务一致。
export function createAgentSessionsRoute(
  config: Config,
  database: Database,
  authorize: (
    request: IncomingMessage,
    response: ServerResponse,
    repositoryId: number,
  ) => Promise<{ user: Session; repository: Repository } | undefined>,
) {
  return async (request: IncomingMessage, response: ServerResponse, id: string, raw: boolean) => {
    if (request.method !== "GET") return json(response, 405, { error: "不支持的操作" });
    if (!UUID.test(id)) return json(response, 404, { error: "执行记录不存在" });
    const session = await database.getAgentSession(id);
    if (!session) return json(response, 404, { error: "执行记录不存在" });
    const access = await authorize(request, response, Number(session.repository_id));
    if (!access) return;
    if (session.development && !config.allowedRepositories.has(access.repository.fullName.toLowerCase()))
      return json(response, 403, { error: "仓库未授权" });
    if (raw) {
      response
        .writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="agent-session-${session.role}-${session.id}.jsonl"`,
          "cache-control": "no-store",
        })
        .end(session.content);
      return;
    }
    const { content, timings, events, ...summary } = session;
    const startedAt = new Date(session.started_at).getTime();
    // 进行中的记录按当前时间计算耗时，未完成的步骤显示为进行中。
    const running = session.status === "running";
    const durationMs = running ? Math.max(session.duration_ms, Date.now() - startedAt) : session.duration_ms;
    return json(response, 200, {
      ...summary,
      duration_ms: durationMs,
      timeline: sessionSteps(content, timings, startedAt, durationMs, events, running),
    });
  };
}
