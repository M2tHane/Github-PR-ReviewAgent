import { matchesGlob } from "node:path";
import type { Database } from "../persistence/database.js";
import type { GitHubClient } from "../github/client.js";
import { log } from "../logging.js";
import { MemoryService } from "./memory.service.js";
import type { MemoryOwner, RuleReviewQueue, RuleReviewReason } from "./types.js";

const DAY = 86_400_000;
export const RULE_REVIEW = {
  noisyCitations: 3,
  noisyWithdrawnRatio: 0.4,
  sleepingDays: 90,
  dismissalDays: 90,
  treeCacheMs: DAY,
} as const;
export const RULE_REVIEW_REASONS = ["noisy", "sleeping", "path_invalid", "expired"] as const;

type Tree = { paths: string[]; truncated: boolean };
type Repository = {
  id: string;
  installation_id: string;
  full_name: string;
  revoked_at: Date | null;
  team_ids: string[];
};

export class RuleReviewService {
  private memories: MemoryService;
  private fetching = new Map<number, Promise<Tree>>();
  constructor(
    private database: Database,
    private github: Pick<GitHubClient, "installationToken" | "defaultBranchTree">,
    private allowedRepositories: ReadonlySet<string>,
    private clock = () => new Date(),
  ) {
    this.memories = new MemoryService(database);
  }

  async list(owners: MemoryOwner[]): Promise<RuleReviewQueue> {
    const now = this.clock();
    const memories = (await Promise.all(owners.map((owner) => this.memories.list(owner, undefined, true)))).flat();
    if (!memories.length) return { items: [], uncheckedRepositories: [] };
    const dismissals = await this.database.pool.query<{ memory_id: string; reason: string }>(
      "SELECT memory_id,reason FROM rule_review_dismissals WHERE memory_id=ANY($1::uuid[]) AND dismissed_at>$2",
      [memories.map((memory) => memory.id), new Date(now.getTime() - RULE_REVIEW.dismissalDays * DAY)],
    );
    const dismissed = new Set(dismissals.rows.map((row) => `${row.memory_id}:${row.reason}`));
    const scoped = memories.filter(
      (memory) => memory.scope.paths?.length && !dismissed.has(`${memory.id}:path_invalid`),
    );
    const repositories = scoped.length
      ? (
          await this.database.pool.query<Repository>(
            `SELECT r.*,ARRAY(SELECT team_id::text FROM team_repositories WHERE repository_id=r.id) team_ids
       FROM repositories r WHERE r.id=ANY($1::bigint[]) OR r.id IN
       (SELECT repository_id FROM team_repositories WHERE team_id=ANY($2::uuid[])) ORDER BY r.id`,
            [
              scoped.flatMap((memory) => (memory.repositoryId === null ? [] : [memory.repositoryId])),
              scoped.flatMap((memory) => (memory.teamId ? [memory.teamId] : [])),
            ],
          )
        ).rows
      : [];
    const trees = new Map<number, Tree>();
    const uncheckedRepositories: string[] = [];
    const tokens = new Map<string, Promise<string>>();
    // 队列才取文件树；同一请求每个 installation 只签发一次 token，并限制同时读取的仓库数。
    for (let offset = 0; offset < repositories.length; offset += 4) {
      await Promise.all(
        repositories.slice(offset, offset + 4).map(async (repository) => {
          if (repository.revoked_at !== null || !this.allowedRepositories.has(repository.full_name.toLowerCase())) {
            uncheckedRepositories.push(repository.full_name);
            return;
          }
          try {
            const tree = await this.tree(repository, now, tokens);
            trees.set(Number(repository.id), tree);
            if (tree.truncated) uncheckedRepositories.push(repository.full_name);
          } catch (error) {
            // 网络失败不能把未知的路径判为不存在；仍返回其他复查原因并明确列出未检查仓库。
            uncheckedRepositories.push(repository.full_name);
            log("error", "rule_review_tree_failed", { repositoryId: repository.id, error });
          }
        }),
      );
    }
    const items = memories.flatMap((memory) => {
      const reasons: RuleReviewReason[] = [];
      const { cited, withdrawn, lastCitedAt } = memory.usage;
      if (cited >= RULE_REVIEW.noisyCitations && withdrawn / cited >= RULE_REVIEW.noisyWithdrawnRatio)
        reasons.push({ reason: "noisy", cited, withdrawn, withdrawnRatio: withdrawn / cited });
      const cutoff = now.getTime() - RULE_REVIEW.sleepingDays * DAY;
      if (
        memory.approvedAt &&
        Date.parse(memory.approvedAt) <= cutoff &&
        (!lastCitedAt || Date.parse(lastCitedAt) <= cutoff)
      )
        reasons.push({
          reason: "sleeping",
          approvedAt: memory.approvedAt,
          lastCitedAt,
          days: RULE_REVIEW.sleepingDays,
        });
      if (memory.expiresAt && Date.parse(memory.expiresAt) <= now.getTime())
        reasons.push({ reason: "expired", expiresAt: memory.expiresAt });
      if (memory.scope.paths?.length && !dismissed.has(`${memory.id}:path_invalid`)) {
        const applicable = repositories.filter((repo) =>
          memory.teamId ? repo.team_ids.includes(memory.teamId) : Number(repo.id) === memory.repositoryId,
        );
        // 只有所有适用仓库都能证实没有匹配，才标记失效；截断、取树失败或零仓库都不是失效证据。
        if (
          applicable.length &&
          applicable.every((repo) => {
            const tree = trees.get(Number(repo.id));
            return (
              tree &&
              !tree.truncated &&
              !tree.paths.some((path) => memory.scope.paths!.some((pattern) => matchesGlob(path, pattern)))
            );
          })
        )
          reasons.push({ reason: "path_invalid", paths: memory.scope.paths, repositories: applicable.length });
      }
      const visible = reasons.filter(({ reason }) => !dismissed.has(`${memory.id}:${reason}`));
      return visible.length ? [{ memory, reasons: visible }] : [];
    });
    items.sort((a, b) => b.reasons.length - a.reasons.length || a.memory.id.localeCompare(b.memory.id));
    return { items, uncheckedRepositories: uncheckedRepositories.sort() };
  }

  async dismiss(memoryId: string, reason: RuleReviewReason["reason"], note: string, actor: string) {
    const dismissedAt = this.clock();
    await this.database.pool.query(
      `INSERT INTO rule_review_dismissals(memory_id,reason,note,dismissed_by,dismissed_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(memory_id,reason) DO UPDATE SET note=EXCLUDED.note,dismissed_by=EXCLUDED.dismissed_by,dismissed_at=EXCLUDED.dismissed_at`,
      [memoryId, reason, note, actor, dismissedAt],
    );
    return { dismissedUntil: new Date(dismissedAt.getTime() + RULE_REVIEW.dismissalDays * DAY).toISOString() };
  }

  private async tree(repository: Repository, now: Date, tokens: Map<string, Promise<string>>): Promise<Tree> {
    const repositoryId = Number(repository.id);
    const cached = await this.database.pool.query<Tree>(
      "SELECT paths,truncated FROM repository_trees WHERE repository_id=$1 AND fetched_at>$2",
      [repositoryId, new Date(now.getTime() - RULE_REVIEW.treeCacheMs)],
    );
    if (cached.rows[0]) return cached.rows[0];
    let pending = this.fetching.get(repositoryId);
    if (!pending) {
      pending = (async () => {
        let token = tokens.get(repository.installation_id);
        if (!token) {
          token = this.github.installationToken(Number(repository.installation_id));
          tokens.set(repository.installation_id, token);
        }
        const fetched = await this.github.defaultBranchTree(await token, repository.full_name);
        const tree = {
          paths: fetched.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
          truncated: fetched.truncated,
        };
        await this.database.pool.query(
          `INSERT INTO repository_trees(repository_id,sha,paths,truncated,fetched_at) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(repository_id) DO UPDATE SET sha=EXCLUDED.sha,paths=EXCLUDED.paths,truncated=EXCLUDED.truncated,fetched_at=EXCLUDED.fetched_at`,
          [repositoryId, fetched.sha, tree.paths, tree.truncated, now],
        );
        return tree;
      })();
      this.fetching.set(repositoryId, pending);
    }
    try {
      return await pending;
    } finally {
      this.fetching.delete(repositoryId);
    }
  }
}
