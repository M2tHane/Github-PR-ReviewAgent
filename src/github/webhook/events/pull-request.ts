import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";
import type { PullRequestEvent } from "../../types.js";
import { parsePullRequest } from "../parser.js";
import { log } from "../../../logging.js";

const actions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export async function handlePullRequest(
  config: Config,
  target: JobAcceptor | ((job: ReviewJob) => Promise<void>),
  accept: JobAcceptor["accept"],
  deliveryId: string,
  eventName: string,
  payload: unknown,
  response: ServerResponse,
) {
  let event: PullRequestEvent;
  try {
    event = parsePullRequest(payload);
  } catch (error) {
    return send(response, 422, { error: error instanceof Error ? error.message : "payload 无效" });
  }
  const repository = event.repository.full_name.toLowerCase();
  const pr = event.pull_request;
  const closed = event.action === "closed";
  // 事件快照的时间；补投或人工重投的旧事件靠它识别，不能冲掉更新的状态。
  const eventAt = pr.updated_at ? new Date(pr.updated_at).toISOString() : undefined;
  if (!closed && (pr.draft || pr.state !== "open") && typeof target !== "function")
    // 写库失败时本实例上的会话照样中止；别的实例发布前还会再核对 PR 状态。
    await target
      .cancelReview?.(event.repository.id, pr.number, eventAt)
      .catch((error) =>
        log("error", "cancel_request_failed", { repositoryId: event.repository.id, prNumber: pr.number }, error),
      );
  // 开发 PR 关闭或合并：任务结束，取消还没处理完的评论修改（正在跑的连同工作区一起结束）。
  if (closed && typeof target !== "function")
    await target
      .closeDevelopmentPullRequest?.(event.repository.id, pr.number)
      .catch((error) =>
        log("error", "development_close_failed", { repositoryId: event.repository.id, prNumber: pr.number }, error),
      );
  if (
    (!actions.has(event.action) && !closed) ||
    (!closed && (pr.draft || pr.state !== "open" || pr.head.repo?.full_name !== event.repository.full_name)) ||
    !config.allowedRepositories.has(repository)
  )
    return send(response, 200, { ignored: true });
  let result;
  try {
    if (
      !closed &&
      typeof target !== "function" &&
      pr.head.repo?.full_name === event.repository.full_name &&
      (await target.isDevelopmentPullRequest?.(event.repository.id, pr.number, pr.head.ref, pr.head.sha))
    )
      return send(response, 200, { ignored: true, reason: "development_pull_request" });
    result = await accept(
      {
        deliveryId,
        installationId: event.installation.id,
        repositoryId: event.repository.id,
        repository: event.repository.full_name,
        cloneUrl: `https://github.com/${event.repository.full_name}.git`,
        prNumber: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
      },
      { event: eventName, action: event.action, merged: pr.merged, mergeCommitSha: pr.merge_commit_sha, eventAt },
    );
  } catch {
    return send(response, 503, { error: "任务持久化失败" });
  }
  if (result.kind === "full") return send(response, 503, { error: "任务队列已满" });
  if (result.kind === "stale") return send(response, 200, { ignored: true, reason: "stale_event" });
  return send(response, 202, {
    accepted: result.kind === "accepted",
    duplicate: result.kind === "duplicate",
    jobId: result.job?.id,
  });
}
