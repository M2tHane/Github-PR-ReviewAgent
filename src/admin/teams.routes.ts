import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import { transaction } from "../persistence/transaction.js";
import { MemoryService } from "../memory/memory.service.js";
import { MemoryRepository } from "../persistence/repositories/memory.repository.js";
import { RuleImportService } from "../memory/import.service.js";
import { RuleImportError, MAX_IMPORT_RULES } from "../memory/import-format.js";
import { parseImportInput } from "./rule-import.routes.js";
import { repository, type Repository, type Session } from "./dto.js";
import { body, json } from "./http.js";
import type { MemoryWithUsage, RuleLevel } from "../memory/types.js";

export interface Team {
  id: string;
  name: string;
  canManage: boolean;
  members: { login: string; role: "admin" | "member" }[];
  repositoryIds: number[];
}
export interface RuleOverride {
  repositoryId: number;
  memoryId: string;
  action: "disable" | "level";
  level: RuleLevel | null;
  reason: string;
  actor: string;
  createdAt: string;
}
export class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}
export function createTeamRoutes(
  config: Config,
  database: Database,
  authorize: (
    request: IncomingMessage,
    response: ServerResponse,
    repositoryId: number,
  ) => Promise<{ user: Session; repository: Repository } | undefined>,
  allowedRepositories: (user: Session) => Promise<Repository[]>,
) {
  const serviceAdmin = (user: Session) => config.serviceAdmins?.has(user.login.toLowerCase()) ?? false;
  const memories = new MemoryService(database);
  const imports = new RuleImportService(database);
  const repositoryMemories = new MemoryRepository(database.pool);
  const manageable = async (user: Session, teamId: string) =>
    serviceAdmin(user) ||
    Boolean(
      (
        await database.pool.query("SELECT 1 FROM team_members WHERE team_id=$1 AND github_login=$2 AND role='admin'", [
          teamId,
          user.login.toLowerCase(),
        ])
      ).rowCount,
    );
  async function requireManager(user: Session, teamId: string) {
    if (!(await manageable(user, teamId))) throw new TeamRequestError("需要团队管理员或服务管理员权限", 403);
  }
  const requireServiceAdmin = (user: Session) => {
    if (!serviceAdmin(user)) throw new TeamRequestError("需要 SERVICE_ADMINS 服务管理员权限", 403);
  };
  async function list(user: Session, repositories: Repository[]): Promise<Team[]> {
    const result = await database.pool.query(
      `SELECT t.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('login',github_login,'role',role) ORDER BY role,github_login) FROM team_members WHERE team_id=t.id),'[]') members,
        COALESCE((SELECT jsonb_agg(repository_id ORDER BY repository_id) FROM team_repositories WHERE team_id=t.id),'[]') repositories
       FROM teams t WHERE $1 OR EXISTS (SELECT 1 FROM team_members WHERE team_id=t.id AND github_login=$2)
         OR EXISTS (SELECT 1 FROM team_repositories WHERE team_id=t.id AND repository_id=ANY($3::bigint[])) ORDER BY t.name,t.id`,
      [serviceAdmin(user), user.login.toLowerCase(), repositories.map((item) => item.id)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      members: row.members,
      repositoryIds: row.repositories.map(Number),
      canManage:
        serviceAdmin(user) ||
        row.members.some(
          (member: Team["members"][number]) => member.login === user.login.toLowerCase() && member.role === "admin",
        ),
    }));
  }
  async function inherited(repositoryId: number): Promise<MemoryWithUsage[]> {
    const result = await database.pool.query(
      "SELECT team_id FROM team_repositories WHERE repository_id=$1 ORDER BY team_id",
      [repositoryId],
    );
    return (
      await Promise.all(result.rows.map((row) => memories.list({ teamId: row.team_id }, undefined, true)))
    ).flat();
  }
  async function visibleMemories(teams: Team[], repositories: Repository[]) {
    const repositoryIds = new Set(repositories.map((repository) => repository.id));
    return (
      await Promise.all(
        teams
          .filter((team) => team.canManage || team.repositoryIds.some((id) => repositoryIds.has(id)))
          .map((team) => memories.list({ teamId: team.id }, undefined, !team.canManage)),
      )
    ).flat();
  }
  async function overrides(repositoryId: number): Promise<RuleOverride[]> {
    const rows = (
      await database.pool.query(
        "SELECT o.* FROM rule_overrides o JOIN team_repositories tr USING(team_id,repository_id) WHERE o.repository_id=$1 ORDER BY o.memory_id",
        [repositoryId],
      )
    ).rows;
    return rows.map((row) => ({
      repositoryId: Number(row.repository_id),
      memoryId: row.memory_id,
      action: row.action,
      level: row.level,
      reason: row.reason,
      actor: row.actor,
      createdAt: row.created_at.toISOString(),
    }));
  }
  async function route(request: IncomingMessage, response: ServerResponse, url: URL, user: Session) {
    if (url.pathname === "/api/teams") {
      if (request.method === "GET") {
        const repos = await allowedRepositories(user);
        const assignable = serviceAdmin(user)
          ? (await database.pool.query("SELECT * FROM repositories WHERE revoked_at IS NULL ORDER BY full_name")).rows
              .filter((row) => config.allowedRepositories.has(String(row.full_name).toLowerCase()))
              .map(repository)
          : repos;
        return json(response, 200, {
          teams: await list(user, repos),
          canManageTeams: serviceAdmin(user),
          repositories: assignable,
        });
      }
      requireServiceAdmin(user);
      if (request.method === "POST") {
        const value = (await body(request)) as any;
        if (typeof value?.name !== "string" || !value.name.trim()) throw new TeamRequestError("请填写团队名称");
        const saved = await database.pool.query(
          "INSERT INTO teams(id,name,created_by) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING RETURNING id",
          [randomUUID(), value.name.trim(), user.id],
        );
        if (!saved.rowCount) throw new TeamRequestError("团队名称已存在", 409);
        return json(response, 201, { id: saved.rows[0].id });
      }
    }
    const teamMatch = url.pathname.match(
      /^\/api\/teams\/([0-9a-f-]{36})(?:\/(repositories|members|memories|rule-import)(?:\/(preview|confirm))?)?$/i,
    );
    if (teamMatch) {
      const teamId = teamMatch[1]!,
        operation = teamMatch[2];
      if (!(await database.pool.query("SELECT 1 FROM teams WHERE id=$1", [teamId])).rowCount)
        throw new TeamRequestError("团队不存在", 404);
      if (!operation) {
        requireServiceAdmin(user);
        if (request.method === "DELETE") {
          await database.pool.query("DELETE FROM teams WHERE id=$1", [teamId]);
          return json(response, 200, { deleted: true });
        }
        if (request.method === "PATCH") {
          const value = (await body(request)) as any;
          if (typeof value?.name !== "string" || !value.name.trim()) throw new TeamRequestError("请填写团队名称");
          try {
            await database.pool.query("UPDATE teams SET name=$2 WHERE id=$1", [teamId, value.name.trim()]);
          } catch (error) {
            if ((error as { code?: string }).code === "23505") throw new TeamRequestError("团队名称已存在", 409);
            throw error;
          }
          return json(response, 200, { id: teamId });
        }
      }
      if (operation === "repositories" && request.method === "PUT") {
        requireServiceAdmin(user);
        const value = (await body(request)) as any;
        if (!Array.isArray(value?.repositoryIds) || !value.repositoryIds.every(Number.isSafeInteger))
          throw new TeamRequestError("请选择仓库");
        const ids: number[] = [...new Set<number>(value.repositoryIds)];
        const available = (
          await database.pool.query("SELECT * FROM repositories WHERE id=ANY($1::bigint[]) AND revoked_at IS NULL", [
            ids,
          ])
        ).rows.filter((row) => config.allowedRepositories.has(String(row.full_name).toLowerCase()));
        if (available.length !== ids.length) throw new TeamRequestError("只能划入已接入且授权的仓库", 403);
        const client = await database.pool.connect();
        try {
          await transaction(client, async () => {
            await client.query("SELECT 1 FROM teams WHERE id=$1 FOR UPDATE", [teamId]);
            await client.query(
              "DELETE FROM team_repositories WHERE team_id=$1 AND NOT (repository_id=ANY($2::bigint[]))",
              [teamId, ids],
            );
            await client.query(
              "INSERT INTO team_repositories(team_id,repository_id) SELECT $1,unnest($2::bigint[]) ON CONFLICT DO NOTHING",
              [teamId, ids],
            );
          });
        } finally {
          client.release();
        }
        return json(response, 200, { repositoryIds: ids });
      }
      await requireManager(user, teamId);
      if (operation === "members" && ["PUT", "DELETE"].includes(request.method!)) {
        const value = (await body(request)) as any;
        if (
          typeof value?.login !== "string" ||
          !value.login.trim() ||
          (request.method === "PUT" && !["admin", "member"].includes(value.role))
        )
          throw new TeamRequestError("请填写 GitHub 用户名并选择 admin 或 member");
        const login = value.login.trim().toLowerCase();
        const client = await database.pool.connect();
        try {
          await transaction(client, async () => {
            await client.query("SELECT 1 FROM teams WHERE id=$1 FOR UPDATE", [teamId]);
            const existing = (
              await client.query("SELECT role FROM team_members WHERE team_id=$1 AND github_login=$2", [teamId, login])
            ).rows[0];
            if (existing?.role === "admin" || value.role === "admin") requireServiceAdmin(user);
            if (request.method === "DELETE")
              await client.query("DELETE FROM team_members WHERE team_id=$1 AND github_login=$2", [teamId, login]);
            else
              await client.query(
                "INSERT INTO team_members(team_id,github_login,role) VALUES($1,$2,$3) ON CONFLICT(team_id,github_login) DO UPDATE SET role=EXCLUDED.role",
                [teamId, login, value.role],
              );
          });
        } finally {
          client.release();
        }
        return json(response, 200, { saved: true });
      }
      if (operation === "memories" && request.method === "GET")
        return json(response, 200, await memories.list({ teamId }));
      if (operation === "rule-import" && request.method === "POST") {
        const value = (await body(request, 2 * 1024 * 1024)) as any;
        if (teamMatch[3] === "preview") {
          const input = parseImportInput(value);
          if (input.kind !== "markdown") throw new TeamRequestError("团队规则请从 Markdown 导入或从项目提升");
          return json(response, 200, await imports.preview({ teamId }, user, input));
        }
        if (teamMatch[3] === "confirm") {
          if (
            typeof value?.previewId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(value.previewId) ||
            !Array.isArray(value.keys) ||
            !value.keys.length ||
            value.keys.length > MAX_IMPORT_RULES ||
            value.keys.some((key: unknown) => typeof key !== "string") ||
            new Set(value.keys).size !== value.keys.length
          )
            throw new RuleImportError("请选择本次预览中的规则");
          return json(response, 200, await imports.confirm({ teamId }, user, value.previewId, value.keys));
        }
      }
    }
    const repoMatch = url.pathname.match(
      /^\/api\/repositories\/(\d+)\/(team-rules|rule-overrides|promotions)(?:\/([0-9a-f-]{36}))?$/i,
    );
    if (repoMatch) {
      const repositoryId = Number(repoMatch[1]),
        operation = repoMatch[2],
        memoryId = repoMatch[3];
      const access = await authorize(request, response, repositoryId);
      if (!access) return;
      if (operation === "team-rules" && request.method === "GET")
        return json(response, 200, {
          memories: await inherited(repositoryId),
          overrides: await overrides(repositoryId),
        });
      if (operation === "promotions" && memoryId && request.method === "POST") {
        const value = (await body(request)) as any;
        if (typeof value?.teamId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.teamId))
          throw new TeamRequestError("请选择所属团队");
        return json(response, 200, await repositoryMemories.promote(repositoryId, memoryId, value.teamId, user));
      }
      if (operation === "rule-overrides" && memoryId) {
        if (request.method === "DELETE") {
          const value = (await body(request)) as any;
          if (typeof value?.reason !== "string" || !value.reason.trim())
            throw new TeamRequestError("取消项目覆盖也必须填写理由");
          // 删除覆盖与保存取消理由同一条语句完成，理由不会随覆盖记录一起消失。
          await database.pool.query(
            `WITH removed AS (DELETE FROM rule_overrides WHERE repository_id=$1 AND memory_id=$2 RETURNING *)
             INSERT INTO memory_audits(id,memory_id,memory_version,actor_id,actor_login,action,before_value,after_value)
             SELECT $3,memory_id,(SELECT max(version) FROM memories WHERE id=removed.memory_id),$4,$5,'override-remove',
               to_jsonb(removed),jsonb_build_object('repositoryId',$1::bigint,'reason',$6::text)
             FROM removed`,
            [repositoryId, memoryId, randomUUID(), user.id, user.login, value.reason.trim()],
          );
          return json(response, 200, { deleted: true });
        }
        if (request.method === "PUT") {
          const value = (await body(request)) as any;
          if (
            !value ||
            !["disable", "level"].includes(value.action) ||
            (value.action === "level" && !["must", "should", "info"].includes(value.level)) ||
            typeof value.reason !== "string" ||
            !value.reason.trim()
          )
            throw new TeamRequestError("请选择停用或规则级别，并填写覆盖理由");
          const result = await database.pool.query(
            `INSERT INTO rule_overrides(repository_id,memory_id,team_id,action,level,reason,actor)
             SELECT $1,m.id,m.team_id,$3,$4,$5,$6 FROM memories m JOIN team_repositories tr ON tr.team_id=m.team_id AND tr.repository_id=$1 WHERE m.id=$2 LIMIT 1
             ON CONFLICT(repository_id,memory_id) DO UPDATE SET action=EXCLUDED.action,level=EXCLUDED.level,reason=EXCLUDED.reason,actor=EXCLUDED.actor,created_at=now() RETURNING memory_id`,
            [
              repositoryId,
              memoryId,
              value.action,
              value.action === "level" ? value.level : null,
              value.reason.trim(),
              user.login,
            ],
          );
          if (!result.rowCount) throw new TeamRequestError("只能覆盖本仓库所属团队的规则");
          return json(response, 200, await overrides(repositoryId));
        }
      }
    }
    return json(response, 405, { error: "不支持的操作" });
  }
  return { route, list, visibleMemories, requireManager, manageable, inherited };
}
