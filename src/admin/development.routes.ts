import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import type { GitHubClient } from "../github/client.js";
import { DevelopmentStore } from "../development/store.js";
import { parseSettings } from "../development/policy.js";
import { DevelopmentError } from "../development/types.js";
import type { Repository, Session } from "./dto.js";
import { body, json } from "./http.js";

export function createDevelopmentRoute(
  config: Config,
  database: Database,
  github: GitHubClient,
  authorize: (
    request: IncomingMessage,
    response: ServerResponse,
    repositoryId: number,
  ) => Promise<{ user: Session; repository: Repository } | undefined>,
) {
  const store = new DevelopmentStore(database.pool);
  return async (request: IncomingMessage, response: ServerResponse, repositoryId: number) => {
    const access = await authorize(request, response, repositoryId);
    if (!access) return;
    if (!config.allowedRepositories.has(access.repository.fullName.toLowerCase()))
      return json(response, 403, { error: "仓库未授权" });
    if (request.method === "GET")
      return json(response, 200, {
        settings: await store.settings(repositoryId),
        configured: Boolean(config.development),
        tasks: await store.list(repositoryId),
      });
    if (request.method !== "PUT") return json(response, 405, { error: "不支持的操作" });
    let value: ReturnType<typeof parseSettings>;
    try {
      value = parseSettings(await body(request));
    } catch (error) {
      return json(response, 422, { error: error instanceof Error ? error.message : "设置无效" });
    }
    if (value.enabled) {
      if (!config.development) return json(response, 422, { error: "请先配置智能机器人 Bot ID 和 Secret" });
      try {
        const signal = AbortSignal.timeout(30_000);
        const token = await github.installationToken(access.repository.installationId, signal);
        await github.developmentSnapshot(token, access.repository.fullName, repositoryId, value.targetBranch, signal);
      } catch {
        return json(response, 422, { error: "无法读取目标分支，请检查分支名称及 GitHub App 仓库权限" });
      }
    }
    try {
      return json(response, 200, { settings: await store.saveSettings(repositoryId, value, access.user.login) });
    } catch (error) {
      if (error instanceof DevelopmentError) return json(response, 409, { error: error.message });
      throw error;
    }
  };
}
