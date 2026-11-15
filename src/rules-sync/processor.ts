import type { PoolClient } from "pg";
import type { Config } from "../config/config.js";
import { GitHubClient } from "../github/client.js";
import type { RulesSyncJob } from "../jobs/types.js";
import { loadMemoryContext } from "../memory/context.js";
import type { Database } from "../persistence/database.js";
import { transaction } from "../persistence/transaction.js";
import {
  RULES_PATH,
  SYNC_BRANCH_PREFIX,
  referenceChanges,
  renderRules,
  syncPullRequestBody,
  type RulesFiles,
} from "./content.js";

class SyncCancelled extends Error {}
export type RulesSyncGitHub = Pick<
  GitHubClient,
  | "installationToken"
  | "repositorySnapshot"
  | "rulesSyncFile"
  | "rulesSyncBranch"
  | "findRulesSyncPullRequest"
  | "developmentCommitTree"
  | "createDevelopmentCommit"
  | "createDevelopmentBranch"
  | "updateDevelopmentBranch"
  | "createDevelopmentPullRequest"
  | "updateRulesSyncPullRequest"
>;

export function createRulesSyncProcessor(
  config: Config,
  database: Database,
  github: RulesSyncGitHub = new GitHubClient(config.appId, config.privateKey),
) {
  return async (job: RulesSyncJob) => {
    const controller = new AbortController(),
      signal = controller.signal;
    database.registerReviewAbort(job, controller);
    // 每次对外写入及结果保存均持有任务租约行锁，旧 worker 不能与接手者同时推进分支。
    const owned = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await database.pool.connect();
      try {
        return await transaction(client, async () => {
          signal.throwIfAborted();
          const repo = await client.query(
            "SELECT * FROM repositories WHERE id=$1 AND rules_sync_enabled AND enabled AND revoked_at IS NULL FOR SHARE",
            [job.repositoryId],
          );
          const lease = await client.query(
            "SELECT 1 FROM jobs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>now() AND cancel_requested IS NULL FOR SHARE",
            [job.id, job.leaseToken],
          );
          if (!lease.rowCount || !repo.rowCount || !config.allowedRepositories.has(job.repository.toLowerCase()))
            throw new SyncCancelled("规则同步已关闭、仓库未授权或执行租约失效");
          return operation(client);
        });
      } finally {
        client.release();
      }
    };
    const record = (status: "pr" | "unchanged" | "failed", url: string | null, error: string | null = null) =>
      owned((client) =>
        client.query(
          "UPDATE repositories SET rules_sync_at=now(),rules_sync_status=$2,rules_sync_pr_url=$3,rules_sync_error=$4 WHERE id=$1",
          [job.repositoryId, status, url, error],
        ),
      );
    try {
      await owned(async () => {});
      const token = await github.installationToken(job.installationId, signal);
      const snapshot = await github.repositorySnapshot(token, job.repository, job.repositoryId, signal);
      job.headSha = snapshot.headSha;
      const context = await loadMemoryContext(database.pool, job.repositoryId, { text: "" }, Number.MAX_SAFE_INTEGER);
      // worker 可以不配置 OAuth；有管理地址时提供链接，否则保留“到管理页修改”的说明。
      const managementUrl = config.githubOAuthCallbackUrl
        ? `${new URL(config.githubOAuthCallbackUrl).origin}/#rules?repo=${job.repositoryId}`
        : undefined;
      const content = renderRules(context.full, managementUrl);
      const files = async (sha: string): Promise<RulesFiles> =>
        Object.fromEntries(
          await Promise.all(
            [RULES_PATH, "AGENTS.md", "CLAUDE.md"].map(async (path) => [
              path,
              await github.rulesSyncFile(token, job.repository, sha, path, signal),
            ]),
          ),
        );
      const defaults = await files(snapshot.headSha);
      let pr = await github.findRulesSyncPullRequest(token, job.repository, signal);
      if (!pr) {
        const defaultTarget = { [RULES_PATH]: content, ...referenceChanges(defaults, defaults) };
        if (Object.entries(defaultTarget).every(([path, text]) => defaults[path] === text)) {
          await record("unchanged", null);
          job.status = "succeeded";
          return;
        }
      }
      const branch = pr?.head.ref ?? `${SYNC_BRANCH_PREFIX}${job.id.slice(0, 8)}`;
      let sha = pr?.head.sha ?? (await github.rulesSyncBranch(token, job.repository, branch, signal));
      const branchExists = sha !== null;
      // 已有分支可能是上次提交成功、开 PR 前中断的结果；按实际内容核对后复用。
      sha ??= snapshot.headSha;
      const current = sha === snapshot.headSha ? defaults : await files(sha);
      const target = { [RULES_PATH]: content, ...referenceChanges(defaults, current) };
      const changes = Object.entries(target)
        .filter(([path, text]) => current[path] !== text)
        .map(([path, text]) => ({ path, content: text, mode: "100644" }));
      const body = syncPullRequestBody(defaults[RULES_PATH] ?? "", content);
      if (pr && !changes.length) {
        await record("pr", pr.html_url);
        job.status = "succeeded";
        return;
      }
      if (changes.length) {
        // 先改说明再推进分支。若推进后中断，重试看到文件相同即可零写入结束。
        if (pr && pr.body !== body)
          await owned(() => github.updateRulesSyncPullRequest(token, job.repository, pr!.number, body, signal));
        const tree = await github.developmentCommitTree(token, job.repository, sha, signal);
        const commit = await owned(() =>
          github.createDevelopmentCommit(
            token,
            job.repository,
            { sha: sha!, tree },
            changes,
            "chore: sync project rules",
            signal,
          ),
        );
        await owned(() =>
          branchExists
            ? github.updateDevelopmentBranch(token, job.repository, branch, commit, signal)
            : github.createDevelopmentBranch(token, job.repository, branch, commit, signal),
        );
      }
      if (!pr) {
        // PR 创建超时或 worker 中断后的重试也走这次远端核对，包括已经被人关闭的 PR。
        pr = await github.findRulesSyncPullRequest(token, job.repository, signal, branch);
        if (!pr) {
          const created = await owned(() =>
            github.createDevelopmentPullRequest(
              token,
              job.repository,
              {
                head: branch,
                base: snapshot.defaultBranch,
                title: "chore: 同步项目适用规则",
                body,
              },
              signal,
            ),
          );
          await record("pr", `https://github.com/${job.repository}/pull/${created.number}`);
          job.status = "succeeded";
          return;
        }
      }
      await record("pr", pr.html_url);
      job.status = "succeeded";
    } catch (error) {
      if (error instanceof SyncCancelled || signal.aborted) {
        job.status = "cancelled";
        return;
      }
      // 保存本次失败供管理页查看，同时交还执行器按现有错误分类重试。
      try {
        await record("failed", null, (error as Error).message);
      } catch (recordError) {
        if (!(recordError instanceof SyncCancelled)) throw recordError;
      }
      throw error;
    } finally {
      database.unregisterReviewAbort(job);
    }
  };
}
