import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import { GitHubClient } from "../github/client.js";
import { MemoryService, type CandidatePatch } from "../memory/memory.service.js";
import { HealthRequestError } from "../health/health.scheduler.js";
import { repository, type Repository, type Session } from "./dto.js";
import { json, cookies, body } from "./http.js";
import { DatabaseSessionStore, type SessionStore } from "./session-store.js";
import { createRepositoryService, JOB_STATUSES, JOB_TYPES, MAX_PAGE_SIZE } from "./repository.service.js";
import { createHealthRoutes, isHealthRoute } from "./health.routes.js";
import { createFindingsRoute } from "./findings.routes.js";
import { createNotificationMembersRoute } from "./notification-members.routes.js";

import { createRuleImportRoute } from "./rule-import.routes.js";
import { createDevelopmentRoute } from "./development.routes.js";
import { createAgentSessionsRoute } from "./agent-sessions.routes.js";
import { createServiceSettingsRoute } from "./service-settings.routes.js";
import { ServiceSettings } from "../config/service-settings.js";
import { SESSION_SUMMARY } from "../persistence/repositories/agent-session.repository.js";

export interface AdminStores {
  sessions: SessionStore<Session>;
  states: SessionStore<number>;
}

export function createAdminHandler(
  config: Config,
  database: Database,
  github = new GitHubClient(config.appId, config.privateKey),
  // 会话存在数据库里，多个实例共用登录状态。
  { sessions, states }: AdminStores = {
    sessions: new DatabaseSessionStore(database.pool, "session", 8 * 60 * 60_000, 1000, config.sessionSecret ?? ""),
    states: new DatabaseSessionStore(database.pool, "oauth_state", 10 * 60_000, 1000, config.sessionSecret ?? ""),
  },
  // 服务里共用一个实例，改完立即应用到本实例；单独使用管理页（测试）时自己建一个。
  settings = new ServiceSettings(config, database.pool),
) {
  const memories = new MemoryService(database);
  const { allowedRepositories, listJobs, overview } = createRepositoryService(database, github);
  const healthRoutes = createHealthRoutes(config, database, github, authorize, allowedRepositories);
  const ruleImportRoute = createRuleImportRoute(database, authorize);
  const developmentRoute = createDevelopmentRoute(config, database, github, authorize);
  const notificationMembersRoute = createNotificationMembersRoute(config, database, authorize);
  const agentSessionsRoute = createAgentSessionsRoute(config, database, authorize);
  const serviceSettingsRoute = createServiceSettingsRoute(config, settings, allowedRepositories);
  const configured = Boolean(
    config.githubClientId &&
      config.githubClientSecret &&
      config.githubOAuthCallbackUrl &&
      config.sessionSecret &&
      config.sessionSecret.length >= 32,
  );
  const secure = config.githubOAuthCallbackUrl?.startsWith("https://") ?? false;
  const sign = (id: string) =>
    createHmac("sha256", config.sessionSecret ?? "")
      .update(id)
      .digest("base64url");
  const findingsRoute = createFindingsRoute(database, sign, allowedRepositories);
  const cookie = (name: string, value: string, maxAge = 3600) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  async function session(request: IncomingMessage) {
    const [id, signature] = (cookies(request).session ?? "").split(".");
    if (!id || !signature) return undefined;
    const expected = Buffer.from(sign(id));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    const value = await sessions.get(id);
    if (!value || value.expiresAt <= Date.now()) {
      await sessions.delete(id);
      return undefined;
    }
    return value;
  }

  async function authorize(request: IncomingMessage, response: ServerResponse, repositoryId: number) {
    const user = await session(request);
    if (!user) {
      json(response, 401, { error: "请先登录" });
      return undefined;
    }
    const result = await database.pool.query("SELECT * FROM repositories WHERE id=$1", [repositoryId]);
    if (!result.rows[0]) {
      json(response, 404, { error: "仓库不存在" });
      return undefined;
    }
    if (!(await github.hasMaintainerPermission(user.token, String(result.rows[0].full_name)))) {
      json(response, 403, { error: "需要 repository maintain 或 admin 权限" });
      return undefined;
    }
    return { user, repository: repository(result.rows[0]) };
  }

  function requireCsrf(request: IncomingMessage, response: ServerResponse, user: Session) {
    let callbackOrigin: string;
    try {
      callbackOrigin = new URL(config.githubOAuthCallbackUrl!).origin;
    } catch {
      json(response, 503, { error: "OAuth 未配置" });
      return false;
    }
    if (request.headers.origin !== callbackOrigin || request.headers["x-csrf-token"] !== user.csrf) {
      json(response, 403, { error: "CSRF 校验失败" });
      return false;
    }
    return true;
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://local");
    try {
      if (request.method === "GET" && url.pathname === "/auth/github") {
        if (!configured) return json(response, 503, { error: "OAuth 未配置" });
        const state = randomBytes(32).toString("base64url");
        if (!(await states.set(state, Date.now() + 10 * 60_000)))
          return json(response, 503, { error: "登录请求过多，请稍后重试" });
        response
          .writeHead(302, {
            location: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.githubClientId!)}&redirect_uri=${encodeURIComponent(config.githubOAuthCallbackUrl!)}&state=${state}`,
            "set-cookie": cookie("oauth_state", state, 600),
          })
          .end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const expiresAt = state ? await states.get(state) : undefined;
        if (
          !configured ||
          !code ||
          !state ||
          cookies(request).oauth_state !== state ||
          !expiresAt ||
          expiresAt <= Date.now()
        )
          return json(response, 400, { error: "OAuth state 无效" });
        await states.delete(state);
        const token = await github.exchangeOAuthCode(config.githubClientId!, config.githubClientSecret!, code);
        const actor = await github.getUser(token);
        const id = randomBytes(32).toString("base64url");
        if (
          !(await sessions.set(id, {
            ...actor,
            token,
            csrf: randomBytes(24).toString("base64url"),
            expiresAt: Date.now() + 8 * 60 * 60_000,
          }))
        )
          return json(response, 503, { error: "登录会话已满，请稍后重试" });
        response
          .writeHead(302, {
            location: "/",
            "set-cookie": [cookie("session", `${id}.${sign(id)}`, 8 * 60 * 60), cookie("oauth_state", "", 0)],
          })
          .end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const user = await session(request);
        if (user && requireCsrf(request, response, user))
          await sessions.delete((cookies(request).session ?? "").split(".")[0]!);
        if (!response.headersSent) response.writeHead(204, { "set-cookie": cookie("session", "", 0) }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const user = await session(request);
        return user
          ? json(response, 200, { user: { id: user.id, login: user.login }, csrf: user.csrf })
          : json(response, 401, { error: "请先登录" });
      }
      if (url.pathname.startsWith("/api/")) {
        const user = await session(request);
        if (!user) return json(response, 401, { error: "请先登录" });
        if (request.method !== "GET" && !requireCsrf(request, response, user)) return;
        const importMatch = url.pathname.match(/^\/api\/repositories\/(\d+)\/rule-import\/(source|preview|confirm)$/);
        if (importMatch) return await ruleImportRoute(request, response, Number(importMatch[1]), importMatch[2]!);
        const developmentMatch = url.pathname.match(/^\/api\/repositories\/(\d+)\/development$/);
        if (developmentMatch) return await developmentRoute(request, response, Number(developmentMatch[1]));
        const sessionMatch = url.pathname.match(/^\/api\/agent-sessions\/([^/]+?)(\/raw)?$/);
        if (sessionMatch)
          return await agentSessionsRoute(request, response, sessionMatch[1]!, Boolean(sessionMatch[2]));
        const membersMatch = url.pathname.match(/^\/api\/repositories\/(\d+)\/notification-members(?:\/([^/]+))?$/);
        if (membersMatch) return notificationMembersRoute(request, response, Number(membersMatch[1]), membersMatch[2]);
        if (url.pathname === "/api/service-settings") return await serviceSettingsRoute(request, response, user);
        if (request.method === "GET" && url.pathname === "/api/bootstrap") {
          const repositories = await allowedRepositories(user);
          const memoryLists = await Promise.all(repositories.map((item) => memories.list(item.id)));
          return json(response, 200, { repositories, memories: memoryLists.flat() });
        }
        if (request.method === "GET" && url.pathname === "/api/overview") {
          const repositories = await allowedRepositories(user);
          return json(response, 200, await overview(repositories.map((item) => item.id)));
        }
        if (request.method === "GET" && url.pathname === "/api/repositories")
          return json(response, 200, await allowedRepositories(user));
        if (isHealthRoute(request, url)) return healthRoutes(request, response, url, user);
        const repositoryMatch = url.pathname.match(/^\/api\/repositories\/(\d+)$/);
        if (repositoryMatch && request.method === "PATCH") {
          const access = await authorize(request, response, Number(repositoryMatch[1]));
          if (!access) return;
          const value = (await body(request)) as Partial<
            Pick<Repository, "enabled" | "includePaths" | "excludePaths" | "outputLanguage" | "budgetTokens">
          >;
          if (
            (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
            (value.includePaths !== undefined &&
              (!Array.isArray(value.includePaths) || !value.includePaths.every((x) => typeof x === "string"))) ||
            (value.excludePaths !== undefined &&
              (!Array.isArray(value.excludePaths) || !value.excludePaths.every((x) => typeof x === "string"))) ||
            (value.outputLanguage !== undefined && typeof value.outputLanguage !== "string") ||
            (value.budgetTokens !== undefined &&
              (!Number.isSafeInteger(value.budgetTokens) || value.budgetTokens! <= 0))
          )
            return json(response, 422, { error: "仓库配置无效" });
          const updated = await database.pool.query(
            "UPDATE repositories SET enabled=COALESCE($2,enabled),include_paths=COALESCE($3,include_paths),exclude_paths=COALESCE($4,exclude_paths),output_language=COALESCE($5,output_language),budget_tokens=COALESCE($6,budget_tokens),updated_at=now() WHERE id=$1 RETURNING *",
            [
              access.repository.id,
              value.enabled ?? null,
              value.includePaths ?? null,
              value.excludePaths ?? null,
              value.outputLanguage ?? null,
              value.budgetTokens ?? null,
            ],
          );
          if (value.enabled === false) await database.cancelRepository(access.repository.id);
          return json(response, 200, repository(updated.rows[0]));
        }
        if (request.method === "GET" && url.pathname === "/api/jobs") {
          const query = url.searchParams;
          const type = query.get("type") ?? undefined,
            repositoryId = query.get("repositoryId"),
            statuses = query.get("status")?.split(",") ?? [],
            page = Number(query.get("page") ?? 1),
            pageSize = Number(query.get("pageSize") ?? 20);
          if (
            (type !== undefined && !JOB_TYPES.includes(type)) ||
            (repositoryId !== null && !/^\d{1,15}$/.test(repositoryId)) ||
            statuses.some((status) => !JOB_STATUSES.includes(status)) ||
            !Number.isSafeInteger(page) ||
            page < 1 ||
            page > 100_000 ||
            !Number.isSafeInteger(pageSize) ||
            pageSize < 1 ||
            pageSize > MAX_PAGE_SIZE
          )
            return json(response, 422, { error: "任务筛选或分页参数无效" });
          const repositories = await allowedRepositories(user);
          return json(
            response,
            200,
            await listJobs(
              repositories.map((item) => item.id),
              {
                type,
                repositoryId: repositoryId === null ? undefined : Number(repositoryId),
                statuses,
                page,
                pageSize,
              },
            ),
          );
        }
        const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
        if (jobMatch && request.method === "GET") {
          const result = await database.pool.query(
            "SELECT j.*,p.github_review_url FROM jobs j LEFT JOIN review_publications p ON p.job_id=j.id WHERE j.id=$1",
            [jobMatch[1]],
          );
          if (!result.rows[0]) return json(response, 404, { error: "Job 不存在" });
          if (!(await authorize(request, response, Number(result.rows[0].repository_id)))) return;
          const runs = await database.pool.query("SELECT * FROM agent_runs WHERE job_id=$1 ORDER BY started_at", [
            jobMatch[1],
          ]);
          const statuses = await database.pool.query(
            "SELECT id,status FROM review_findings WHERE job_id=$1 ORDER BY id",
            [jobMatch[1]],
          );
          const agentSessions = await database.pool.query(
            `SELECT ${SESSION_SUMMARY("s")} summary FROM agent_sessions s WHERE s.job_id=$1 ORDER BY s.started_at`,
            [jobMatch[1]],
          );
          return json(response, 200, {
            ...result.rows[0],
            agent_runs: runs.rows,
            agent_sessions: agentSessions.rows.map((row) => row.summary),
            finding_statuses: statuses.rows,
          });
        }
        if (request.method === "GET" && url.pathname === "/api/findings")
          return findingsRoute(request, response, url, user);
        if (request.method === "GET" && url.pathname === "/api/memories") {
          const repositories = await allowedRepositories(user);
          const status = url.searchParams.get("status") ?? undefined;
          const values = (await Promise.all(repositories.map((item) => memories.list(item.id, status as any)))).flat();
          return json(response, 200, values);
        }
        const memoryMatch = url.pathname.match(
          /^\/api\/memories\/([0-9a-f-]+)(?:\/(approve|reject|deprecate|supersede))?$/i,
        );
        if (memoryMatch) {
          const result = await database.pool.query(
            "SELECT repository_id FROM memories WHERE id=$1 ORDER BY version DESC LIMIT 1",
            [memoryMatch[1]],
          );
          if (!result.rows[0]) return json(response, 404, { error: "Memory 不存在" });
          const access = await authorize(request, response, Number(result.rows[0].repository_id));
          if (!access) return;
          if (request.method === "GET" && !memoryMatch[2]) {
            const current = await memories.get(access.repository.id, memoryMatch[1]!);
            const versions = await database.pool.query(
              "SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY version DESC",
              [access.repository.id, memoryMatch[1]],
            );
            return json(response, 200, { ...current, versions: versions.rows });
          }
          if (request.method === "PATCH" && !memoryMatch[2]) {
            const value = (await body(request)) as CandidatePatch;
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).some(
                (key) => !["type", "title", "content", "rationale", "scope", "uncertainties"].includes(key),
              )
            )
              return json(response, 422, { error: "只允许编辑规则内容与适用范围" });
            const types = new Set([
              "architecture_decision",
              "engineering_rule",
              "security_rule",
              "coding_convention",
              "exception",
              "deprecated_pattern",
            ]);
            if (
              (value.type !== undefined && !types.has(value.type)) ||
              (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim())) ||
              (value.content !== undefined && (typeof value.content !== "string" || !value.content.trim())) ||
              (value.rationale !== undefined && (typeof value.rationale !== "string" || !value.rationale.trim())) ||
              (value.uncertainties !== undefined &&
                (!Array.isArray(value.uncertainties) || !value.uncertainties.every((x) => typeof x === "string"))) ||
              (value.scope !== undefined &&
                (!value.scope ||
                  typeof value.scope !== "object" ||
                  Array.isArray(value.scope) ||
                  Object.keys(value.scope).some(
                    (key) => !["paths", "languages", "modules", "conditions"].includes(key),
                  ) ||
                  !Object.values(value.scope).every(
                    (x) => x === undefined || (Array.isArray(x) && x.every((item) => typeof item === "string")),
                  )))
            )
              return json(response, 422, { error: "Memory 修改无效" });
            return json(response, 200, await memories.edit(access.repository.id, memoryMatch[1]!, value, user));
          }
          if (request.method === "POST" && memoryMatch[2] === "supersede")
            return json(
              response,
              200,
              await memories.supersede(
                access.repository.id,
                memoryMatch[1]!,
                String(((await body(request)) as { candidateId?: string }).candidateId ?? ""),
                user,
              ),
            );
          if (request.method === "POST" && memoryMatch[2])
            return json(
              response,
              200,
              await memories.transition(
                access.repository.id,
                memoryMatch[1]!,
                memoryMatch[2] as "approve" | "reject" | "deprecate",
                user,
              ),
            );
        }
        return json(response, 404, { error: "not found" });
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
        const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const content = await readFile(resolve("dist/admin", path));
        const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
        response.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(content);
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HealthRequestError) return json(response, error.status, { error: error.message });
      if (error instanceof SyntaxError) return json(response, 400, { error: "JSON 无效" });
      json(response, 500, { error: error instanceof Error ? error.message : "请求失败" });
    }
  };
}
