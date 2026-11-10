import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { PullRequestCommentInput } from "../../../development/types.js";
import { send } from "../http.js";

// 有仓库权限的人：仓库所有者、组织成员、协作者。GitHub 在评论里直接给出评论人和仓库的关系。
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// 开发 PR 下的评论交给开发任务队列。返回 undefined 表示这条评论不归开发任务管（不是开发 PR、不是人发的等），
// 调用方按原来的方式处理。
export async function acceptPullRequestComment(
  config: Config,
  target: JobAcceptor,
  input: PullRequestCommentInput & { association: unknown; open: boolean; authorType: unknown },
  response: ServerResponse,
) {
  if (typeof target.acceptPullRequestComment !== "function") return undefined;
  if (!input.open || input.authorType !== "User" || !TRUSTED.has(String(input.association)) || !input.body.trim())
    return undefined;
  const { association: _association, open: _open, authorType: _authorType, ...comment } = input;
  let result;
  try {
    result = await target.acceptPullRequestComment(comment, config);
  } catch {
    send(response, 503, { error: "任务持久化失败" });
    return true;
  }
  if (result.kind === "ignored") return undefined;
  send(response, 202, {
    accepted: result.kind === "accepted",
    duplicate: result.kind === "duplicate",
    task: result.taskKind,
  });
  return true;
}
