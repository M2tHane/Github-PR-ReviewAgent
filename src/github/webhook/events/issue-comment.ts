import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";
import { acceptPullRequestComment } from "./pull-request-comment.js";

// issue 里的新评论：开发需求讨论 issue 交给 acceptIssueComment；开发 PR 对话里的评论（issue.pull_request 存在）
// 交给 acceptPullRequestComment。只认人发的评论，机器人自己的回复都忽略。
export async function handleIssueComment(
  config: Config,
  target: JobAcceptor | ((job: ReviewJob) => Promise<void>),
  payload: unknown,
  response: ServerResponse,
) {
  if (typeof target === "function" || typeof target.acceptIssueComment !== "function")
    return send(response, 200, { ignored: true });
  const raw = payload as any;
  if (raw?.action !== "created" || raw?.issue?.state !== "open" || raw?.comment?.user?.type !== "User")
    return send(response, 200, { ignored: true });
  if (
    !Number.isSafeInteger(raw?.repository?.id) ||
    typeof raw?.repository?.full_name !== "string" ||
    !Number.isSafeInteger(raw?.issue?.number) ||
    !Number.isSafeInteger(raw?.comment?.id) ||
    typeof raw?.comment?.body !== "string" ||
    typeof raw?.comment?.user?.login !== "string"
  )
    return send(response, 422, { error: "缺少 issue comment 必需字段" });
  if (!config.allowedRepositories.has(raw.repository.full_name.toLowerCase()))
    return send(response, 200, { ignored: true });
  if (raw.issue.pull_request) {
    const handled = await acceptPullRequestComment(
      config,
      target,
      {
        repositoryId: raw.repository.id,
        prNumber: raw.issue.number,
        source: "comment",
        commentId: raw.comment.id,
        login: raw.comment.user.login,
        body: raw.comment.body,
        association: raw.comment.author_association,
        open: true,
        authorType: raw.comment.user.type,
      },
      response,
    );
    return handled ? undefined : send(response, 200, { ignored: true });
  }
  let result;
  try {
    result = await target.acceptIssueComment(
      {
        repositoryId: raw.repository.id,
        issueNumber: raw.issue.number,
        commentId: raw.comment.id,
        login: raw.comment.user.login,
        body: raw.comment.body,
      },
      config,
    );
  } catch {
    return send(response, 503, { error: "任务持久化失败" });
  }
  return result.kind === "ignored"
    ? send(response, 200, { ignored: true })
    : send(response, 202, {
        accepted: result.kind === "accepted",
        duplicate: result.kind === "duplicate",
        task: result.taskKind,
      });
}
