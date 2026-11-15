import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { Config } from "../config/config.js";
import type { RepositoryAccess } from "../config/repository-access.js";
import type { GitHubClient } from "../github/client.js";
import type { Session } from "./dto.js";
import { body, json } from "./http.js";

export type OnboardingRepository = {
  id: number;
  fullName: string;
  allowed: boolean;
  source: "config" | "admin" | null;
  revokedAt: string | null;
  managedAllowed: boolean;
  allowedBy: string | null;
  allowedAt: string | null;
};

export function createRepositoryOnboardingRoute(
  config: Config,
  pool: Pool,
  github: GitHubClient,
  access: RepositoryAccess,
) {
  const view = (row: any): OnboardingRepository => {
    const configured = access.configured.has(String(row.full_name).toLowerCase());
    return {
      id: Number(row.id),
      fullName: String(row.full_name).toLowerCase(),
      allowed: !row.revoked_at && (configured || row.allowed),
      source: configured ? "config" : row.allowed ? "admin" : null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      managedAllowed: row.allowed,
      allowedBy: row.allowed_by,
      allowedAt: row.allowed_at?.toISOString() ?? null,
    };
  };
  return async (request: IncomingMessage, response: ServerResponse, user: Session, id?: number) => {
    if (!config.serviceAdmins?.has(user.login.toLowerCase()))
      return json(response, 403, { error: "只有 SERVICE_ADMINS 里的用户可以管理仓库接入" });
    if (request.method === "GET" && id === undefined) {
      // 首次接入的仓库可能没有发过 PR 事件，需从 App 安装清单发现；保留本地撤销标记与操作记录。
      const installed = await github.listInstalledRepositories();
      if (installed.length)
        await pool.query(
          `INSERT INTO repositories(id,installation_id,full_name)
         SELECT id,installation_id,lower(full_name) FROM jsonb_to_recordset($1::jsonb) AS r(id bigint,installation_id bigint,full_name text)
         ON CONFLICT(id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,updated_at=now()`,
          [JSON.stringify(installed)],
        );
      return json(
        response,
        200,
        (await pool.query("SELECT * FROM repositories ORDER BY lower(full_name),id")).rows.map(view),
      );
    }
    if (request.method !== "PUT" || id === undefined) return json(response, 405, { error: "不支持的操作" });
    const value = (await body(request)) as { allowed?: unknown } | null;
    if (typeof value?.allowed !== "boolean") return json(response, 422, { error: "接入状态必须是开或关" });
    const row = (await pool.query("SELECT * FROM repositories WHERE id=$1", [id])).rows[0];
    if (!row) return json(response, 404, { error: "仓库不存在" });
    if (row.revoked_at && value.allowed) return json(response, 409, { error: "已撤销 GitHub 授权的仓库不能接入" });
    if (access.configured.has(String(row.full_name).toLowerCase())) {
      if (!value.allowed) return json(response, 409, { error: "由配置文件接入的仓库不能在管理页移出" });
      return json(response, 200, view(row));
    }
    // 条件写入防止与 GitHub 撤销事件并发时重新接入。
    const result = await pool.query(
      `UPDATE repositories SET allowed=$2,allowed_by=$3,allowed_at=now(),updated_at=now()
       WHERE id=$1 AND (NOT $2::boolean OR revoked_at IS NULL) RETURNING *`,
      [id, value.allowed, user.login],
    );
    if (!result.rowCount) return json(response, 409, { error: "已撤销 GitHub 授权的仓库不能接入" });
    await access.refreshAfterUpdate();
    return json(response, 200, view(result.rows[0]));
  };
}
