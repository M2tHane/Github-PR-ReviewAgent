import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";
import { acceptPullRequestComment } from "./pull-request-comment.js";

// 提交 review 时写的总评。只有开发 PR 用到：交给开发任务；其余忽略。
export async function handlePullRequestReview(
  config: Config,
  target: JobAcceptor | ((job: ReviewJob) => Promise<void>),
  payload: unknown,
  response: ServerResponse,
) {
  const raw = payload as any;
  if (typeof target === "function" || raw?.action !== "submitted" || typeof raw?.review?.body !== "string")
    return send(response, 200, { ignored: true });
  if (
    !Number.isSafeInteger(raw?.repository?.id) ||
    typeof raw?.repository?.full_name !== "string" ||
    !Number.isSafeInteger(raw?.pull_request?.number) ||
    !Number.isSafeInteger(raw?.review?.id) ||
    typeof raw?.review?.user?.login !== "string"
  )
    return send(response, 422, { error: "缺少 pull request review 必需字段" });
  if (!config.allowedRepositories.has(raw.repository.full_name.toLowerCase()))
    return send(response, 200, { ignored: true });
  const handled = await acceptPullRequestComment(
    config,
    target,
    {
      repositoryId: raw.repository.id,
      prNumber: raw.pull_request.number,
      source: "review",
      commentId: raw.review.id,
      login: raw.review.user.login,
      body: raw.review.body,
      association: raw.review.author_association,
      open: raw.pull_request.state === "open",
      authorType: raw.review.user.type,
    },
    response,
  );
  return handled ? undefined : send(response, 200, { ignored: true });
}
