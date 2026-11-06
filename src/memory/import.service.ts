import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "../persistence/database.js";
import { transaction } from "../persistence/transaction.js";
import type { Repository } from "../admin/dto.js";
import { toMemory, type Actor } from "./memory.service.js";
import type { MemoryRecord } from "./types.js";
import {
  parseRuleMarkdown,
  RuleImportError,
  type ImportInput,
  type ImportPreview,
  type ImportResult,
  type PreviewRule,
} from "./import-format.js";

export interface StoredPreviewRule extends PreviewRule {
  targetId: string;
  exceptionTo?: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function signature(rule: Pick<MemoryRecord, "type" | "title" | "content" | "rationale" | "scope" | "exceptionTo">) {
  const scope = Object.fromEntries(Object.entries(rule.scope).filter(([, values]) => values?.length));
  return hash(
    JSON.stringify(
      canonical({
        type: rule.type,
        title: rule.title.trim(),
        content: rule.content.trim(),
        rationale: rule.rationale.trim(),
        scope,
        exceptionTo: rule.exceptionTo ?? null,
      }),
    ),
  );
}

export class RuleImportService {
  constructor(private database: Database) {}

  async active(repositoryId: number) {
    const result = await this.database.pool.query(
      "SELECT * FROM memories WHERE repository_id=$1 AND status='ACTIVE' ORDER BY title,id",
      [repositoryId],
    );
    return result.rows.map(toMemory);
  }

  async preview(target: Repository, actor: Actor, input: ImportInput, source?: Repository): Promise<ImportPreview> {
    const provenance = { importedBy: actor.id, importedByLogin: actor.login, importedAt: new Date().toISOString() };
    let drafts: PreviewRule[];
    if (input.kind === "markdown") {
      drafts = parseRuleMarkdown(input.markdown).map((rule) => ({
        ...rule,
        sameTitleIds: [],
        source: {
          ...provenance,
          kind: "markdown_import",
          documentName: input.documentName,
          documentSha256: hash(input.markdown),
          documentRuleId: rule.key,
        },
      }));
    } else {
      const active = await this.active(source!.id);
      drafts = input.rules.map(({ id, paths }) => {
        const rule = active.find((item) => item.id === id);
        if (!rule) throw new RuleImportError("所选来源规则已不再生效，请重新选择");
        return {
          key: rule.id,
          type: rule.type,
          title: rule.title,
          content: rule.content,
          rationale: rule.rationale,
          scope: { ...rule.scope, paths },
          evidence: rule.evidence,
          uncertainties: rule.uncertainties,
          exceptionKey: rule.exceptionTo,
          sourceSnapshot: rule,
          sameTitleIds: [],
          source: {
            ...provenance,
            kind: "project_import" as const,
            repositoryId: source!.id,
            repositoryName: source!.fullName,
            memoryId: rule.id,
            memoryVersion: rule.version,
          },
        };
      });
    }
    const existing = (
      await this.database.pool.query("SELECT * FROM memories WHERE repository_id=$1 ORDER BY version DESC", [target.id])
    ).rows.map(toMemory);
    const rules = this.prepare(drafts, existing);
    const id = randomUUID();
    await this.database.pool.query("DELETE FROM memory_import_previews WHERE expires_at < now()");
    const saved = await this.database.pool.query(
      "INSERT INTO memory_import_previews(id,repository_id,actor_id,source_repository_id,rules) VALUES($1,$2,$3,$4,$5) RETURNING expires_at",
      [id, target.id, actor.id, source?.id ?? null, JSON.stringify(rules)],
    );
    return { id, rules, expiresAt: saved.rows[0].expires_at.toISOString() };
  }

  // Parent rules are resolved before exceptions so imported links always point into the target project.
  private prepare(drafts: PreviewRule[], existing: MemoryRecord[]): StoredPreviewRule[] {
    const resolved = new Map<string, StoredPreviewRule>();
    const visiting = new Set<string>();
    const visit = (draft: PreviewRule): StoredPreviewRule => {
      if (resolved.has(draft.key)) return resolved.get(draft.key)!;
      if (visiting.has(draft.key)) throw new RuleImportError(`${draft.title}：例外关联存在循环`);
      visiting.add(draft.key);
      let exceptionTo: string | undefined;
      if (draft.type === "exception") {
        if (!Object.values(draft.scope).some((value) => value?.length))
          throw new RuleImportError(`${draft.title}：例外必须限定范围`);
        const parent = drafts.find((item) => item.key === draft.exceptionKey);
        if (!parent) throw new RuleImportError(`${draft.title}：请同时选择例外所关联的原规则`);
        const original = visit(parent);
        exceptionTo = original.duplicateId ?? original.targetId;
        if (
          original.duplicateId &&
          !existing.some(
            (item) =>
              item.id === original.duplicateId && item.status === "ACTIVE" && signature(item) === signature(original),
          ) &&
          ![...resolved.values()].some((item) => item.targetId === original.duplicateId && !item.duplicateId)
        )
          throw new RuleImportError(`${draft.title}：目标项目中重复的原规则未生效，需先确认或恢复该规则`);
      }
      const rule: StoredPreviewRule = { ...draft, exceptionTo, targetId: randomUUID(), sameTitleIds: [] };
      const same = existing.find((item) => signature(item) === signature(rule));
      const batchSame = [...resolved.values()].find((item) => signature(item) === signature(rule));
      rule.duplicateId = same?.id ?? batchSame?.duplicateId ?? batchSame?.targetId;
      rule.sameTitleIds = existing
        .filter((item) => item.title.trim() === rule.title.trim() && signature(item) !== signature(rule))
        .map((item) => item.id);
      if (
        [...resolved.values()].some(
          (item) => item.title.trim() === rule.title.trim() && signature(item) !== signature(rule),
        )
      )
        rule.sameTitleIds.push("本次导入中的同名规则");
      resolved.set(rule.key, rule);
      visiting.delete(rule.key);
      return rule;
    };
    drafts.forEach(visit);
    return [...resolved.values()];
  }

  async previewSource(targetId: number, actorId: number, id: string) {
    const result = await this.database.pool.query(
      "SELECT source_repository_id FROM memory_import_previews WHERE id=$1 AND repository_id=$2 AND actor_id=$3 AND expires_at>now()",
      [id, targetId, actorId],
    );
    if (!result.rowCount) throw new RuleImportError("预览不存在或已过期，请重新预览");
    return result.rows[0].source_repository_id ? Number(result.rows[0].source_repository_id) : undefined;
  }

  async confirm(target: Repository, actor: Actor, id: string, selection: string[]): Promise<ImportResult> {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const row = (
          await client.query(
            "SELECT * FROM memory_import_previews WHERE id=$1 AND repository_id=$2 AND actor_id=$3 AND expires_at>now() FOR UPDATE",
            [id, target.id, actor.id],
          )
        ).rows[0];
        if (!row) throw new RuleImportError("预览不存在或已过期，请重新预览");
        if (row.result) {
          if (JSON.stringify([...selection].sort()) !== JSON.stringify(row.selection))
            throw new RuleImportError("该预览已确认，请新建预览导入其他规则");
          return row.result as ImportResult;
        }
        const drafts = row.rules as StoredPreviewRule[];
        const selected = drafts.filter((rule) => selection.includes(rule.key));
        if (selected.length !== selection.length) throw new RuleImportError("选择的规则不属于本次预览");
        // Serialize imports into the same repository, including different previews and service instances.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`rule-import:${target.id}`]);
        if (row.source_repository_id) {
          const source = (
            await client.query(
              "SELECT * FROM memories WHERE repository_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE' ORDER BY id FOR SHARE",
              [row.source_repository_id, selected.map((rule) => rule.key)],
            )
          ).rows.map(toMemory);
          for (const rule of selected) {
            const current = source.find((item) => item.id === rule.key);
            if (!current || JSON.stringify(canonical(current)) !== JSON.stringify(canonical(rule.sourceSnapshot)))
              throw new RuleImportError("来源规则在预览后发生变化，请重新预览");
          }
        }
        const existing = (
          await client.query("SELECT * FROM memories WHERE repository_id=$1 ORDER BY id,version DESC FOR UPDATE", [
            target.id,
          ])
        ).rows.map(toMemory);
        const outcome: ImportResult = { imported: [], skipped: [] };
        const mapped = new Map<string, string>();
        for (const rule of selected) {
          const parent = rule.exceptionKey ? drafts.find((item) => item.key === rule.exceptionKey) : undefined;
          if (parent) {
            const targetParent = mapped.get(parent.key) ?? parent.duplicateId;
            if (
              !targetParent ||
              !existing.some(
                (item) => item.id === targetParent && item.status === "ACTIVE" && signature(item) === signature(parent),
              )
            )
              throw new RuleImportError(`${rule.title}：必须同时勾选原规则，且原规则需要生效`);
            rule.exceptionTo = targetParent;
          }
          const same = existing.find((item) => signature(item) === signature(rule));
          if (same) {
            mapped.set(rule.key, same.id);
            outcome.skipped.push(rule.key);
            continue;
          }
          const newConflict = existing.some(
            (item) =>
              item.title.trim() === rule.title.trim() &&
              !rule.sameTitleIds.includes(item.id) &&
              !outcome.imported.includes(item.id) &&
              signature(item) !== signature(rule),
          );
          if (newConflict) throw new RuleImportError("目标项目新增了同名规则，请重新预览冲突后再确认");
          const saved = await this.insert(client, target, actor, rule);
          existing.push(saved);
          mapped.set(rule.key, saved.id);
          outcome.imported.push(saved.id);
        }
        await client.query("UPDATE memory_import_previews SET result=$2,selection=$3 WHERE id=$1", [
          id,
          outcome,
          JSON.stringify([...selection].sort()),
        ]);
        return outcome;
      });
    } finally {
      client.release();
    }
  }

  private async insert(client: PoolClient, target: Repository, actor: Actor, rule: StoredPreviewRule) {
    const source = { ...rule.source, importedAt: new Date().toISOString() };
    const result = await client.query(
      `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,approved_by,approved_at)
       VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,'ACTIVE',$12,$13,$14,now()) RETURNING *`,
      [
        rule.targetId,
        target.id,
        target.installationId,
        rule.type,
        rule.title,
        rule.content,
        rule.rationale,
        rule.scope,
        source,
        JSON.stringify(rule.evidence),
        JSON.stringify(rule.uncertainties),
        `import:${signature(rule)}`,
        rule.exceptionTo ?? null,
        actor.id,
      ],
    );
    const saved = toMemory(result.rows[0]);
    await client.query(
      "INSERT INTO memory_audits(id,memory_id,memory_version,actor_id,actor_login,action,before_value,after_value) VALUES($1,$2,1,$3,$4,'import',NULL,$5)",
      [randomUUID(), saved.id, actor.id, actor.login, saved],
    );
    return saved;
  }
}
