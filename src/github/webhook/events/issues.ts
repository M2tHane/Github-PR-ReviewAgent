import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { GitHubApiError, type GitHubClient } from "../../client.js";
import { send } from "../http.js";

export const DEVELOPMENT_LABEL = "pi-dev";

export async function handleIssues(
  config: Config,
  target: JobAcceptor | ((job: ReviewJob) => Promise<void>),
  github: Pick<GitHubClient, "installationToken" | "hasWritePermission">,
  deliveryId: string,
  payload: unknown,
  response: ServerResponse,
) {
  if (typeof target === "function" || !target.acceptIssueLabel) return send(response, 200, { ignored: true });
  const raw = payload as any;
  if (
    raw?.action !== "labeled" ||
    raw?.label?.name !== DEVELOPMENT_LABEL ||
    raw?.sender?.type !== "User" ||
    raw?.issue?.pull_request
  )
    return send(response, 200, { ignored: true });
  if (
    !Number.isSafeInteger(raw?.installation?.id) ||
    !Number.isSafeInteger(raw?.repository?.id) ||
    typeof raw?.repository?.full_name !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(raw.repository.full_name) ||
    !Number.isSafeInteger(raw?.issue?.number) ||
    typeof raw?.issue?.title !== "string" ||
    !(raw?.issue?.body === null || typeof raw?.issue?.body === "string") ||
    typeof raw?.sender?.login !== "string"
  )
    return send(response, 422, { error: "缺少 issues labeled 必需字段" });
  if (!config.allowedRepositories.has(raw.repository.full_name.toLowerCase()))
    return send(response, 200, { ignored: true });
  try {
    const signal = AbortSignal.timeout(30_000);
    const token = await github.installationToken(raw.installation.id, signal);
    if (!(await github.hasWritePermission(token, raw.repository.full_name, raw.sender.login, signal)))
      return send(response, 200, { ignored: true });
    const result = await target.acceptIssueLabel(
      {
        repositoryId: raw.repository.id,
        installationId: raw.installation.id,
        repository: raw.repository.full_name,
        issueNumber: raw.issue.number,
        login: raw.sender.login,
        title: raw.issue.title,
        body: raw.issue.body ?? "",
        deliveryId,
      },
      config,
    );
    return result.kind === "ignored"
      ? send(response, 200, { ignored: true })
      : send(response, 202, {
          accepted: result.kind === "accepted",
          duplicate: result.kind === "duplicate",
          taskId: result.taskId,
        });
  } catch (error) {
    // GitHub 在账号无权访问仓库或已移除安装时返回 404；其他故障交给 Webhook 重投。
    if (error instanceof GitHubApiError && error.status === 404) return send(response, 200, { ignored: true });
    return send(response, 503, { error: "开发任务权限检查或持久化失败" });
  }
}
