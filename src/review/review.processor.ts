import { readBaseFile, readWorkspaceFile, withWorkspace } from "../workspace/workspace.js";
import { GitHubClient } from "../github/client.js";
import { BudgetError, runAgentReview, TimeoutError, type AgentUsage } from "./agent.js";
import { DEFAULT_BUDGET_TOKENS } from "../pi/types.js";
import type { Config } from "../config/config.js";
import type { ReviewJob } from "../jobs/types.js";
import type { ReviewResult } from "./types.js";
import type { MemoryService } from "../memory/memory.service.js";
import { matchesGlob } from "node:path";
import { diffLines, linkRepeats, normalizeFindingLocation } from "./finding.js";
import { displayFinding } from "./presentation.js";
import { publishReview, type PublicationStore } from "./review.publisher.js";
import { checkDependencyChanges } from "./dependency-check.js";
import { checkAddedSecrets, redactFinding } from "./secret-check.js";
import { scanChangedFiles, uncoveredRuleFindings } from "./rule-check.js";
import { redactSecrets } from "../health/secrets.js";
import { OsvClient } from "../health/vulnerabilities.js";

export function createReviewProcessor(
  config: Config,
  github = new GitHubClient(config.appId, config.privateKey),
  publications?: PublicationStore,
  memories?: MemoryService,
  execute = runAgentReview,
  osv = new OsvClient(),
) {
  return async (job: ReviewJob): Promise<void> => {
    if (!config.allowedRepositories.has(job.repository.toLowerCase())) {
      job.status = "cancelled";
      return;
    }
    const token = await github.installationToken(job.installationId);
    const repositoryConfig = await publications?.getRepositoryConfig?.(job.repositoryId);
    const initial = await github.getPullRequest(token, job.repository, job.prNumber);
    if (
      !config.allowedRepositories.has(job.repository.toLowerCase()) ||
      repositoryConfig?.enabled === false ||
      initial.state !== "open" ||
      initial.draft ||
      initial.head.sha !== job.headSha
    ) {
      job.status = initial.head.sha !== job.headSha ? "superseded" : "cancelled";
      return;
    }
    const allFiles = await github.getFiles(token, job.repository, job.prNumber);
    const files = allFiles.filter(
      (file) =>
        (!repositoryConfig?.includePaths.length ||
          repositoryConfig.includePaths.some((pattern) => matchesGlob(file.filename, pattern))) &&
        !repositoryConfig?.excludePaths.some((pattern) => matchesGlob(file.filename, pattern)),
    );
    if (!files.length && allFiles.length) {
      job.status = "cancelled";
      return;
    }
    if (files.length === 0) throw new Error("PR 没有可审查文件");
    const budgetTokens = await remainingBudget(
      publications,
      job.id,
      repositoryConfig?.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
    );
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(new TimeoutError()), config.agentTimeoutMs);
    const database = publications as import("../persistence/database.js").Database | undefined;
    database?.registerReviewAbort?.(job, controller);
    let singleRunId: string | undefined, agentUsage: AgentUsage | undefined;
    try {
      await withWorkspace(job.cloneUrl, token, job.baseSha, job.headSha, async (root) => {
        const recalled =
          (await memories?.retrieve(job.repositoryId, {
            paths: files.map((file) => file.filename),
            text: recallText(job, files),
          })) ?? [];
        const previous = (await publications?.getOpenFindings?.(job)) ?? [];
        const previousFindings = previous.map((finding) => {
          const display = displayFinding(finding);
          return { id: finding.id, path: finding.path, title: display.title, reason: display.reason };
        });
        // 和模型审查并行；锁文件没改动时不发任何请求。
        const dependencyCheck = config.vulnerabilityScan
          ? checkDependencyChanges(root, job.baseSha, files, osv, previous, controller.signal)
          : Promise.resolve({ findings: [], limitations: [], audit: undefined });
        dependencyCheck.catch(() => undefined);
        // 规则扫描的结果要交给模型确认，所以必须在模型之前跑完。
        const rules = config.sastScan
          ? await scanChangedFiles(root, files, config.semgrepPath, controller.signal)
          : { hits: [], limitations: [] };
        // 仓库 AGENTS.md 取目标分支版本：PR 里改动的说明不能影响对这个 PR 的审查。
        const repositoryInstructions = await readBaseFile(root, job.baseSha, "AGENTS.md");
        singleRunId = await database?.startAgentRun?.(job.id, "general_review", budgetTokens, config.agentTimeoutMs);
        const agentRunId = singleRunId;
        const review = await execute({
          root,
          provider: config.modelProvider,
          modelName: config.modelName,
          apiKey: config.modelApiKey,
          endpoint: config.modelEndpoint,
          timeoutMs: config.agentTimeoutMs,
          title: job.title,
          body: job.body,
          baseSha: job.baseSha,
          headSha: job.headSha,
          changedFiles: files,
          memories: recalled,
          previousFindings,
          ruleHits: rules.hits,
          outputLanguage: repositoryConfig?.outputLanguage,
          budgetTokens,
          repositoryInstructions,
          signal: controller.signal,
          onSession: (session) =>
            database?.saveAgentSession?.({ jobId: job.id, agentRunId, role: "general_review" }, session),
        });
        agentUsage = review.usage;
        controller.signal.throwIfAborted();
        const dependencies = await dependencyCheck;
        const secrets = await checkAddedSecrets(root, files, previous, controller.signal);
        for (const finding of review.result.findings) redactFinding(finding);
        review.result.summary = redactSecrets(review.result.summary);
        review.result.findings.push(
          ...uncoveredRuleFindings(rules.hits, review.result.findings, previous),
          ...secrets.findings,
          ...dependencies.findings,
        );
        review.result.limitations.push(...rules.limitations, ...secrets.limitations);
        review.result.limitations.push(...dependencies.limitations);
        if (dependencies.audit) review.result.dependencyAudit = dependencies.audit;
        if (files.some((file) => file.patch === undefined))
          review.result.limitations.push("GitHub 未提供部分文件的 patch，相关内容只能按 Workspace 源码检查。");
        const changed = new Set(files.map((file) => file.filename));
        const locations = review.result.findings.flatMap((finding) => [
          finding,
          ...(finding.relatedLocations ?? []),
          ...(finding.candidates ?? []),
        ]);
        for (const path of new Set(locations.flatMap((location) => (location.path ? [location.path] : [])))) {
          if (!changed.has(path)) throw new Error(`finding 路径不属于 PR: ${path}`);
          await readWorkspaceFile(root, path);
        }
        validateMemoryReferences(review.result, recalled, job.repositoryId);
        const validDiffLines = diffLines(files);
        for (const location of locations) normalizeFindingLocation(location, validDiffLines);
        review.result.resolvedPrevious = linkRepeats(review.result.findings, previous);
        // 公开仓库的 PR 评论所有人可见，修复前不能把高危安全问题的细节写出来；查不到可见性时按公开处理。
        const privateRepository = await Promise.resolve()
          .then(() => github.isPrivateRepository(token, job.repository))
          .catch(() => false);
        if (!privateRepository)
          for (const finding of review.result.findings)
            if (finding.category === "security" && ["high", "critical"].includes(finding.severity))
              finding.restricted = true;
        // 和之前同一个问题的不再发行内评论，只在总评里指回原评论。
        const inline = new Set(
          review.result.findings.filter(
            (finding) => !finding.repeatOf && !finding.restricted && normalizeFindingLocation(finding, validDiffLines),
          ),
        );
        if (singleRunId) {
          await database!.finishAgentRun(singleRunId, {
            status: "succeeded",
            model: review.model,
            usage: review.usage,
            coverage: review.result.coverage,
            limitations: review.result.limitations,
          });
          singleRunId = undefined;
        }
        const stored = (await publications?.saveFindings?.(job, review.result.findings, inline)) ?? [];
        const publishedResult = {
          ...review.result,
          findings: stored.length ? [...new Map(stored.map((f) => [f.id, f])).values()] : review.result.findings,
        };
        await publishReview(config, github, publications, job, token, controller, review, stored, publishedResult);
      });
    } catch (error) {
      if (singleRunId)
        await database!.finishAgentRun(singleRunId, {
          status: controller.signal.aborted ? "cancelled" : error instanceof TimeoutError ? "timeout" : "failed",
          model: config.modelName,
          usage: (error as { usage?: AgentUsage })?.usage ?? agentUsage,
          error: error instanceof Error ? error.message : String(error),
        });
      if (controller.signal.reason === "superseded" || controller.signal.reason === "cancelled") {
        job.status = controller.signal.reason;
        return;
      }
      if (error instanceof TimeoutError) job.status = "timeout";
      throw error;
    } finally {
      clearTimeout(timer);
      database?.unregisterReviewAbort?.(job);
    }
  };
}

// 预算按任务算：重试和"新提交后重排"沿用同一个任务，之前尝试用掉的 Token 要扣掉。
export async function remainingBudget(
  store: { jobUsage?: (jobId: string) => Promise<AgentUsage> } | undefined,
  jobId: string,
  budget: number,
) {
  const prior = await store?.jobUsage?.(jobId);
  const remaining = budget - (prior ? prior.totalTokens + prior.unreportedTokens : 0);
  if (remaining <= 0) throw new BudgetError("这个任务之前的尝试已用完 Token 预算，不再重试");
  return remaining;
}

// 规则召回只看标题、描述、文件名和新增行；上下文行和删除行会带来大量无关词。
function recallText(job: ReviewJob, files: Array<{ filename: string; patch?: string }>) {
  const added = files.flatMap((file) => [
    file.filename,
    ...(file.patch ?? "").split("\n").filter((line) => /^\+(?!\+\+)/.test(line)),
  ]);
  return [job.title, job.body, ...added].join("\n");
}

export function validateMemoryReferences(
  result: ReviewResult,
  recalled: import("../memory/types.js").MemoryRecord[],
  repositoryId: number,
) {
  const recalledById = new Map(recalled.map((memory) => [`${memory.id}:${memory.version}`, memory]));
  for (const finding of result.findings.flatMap((item) => [item, ...(item.candidates ?? [])])) {
    if (["team_rule", "memory_conflict"].includes(finding.category) && !finding.memory)
      throw new Error("团队规则 finding 必须绑定 Memory id/version");
    if (!finding.memory) continue;
    const memory = recalledById.get(`${finding.memory.id}:${finding.memory.version}`);
    if (!memory || memory.status !== "ACTIVE" || memory.repositoryId !== repositoryId)
      throw new Error("模型引用了未召回或无效的 Memory");
    finding.memory.source = memory.source;
    finding.memory.title = memory.title;
  }
}
