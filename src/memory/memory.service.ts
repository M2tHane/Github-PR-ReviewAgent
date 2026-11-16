import { randomUUID } from "node:crypto";
import { matchesGlob } from "node:path";
import { languageOf, normalizeLanguage } from "../config/languages.js";
import type { Database } from "../persistence/database.js";
import { transaction } from "../persistence/transaction.js";
import { loadMemoryContext, type ContextInput } from "./context.js";
import type { MemoryOwner, MemoryRecord, MemoryWithUsage } from "./types.js";

export interface Actor {
  id: number;
  login: string;
}
export type CandidatePatch = Partial<
  Pick<MemoryRecord, "type" | "title" | "content" | "rationale" | "scope" | "uncertainties" | "level">
> & { exceptionTo?: string | null };

export class MemoryService {
  constructor(private database: Database) {}

  async list(owner: MemoryOwner, status?: MemoryRecord["status"], activeOnly = false): Promise<MemoryWithUsage[]> {
    const result = await this.database.pool.query(
      `WITH current AS (
         SELECT DISTINCT ON (id) *,max(version) FILTER (WHERE status='ACTIVE') OVER (PARTITION BY id) active_version
         FROM memories WHERE repository_id=$1 ${activeOnly ? "AND status='ACTIVE'" : ""} ORDER BY id,(status IN ('ACTIVE','CANDIDATE')) DESC,version DESC
       ), provided AS (
         SELECT u.memory_id,count(*)::int provided FROM review_memory_usage u
         JOIN jobs j ON j.id=u.job_id AND j.job_type='PR_REVIEW'
         WHERE u.memory_id IN (SELECT id FROM current) AND u.repository_id=$1 GROUP BY u.memory_id
       ), cited AS (
         SELECT f.memory_id,count(*)::int cited,
           count(*) FILTER (WHERE f.status='FIXED')::int fixed,
           count(*) FILTER (WHERE f.inferred_fixed_at IS NOT NULL AND f.status<>'FIXED')::int inferred_fixed,
           count(*) FILTER (WHERE f.status='WITHDRAWN')::int withdrawn,
           count(*) FILTER (WHERE f.status='EXCEPTION_PENDING')::int exception,
           count(*) FILTER (WHERE f.status IN ('OPEN','STILL_VALID','NEEDS_CLARIFICATION'))::int open,
           max(f.created_at) last_cited_at
         FROM review_findings f JOIN jobs j ON j.id=f.job_id AND j.job_type='PR_REVIEW'
         WHERE f.memory_id IN (SELECT id FROM current) AND f.repository_id=$1
           AND f.binding_status<>'pending' AND NOT (f.presentation ? 'repeatOf')
         GROUP BY f.memory_id
       )
       SELECT m.*,COALESCE(p.provided,0) provided,COALESCE(c.cited,0) cited,
         COALESCE(c.fixed,0) fixed,COALESCE(c.inferred_fixed,0) inferred_fixed,COALESCE(c.withdrawn,0) withdrawn,
         COALESCE(c.exception,0) exception,COALESCE(c.open,0) open,c.last_cited_at
       FROM current m LEFT JOIN provided p ON p.memory_id=m.id LEFT JOIN cited c ON c.memory_id=m.id
       ORDER BY m.id`,
      [owner],
    );
    return result.rows
      .map((row) => ({
        ...toMemory(row),
        usage: {
          provided: row.provided,
          cited: row.cited,
          fixed: row.fixed,
          inferredFixed: row.inferred_fixed,
          withdrawn: row.withdrawn,
          exception: row.exception,
          open: row.open,
          lastCitedAt: row.last_cited_at?.toISOString() ?? null,
        },
      }))
      .filter((memory) => !status || memory.status === status);
  }

  async get(owner: MemoryOwner, id: string) {
    const result = await this.database.pool.query(
      `SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1`,
      [owner, id],
    );
    return result.rows[0] ? toMemory(result.rows[0]) : undefined;
  }

  async edit(owner: MemoryOwner, id: string, patch: CandidatePatch, actor: Actor) {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const currentResult = await client.query(
          `SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE`,
          [owner, id],
        );
        if (!currentResult.rows[0]) throw new Error("Memory 不存在或不属于当前归属");
        const current = toMemory(currentResult.rows[0]);
        const after = {
          ...current,
          ...patch,
          exceptionTo: patch.exceptionTo === undefined ? current.exceptionTo : (patch.exceptionTo ?? undefined),
        };
        if (current.status === "CANDIDATE") {
          await client.query(
            `UPDATE memories SET type=$3,title=$4,content=$5,rationale=$6,scope=$7,uncertainties=$8,exception_to=$10,level=$11,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version=$9`,
            [
              owner,
              id,
              after.type,
              after.title,
              after.content,
              after.rationale,
              after.scope,
              JSON.stringify(after.uncertainties),
              current.version,
              after.exceptionTo,
              after.level,
            ],
          );
        } else if (current.status === "ACTIVE") {
          const version = Number(
            (
              await client.query(`SELECT max(version)+1 version FROM memories WHERE repository_id=$1 AND id=$2`, [
                owner,
                id,
              ])
            ).rows[0].version,
          );
          await client.query(
            `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,expires_at,supersedes,level) SELECT id,$3::integer,repository_id,installation_id,$4,$5,$6,$7,$8,source,evidence,confidence,$9,'CANDIDATE',source_fingerprint||':v'||$3::text,$11,expires_at,supersedes,$12 FROM memories WHERE repository_id=$1 AND id=$2 AND version=$10`,
            [
              owner,
              id,
              version,
              after.type,
              after.title,
              after.content,
              after.rationale,
              after.scope,
              JSON.stringify(after.uncertainties),
              current.version,
              after.exceptionTo,
              after.level,
            ],
          );
          after.version = version;
          after.status = "CANDIDATE";
        } else throw new Error("当前 Memory 状态不可编辑");
        await audit(client, current, after, actor, "edit");
        return after;
      });
    } finally {
      client.release();
    }
  }

  async transition(owner: MemoryOwner, id: string, action: "approve" | "reject" | "deprecate", actor: Actor) {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const result = await client.query(
          `SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE`,
          [owner, id],
        );
        if (!result.rows[0]) throw new Error("Memory 不存在或不属于当前归属");
        const before = toMemory(result.rows[0]);
        const expected = action === "deprecate" ? "ACTIVE" : "CANDIDATE";
        if (before.status !== expected) throw new Error(`只有 ${expected} 可以 ${action}`);
        if (action === "approve" && before.supersedes && before.supersedes !== before.id) {
          const oldRow = await client.query(
            `SELECT * FROM memories WHERE repository_id=$1 AND id=$2 AND status='ACTIVE' ORDER BY version DESC LIMIT 1 FOR UPDATE`,
            [owner, before.supersedes],
          );
          if (oldRow.rows[0]) return supersedeMemories(client, toMemory(oldRow.rows[0]), before, actor);
        }
        if (action === "approve") await validateException(client, before);
        const status = action === "approve" ? "ACTIVE" : action === "reject" ? "REJECTED" : "DEPRECATED";
        if (action === "approve")
          await client.query(
            `UPDATE memories SET status='SUPERSEDED',superseded_by=$3,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version<$4 AND status='ACTIVE'`,
            [owner, id, id, before.version],
          );
        const updated = await client.query(
          `UPDATE memories SET status=$4,approved_by=CASE WHEN $4='ACTIVE' THEN $3 ELSE approved_by END,approved_at=CASE WHEN $4='ACTIVE' THEN now() ELSE approved_at END,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version=$5 RETURNING *`,
          [owner, id, actor.id, status, before.version],
        );
        const after = toMemory(updated.rows[0]);
        await audit(client, before, after, actor, action);
        return after;
      });
    } finally {
      client.release();
    }
  }

  async supersede(owner: MemoryOwner, oldId: string, candidateId: string, actor: Actor) {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const oldRow = await client.query(
          `SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE`,
          [owner, oldId],
        );
        const candidateRow = await client.query(
          `SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE`,
          [owner, candidateId],
        );
        const old = oldRow.rows[0] ? toMemory(oldRow.rows[0]) : undefined;
        const candidate = candidateRow.rows[0] ? toMemory(candidateRow.rows[0]) : undefined;
        if (old?.status !== "ACTIVE" || candidate?.status !== "CANDIDATE")
          throw new Error("替代要求同归属 ACTIVE 原规则和 CANDIDATE 新规则");
        return supersedeMemories(client, old, candidate, actor);
      });
    } finally {
      client.release();
    }
  }

  async retrieve(repositoryId: number, input: RetrieveInput) {
    const context = await this.context(repositoryId, input, Number.MAX_SAFE_INTEGER);
    return rankMemories(context.full, input);
  }

  context(repositoryId: number, input: ContextInput, maxChars = REVIEW_MEMORY_CHARS) {
    return loadMemoryContext(this.database.pool, repositoryId, input, maxChars);
  }
}

export interface RetrieveInput {
  paths: string[];
  text: string;
  limit?: number;
  // 未限定 Scope 的全局规则至少要和变更文本共有几个词才召回；健康检查需要全部候选时传 0。
  minGlobalScore?: number;
}

// 拆成整词：标识符按驼峰和下划线拆开并保留原词；中文没有空格，按相邻两字切分。
export function matchWords(text: string) {
  const words = new Set<string>();
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const word of `${text} ${spaced}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (/\p{Script=Han}/u.test(word))
      for (let index = 0; index < word.length - 1; index++) words.add(word.slice(index, index + 2));
    else if (word.length > 2) words.add(word);
  }
  return words;
}

export function hasSpecificScope(memory: Pick<MemoryRecord, "scope">) {
  return Boolean(memory.scope.paths?.length || memory.scope.modules?.length || memory.scope.languages?.length);
}

export function rankMemories(memories: MemoryRecord[], input: RetrieveInput) {
  const queryWords = matchWords(input.text);
  const minGlobalScore = input.minGlobalScore ?? 2;
  return (
    memories
      .filter((memory) => scopeMatches(memory, input.paths))
      .map((memory) => {
        const memoryWords = matchWords(`${memory.title} ${memory.content} ${memory.rationale}`);
        return { memory, score: [...memoryWords].filter((word) => queryWords.has(word)).length };
      })
      // 限定了路径/模块/语言的规则命中 Scope 本身就是信号，不受最低分限制。
      .filter(({ memory, score }) => hasSpecificScope(memory) || score >= minGlobalScore)
      .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
      .slice(0, input.limit ?? 10)
      .map(({ memory }) => memory)
  );
}

// Review 的 title + content + rationale 字符预算；编译器对 must 超限只告警。
export const REVIEW_MEMORY_CHARS = 30_000;

// 旧 Review 算法保留为召回评测基线；生产统一使用 context.ts。
// 范围命中改动文件的规则全部带上，全局规则不要求最低分；选中的例外把未选中的 ACTIVE 原规则一并带上。
// 只有总字符数超过上限时才截断：限定范围的在前、全局的在后，各自按词重叠分数从高到低、同分按 ID，保留到上限为止。
// total 是截断前的条数，调用方据此说明"只带了几条"。
export function selectReviewMemories(
  memories: MemoryRecord[],
  input: Pick<RetrieveInput, "paths" | "text">,
  maxChars = REVIEW_MEMORY_CHARS,
) {
  const selected = memories.filter((memory) => scopeMatches(memory, input.paths));
  const ids = new Set(selected.map((memory) => memory.id));
  for (const memory of [...selected]) {
    const original =
      memory.exceptionTo && !ids.has(memory.exceptionTo)
        ? memories.find((item) => item.id === memory.exceptionTo)
        : undefined;
    if (original) {
      selected.push(original);
      ids.add(original.id);
    }
  }
  const size = (memory: MemoryRecord) => memory.title.length + memory.content.length + memory.rationale.length;
  if (selected.reduce((sum, memory) => sum + size(memory), 0) <= maxChars)
    return { memories: selected, total: selected.length };
  const queryWords = matchWords(input.text);
  const ranked = selected
    .map((memory) => ({
      memory,
      specific: hasSpecificScope(memory),
      score: [...matchWords(`${memory.title} ${memory.content} ${memory.rationale}`)].filter((word) =>
        queryWords.has(word),
      ).length,
    }))
    .sort(
      (a, b) => Number(b.specific) - Number(a.specific) || b.score - a.score || a.memory.id.localeCompare(b.memory.id),
    );
  const kept: MemoryRecord[] = [];
  let used = 0;
  for (const { memory } of ranked) {
    if (used + size(memory) > maxChars) break;
    kept.push(memory);
    used += size(memory);
  }
  return { memories: kept, total: selected.length };
}

export function scopeMatches(memory: Pick<MemoryRecord, "scope">, paths: string[]) {
  const scope = memory.scope;
  if (scope.paths?.length && !paths.some((path) => scope.paths!.some((pattern) => matchesGlob(path, pattern))))
    return false;
  if (scope.languages?.length) {
    const languages = new Set(paths.map(languageOf).filter(Boolean));
    if (!scope.languages.some((language) => languages.has(normalizeLanguage(language)))) return false;
  }
  if (scope.modules?.length && !paths.some((path) => scope.modules!.some((module) => path.split("/").includes(module))))
    return false;
  return true;
}

async function supersedeMemories(
  client: import("pg").PoolClient,
  old: MemoryRecord,
  candidate: MemoryRecord,
  actor: Actor,
) {
  if (candidate.type === "exception" && candidate.exceptionTo === old.id)
    throw new Error("例外必须保留原规则，不能用例外替代原规则");
  await validateException(client, candidate);
  await client.query(
    "UPDATE memories SET status='SUPERSEDED',superseded_by=$2,updated_at=now() WHERE id=$1 AND version=$3",
    [old.id, candidate.id, old.version],
  );
  await client.query(
    "UPDATE memories SET status='SUPERSEDED',superseded_by=$1,updated_at=now() WHERE id=$1 AND version<$2 AND status='ACTIVE'",
    [candidate.id, candidate.version],
  );
  const result = await client.query(
    "UPDATE memories SET status='ACTIVE',supersedes=$2,approved_by=$3,approved_at=now(),updated_at=now() WHERE id=$1 AND version=$4 RETURNING *",
    [candidate.id, old.id, actor.id, candidate.version],
  );
  const after = toMemory(result.rows[0]);
  await audit(client, old, { ...old, status: "SUPERSEDED", supersededBy: candidate.id }, actor, "supersede-old");
  await audit(client, candidate, after, actor, "supersede-new");
  return after;
}

async function validateException(client: import("pg").PoolClient, memory: MemoryRecord) {
  if (memory.type !== "exception") return;
  if (!memory.exceptionTo || !Object.values(memory.scope).some((value) => value?.length))
    throw new Error("例外必须关联原规则并限定 Scope");
  const original = await client.query(`SELECT 1 FROM memories m WHERE id=$1 AND status='ACTIVE' AND repository_id=$2`, [
    memory.exceptionTo,
    memory.repositoryId,
  ]);
  if (!original.rowCount) throw new Error("例外关联的 ACTIVE 原规则不存在");
}

async function audit(
  client: import("pg").PoolClient,
  before: MemoryRecord,
  after: MemoryRecord,
  actor: Actor,
  action: string,
) {
  await client.query(
    "INSERT INTO memory_audits(id,memory_id,memory_version,actor_id,actor_login,action,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), after.id, after.version, actor.id, actor.login, action, before, after],
  );
}

export function toMemory(row: Record<string, any>): MemoryRecord {
  return {
    activeVersion: row.active_version ? Number(row.active_version) : undefined,
    id: String(row.id),
    version: Number(row.version),
    repositoryId: Number(row.repository_id),
    installationId: Number(row.installation_id),
    level: row.level,
    type: row.type,
    title: row.title,
    content: row.content,
    rationale: row.rationale,
    scope: row.scope,
    source: row.source,
    evidence: row.evidence,
    confidence: row.confidence === null ? null : Number(row.confidence),
    uncertainties: row.uncertainties,
    status: row.status,
    exceptionTo: row.exception_to ?? undefined,
    supersedes: row.supersedes ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    approvedBy: row.approved_by ? Number(row.approved_by) : undefined,
    approvedAt: row.approved_at?.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
