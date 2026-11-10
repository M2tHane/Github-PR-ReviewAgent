import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";
import { parseReviewComment } from "../parser.js";
import { acceptPullRequestComment } from "./pull-request-comment.js";

export async function handleReviewComment(
  config: Config,
  target: JobAcceptor | ((job: ReviewJob) => Promise<void>),
  deliveryId: string,
  payload: unknown,
  response: ServerResponse,
) {
  if (typeof target === "function") return send(response, 200, { ignored: true });
  const raw = payload as any;
  // 开发 PR 上代码行的评论（含回复）交给开发任务；其余照旧只处理对本 App 审查意见的回复。
  if (
    raw?.action === "created" &&
    Number.isSafeInteger(raw?.repository?.id) &&
    typeof raw?.repository?.full_name === "string" &&
    config.allowedRepositories.has(raw.repository.full_name.toLowerCase()) &&
    Number.isSafeInteger(raw?.pull_request?.number) &&
    Number.isSafeInteger(raw?.comment?.id) &&
    typeof raw?.comment?.body === "string" &&
    typeof raw?.comment?.user?.login === "string" &&
    (await acceptPullRequestComment(
      config,
      target,
      {
        repositoryId: raw.repository.id,
        prNumber: raw.pull_request.number,
        source: "review_comment",
        commentId: raw.comment.id,
        login: raw.comment.user.login,
        body: codeComment(raw.comment),
        association: raw.comment.author_association,
        open: raw.pull_request.state === "open",
        authorType: raw.comment.user.type,
      },
      response,
    ))
  )
    return;
  if (!("acceptReply" in target) || typeof target.acceptReply !== "function")
    return send(response, 200, { ignored: true });
  if (
    raw?.action !== "created" ||
    raw?.pull_request?.draft === true ||
    !Number.isSafeInteger(raw?.comment?.in_reply_to_id) ||
    raw?.comment?.user?.type !== "User"
  )
    return send(response, 200, { ignored: true });
  let input;
  try {
    input = parseReviewComment(payload);
  } catch (error) {
    return send(response, 422, { error: error instanceof Error ? error.message : "payload 无效" });
  }
  if (
    input.action !== "created" ||
    input.state !== "open" ||
    input.authorType !== "User" ||
    !config.allowedRepositories.has(input.repository.toLowerCase())
  )
    return send(response, 200, { ignored: true });
  let result;
  try {
    result = await target.acceptReply({ ...input, deliveryId });
  } catch {
    return send(response, 503, { error: "任务持久化失败" });
  }
  return result.kind === "ignored"
    ? send(response, 200, { ignored: true })
    : send(response, 202, {
        accepted: result.kind === "accepted",
        duplicate: result.kind === "duplicate",
        jobId: result.job?.id,
      });
}

// 代码行评论带上位置，Agent 不用再去查评论落在哪一行。
function codeComment(comment: { path?: unknown; line?: unknown; body: string }) {
  const where =
    typeof comment.path === "string"
      ? `${comment.path}${Number.isSafeInteger(comment.line) ? `:${comment.line}` : ""}`
      : "";
  return where ? `（评论在 ${where}）\n${comment.body}` : comment.body;
}
