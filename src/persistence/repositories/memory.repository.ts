import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DecisionProposal, MemoryRecord } from "../../memory/types.js";
import type { ReviewJob } from "../../jobs/types.js";
import { transaction } from "../transaction.js";
import { MemoryPromotionError } from "../../memory/types.js";
import { toMemory, type Actor } from "../../memory/memory.service.js";
export class MemoryRepository {
  constructor(readonly pool: Pool) {}
  async promote(repositoryId: number, memoryId: string, teamId: string, actor: Actor) {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const membership = await client.query(
          "SELECT 1 FROM team_repositories WHERE team_id=$1 AND repository_id=$2 FOR SHARE",
          [teamId, repositoryId],
        );
        if (!membership.rowCount) throw new MemoryPromotionError("只能提升到本仓库所属团队");
        const original = (
          await client.query(
            "SELECT * FROM memories WHERE repository_id=$1 AND id=$2 AND status='ACTIVE' ORDER BY version DESC LIMIT 1 FOR SHARE",
            [repositoryId, memoryId],
          )
        ).rows[0];
        if (!original) throw new MemoryPromotionError("只能提升 ACTIVE 项目规则");
        const source = { kind: "promotion", repositoryId, memoryId: String(original.id), version: original.version };
        const fingerprint = `promotion:${original.id}:${original.version}`;
        const inserted = await client.query(
          `INSERT INTO memories(id,version,team_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,expires_at,supersedes,level)
           SELECT $1,1,$2,type,title,content,rationale,scope,$3,evidence,confidence,uncertainties,'CANDIDATE',$4,exception_to,expires_at,id,level FROM memories WHERE id=$5 AND version=$6
           ON CONFLICT(team_id,source_fingerprint) DO NOTHING RETURNING *`,
          [randomUUID(), teamId, source, fingerprint, original.id, original.version],
        );
        if (!inserted.rowCount)
          return toMemory(
            (
              await client.query("SELECT * FROM memories WHERE team_id=$1 AND source_fingerprint=$2", [
                teamId,
                fingerprint,
              ])
            ).rows[0],
          );
        const saved = toMemory(inserted.rows[0]);
        await client.query(
          "INSERT INTO memory_audits(id,memory_id,memory_version,actor_id,actor_login,action,before_value,after_value) VALUES($1,$2,1,$3,$4,'promote',$5,$6)",
          [randomUUID(), saved.id, actor.id, actor.login, toMemory(original), saved],
        );
        return saved;
      });
    } finally {
      client.release();
    }
  }
  async saveReviewMemoryUsage(job: ReviewJob, memories: Pick<MemoryRecord, "id" | "version">[]) {
    if (!memories.length) return;
    await this.pool.query(
      `INSERT INTO review_memory_usage(job_id,repository_id,memory_id,memory_version)
       SELECT $1,$2,id,version FROM unnest($3::uuid[],$4::integer[]) AS recalled(id,version)
       ON CONFLICT(job_id,memory_id) DO NOTHING`,
      [job.id, job.repositoryId, memories.map((memory) => memory.id), memories.map((memory) => memory.version)],
    );
  }

  async insertCandidates(job: ReviewJob, proposals: DecisionProposal[]) {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const ids: string[] = [];
        const conflictIds = [...new Set(proposals.flatMap((proposal) => proposal.relation?.conflictsWith ?? []))];
        const conflictRules = new Map<string, { title: string }>();
        if (conflictIds.length) {
          const result = await client.query<{ id: string; title: string }>(
            "SELECT DISTINCT ON (id) id,title FROM memories WHERE (repository_id=$1 OR team_id IN (SELECT team_id FROM team_repositories WHERE repository_id=$1)) AND id=ANY($2::uuid[]) ORDER BY id,(status='ACTIVE') DESC,version DESC",
            [job.repositoryId, conflictIds],
          );
          for (const rule of result.rows) conflictRules.set(rule.id, rule);
        }
        for (const proposal of proposals) {
          const uncertainties = [
            ...proposal.uncertainties,
            ...(proposal.relation?.conflictsWith ?? []).map(
              (id) => `可能与现有规则「${conflictRules.get(id)!.title}」冲突（${id}）`,
            ),
          ];
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify([
                job.repositoryId,
                proposal.source.pullRequestNumber,
                proposal.source.commitSha,
                [...proposal.source.commentIds].sort(),
                proposal.type,
                proposal.content.trim().toLowerCase(),
              ]),
            )
            .digest("hex");
          const id = randomUUID();
          const result = await client.query(
            "INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,supersedes) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CANDIDATE',$13,$14,$15) ON CONFLICT(repository_id,source_fingerprint) DO NOTHING RETURNING id",
            [
              id,
              job.repositoryId,
              job.installationId,
              proposal.type,
              proposal.title,
              proposal.content,
              proposal.rationale,
              proposal.scope,
              proposal.source,
              JSON.stringify(proposal.evidence),
              proposal.confidence,
              JSON.stringify(uncertainties),
              fingerprint,
              proposal.relation?.exceptionTo ?? null,
              proposal.relation?.supersedes ?? null,
            ],
          );
          if (result.rows[0]) ids.push(String(result.rows[0].id));
        }
        return ids;
      });
    } finally {
      client.release();
    }
  }
}
