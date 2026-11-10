import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/config.js";
import { SETTINGS, ServiceSettings, SettingsValidationError, type SettingValue } from "../config/service-settings.js";
import type { Repository, Session } from "./dto.js";
import { body, json } from "./http.js";

// 服务设置对所有仓库生效：.env 的 SERVICE_ADMINS 里的人可以改；至少管理一个仓库的人可以查看。
export function createServiceSettingsRoute(
  config: Config,
  settings: ServiceSettings,
  allowedRepositories: (user: Session) => Promise<Repository[]>,
) {
  const isAdmin = (user: Session) => config.serviceAdmins?.has(user.login.toLowerCase()) ?? false;
  const definitions = SETTINGS.map(({ read: _read, write: _write, ...definition }) => definition);
  const view = async (user: Session) => ({
    canEdit: isAdmin(user),
    adminsConfigured: Boolean(config.serviceAdmins?.size),
    developmentConfigured: Boolean(config.development),
    definitions,
    ...(await settings.list()),
  });
  return async (request: IncomingMessage, response: ServerResponse, user: Session) => {
    if (request.method === "GET") {
      if (!isAdmin(user) && !(await allowedRepositories(user)).length)
        return json(response, 403, { error: "需要至少一个仓库的 maintain 或 admin 权限" });
      return json(response, 200, await view(user));
    }
    if (request.method !== "PUT") return json(response, 405, { error: "不支持的操作" });
    if (!isAdmin(user)) return json(response, 403, { error: "只有 SERVICE_ADMINS 里的用户可以修改服务设置" });
    const value = (await body(request)) as { values?: unknown; reset?: unknown };
    const values = value?.values ?? {};
    const reset = value?.reset ?? [];
    if (
      typeof values !== "object" ||
      values === null ||
      Array.isArray(values) ||
      !Array.isArray(reset) ||
      !reset.every((key) => typeof key === "string")
    )
      return json(response, 422, { error: "设置格式无效" });
    const changes: Record<string, SettingValue | undefined> = { ...(values as Record<string, SettingValue>) };
    for (const key of reset as string[]) changes[key] = undefined;
    try {
      await settings.update(changes, user.login);
    } catch (error) {
      if (error instanceof SettingsValidationError) return json(response, 422, { error: error.message });
      throw error;
    }
    return json(response, 200, await view(user));
  };
}
