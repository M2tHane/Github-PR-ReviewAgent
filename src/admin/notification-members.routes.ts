import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import { NotificationMemberRepository } from "../persistence/repositories/notification-member.repository.js";
import { githubLoginPattern, parseNotificationMember } from "../notifications/members.js";
import type { Repository, Session } from "./dto.js";
import { body, json } from "./http.js";

export function createNotificationMembersRoute(
  config: Config,
  database: Database,
  authorize: (
    request: IncomingMessage,
    response: ServerResponse,
    repositoryId: number,
  ) => Promise<{ user: Session; repository: Repository } | undefined>,
) {
  const members = new NotificationMemberRepository(database.pool);
  // 调用方已统一验证登录和所有写请求的 CSRF；这里每次重查仓库维护权限。
  return async (request: IncomingMessage, response: ServerResponse, repositoryId: number, login?: string) => {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return json(response, 422, { error: "仓库标识无效" });
    const access = await authorize(request, response, repositoryId);
    if (!access) return;
    if (!config.allowedRepositories.has(access.repository.fullName.toLowerCase()))
      return json(response, 403, { error: "仓库未授权" });
    if (request.method === "GET" && !login)
      return json(response, 200, { members: await members.list(repositoryId), configured: Boolean(config.wecom) });
    if (request.method === "PUT" && !login) {
      const member = parseNotificationMember(await body(request));
      if (!member) return json(response, 422, { error: "请填写有效的 GitHub 登录名和企业微信成员 ID，不允许 @all" });
      await members.save(repositoryId, member);
      return json(response, 200, member);
    }
    if (request.method === "DELETE" && login) {
      if (!githubLoginPattern.test(login)) return json(response, 422, { error: "GitHub 登录名无效" });
      await members.remove(repositoryId, login.toLowerCase());
      return json(response, 200, { removed: true });
    }
    return json(response, 405, { error: "不支持的操作" });
  };
}
