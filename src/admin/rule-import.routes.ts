import { log } from "../logging.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "../persistence/database.js";
import type { Repository, Session } from "./dto.js";
import { body, json } from "./http.js";
import { RuleImportService } from "../memory/import.service.js";
import { MAX_IMPORT_RULES, RuleImportError, validateImportPaths, type ImportInput } from "../memory/import-format.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseImportInput(value: any): ImportInput {
  if (value?.kind === "markdown") {
    if (
      typeof value.markdown !== "string" ||
      typeof value.documentName !== "string" ||
      !/^[^/\\\x00-\x1f]{1,200}\.md$/i.test(value.documentName)
    )
      throw new RuleImportError("请选择 .md 文件，文件名最多 203 字符");
    return { kind: "markdown", markdown: value.markdown, documentName: value.documentName };
  }
  if (
    value?.kind !== "project" ||
    !Number.isSafeInteger(value.sourceRepositoryId) ||
    value.sourceRepositoryId < 1 ||
    !Array.isArray(value.rules) ||
    !value.rules.length ||
    value.rules.length > MAX_IMPORT_RULES
  )
    throw new RuleImportError("请选择来源项目及 1–100 条规则");
  const ids = new Set();
  return {
    kind: "project",
    sourceRepositoryId: value.sourceRepositoryId,
    rules: value.rules.map((rule: any) => {
      if (typeof rule?.id !== "string" || !uuid.test(rule.id) || ids.has(rule.id))
        throw new RuleImportError("规则编号无效或重复");
      ids.add(rule.id);
      return { id: rule.id, paths: validateImportPaths(rule.paths) };
    }),
  };
}

export function createRuleImportRoute(
  database: Database,
  authorize: (
    request: IncomingMessage,
    response: ServerResponse,
    repositoryId: number,
  ) => Promise<{ user: Session; repository: Repository } | undefined>,
) {
  const service = new RuleImportService(database);
  return async (request: IncomingMessage, response: ServerResponse, repositoryId: number, operation: string) => {
    const access = await authorize(request, response, repositoryId);
    if (!access) return;
    try {
      if (operation === "source" && request.method === "GET")
        return json(response, 200, await service.active(repositoryId));
      if (request.method !== "POST") return json(response, 405, { error: "不支持的操作" });
      let value: any;
      try {
        value = await body(request, 2 * 1024 * 1024);
      } catch {
        return json(response, 422, { error: "请求必须为有效 JSON，且不得超过 2 MiB" });
      }
      if (operation === "preview") {
        const input = parseImportInput(value);
        let source: Repository | undefined;
        if (input.kind === "project") {
          if (input.sourceRepositoryId === repositoryId) throw new RuleImportError("请选择另一个来源项目");
          const sourceAccess = await authorize(request, response, input.sourceRepositoryId);
          if (!sourceAccess) return;
          source = sourceAccess.repository;
        }
        return json(response, 200, await service.preview(access.repository, access.user, input, source));
      }
      if (operation === "confirm") {
        if (
          typeof value?.previewId !== "string" ||
          !uuid.test(value.previewId) ||
          !Array.isArray(value.keys) ||
          !value.keys.length ||
          value.keys.length > MAX_IMPORT_RULES ||
          value.keys.some((key: unknown) => typeof key !== "string") ||
          new Set(value.keys).size !== value.keys.length
        )
          throw new RuleImportError("请选择本次预览中的规则");
        const sourceId = await service.previewSource(repositoryId, access.user.id, value.previewId);
        if (sourceId && !(await authorize(request, response, sourceId))) return;
        return json(response, 200, await service.confirm(access.repository, access.user, value.previewId, value.keys));
      }
      return json(response, 404, { error: "导入操作不存在" });
    } catch (error) {
      if (error instanceof RuleImportError) return json(response, 422, { error: error.message });
      log("error", "rule_import_failed", { repositoryId, operation }, error);
      return json(response, 500, { error: "规则导入失败，请稍后重试；未完成的批次不会部分生效" });
    }
  };
}
