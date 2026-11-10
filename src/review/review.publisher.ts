import { createHash } from "node:crypto";
import { redactSecrets } from "../health/secrets.js";
import type { Config } from "../config/config.js";
import { GitHubApiError, GitHubClient } from "../github/client.js";
import type { Finding, ReviewResult, StoredFinding } from "./types.js";
import type { ReviewJob } from "../jobs/types.js";
import type { AgentUsage } from "./agent.js";
import { inlineBody, reviewBody } from "./presentation.js";
import { log } from "../logging.js";

export interface PublicationStore {
  beginPublication(
    job: ReviewJob,
    fingerprint: string,
  ): Promise<{ status: string; github_review_id?: string; github_review_url?: string; inserted?: boolean }>;
  finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain"): Promise<void>;
  isRepositoryEnabled?(repositoryId: number): Promise<boolean>;
  jobUsage?(jobId: string): Promise<import("./agent.js").AgentUsage>;
  getRepositoryConfig?(repositoryId: number): Promise<
    | {
        enabled: boolean;
        includePaths: string[];
        excludePaths: string[];
        outputLanguage: string;
        budgetTokens: number;
      }
    | undefined
  >;
  saveReviewResult?(job: ReviewJob, result: ReviewResult): Promise<void>;
  saveFindings?(job: ReviewJob, findings: Finding[], inline: Set<Finding>): Promise<StoredFinding[]>;
  getOpenFindings?(job: ReviewJob): Promise<StoredFinding[]>;
  bindFindings?(job: ReviewJob, reviewId: number, comments: Array<{ id: number; body: string }>): Promise<number>;
}

type PublishedReview = { id: number; html_url: string };

// 总评末尾的隐藏标记，用于在 GitHub 上认出本服务为同一 PR/head 发过的 Review。
const reviewMarker = (fingerprint: string) => `<!-- pi-review:${fingerprint} -->`;

async function findPublishedReview(
  github: GitHubClient,
  token: string,
  job: ReviewJob,
  fingerprint: string,
): Promise<PublishedReview | undefined> {
  const reviews = await github.getReviews(token, job.repository, job.prNumber);
  return reviews.find((review) => review.commit_id === job.headSha && review.body?.includes(reviewMarker(fingerprint)));
}

async function markUncertain(publications: PublicationStore | undefined, job: ReviewJob) {
  job.status = "uncertain";
  await publications?.finishPublication(job, "uncertain");
}

export async function publishReview(
  config: Config,
  github: GitHubClient,
  publications: PublicationStore | undefined,
  job: ReviewJob,
  token: string,
  controller: AbortController,
  review: { result: ReviewResult; model: string; durationMs: number; usage: AgentUsage },
  stored: StoredFinding[],
  publishedResult: ReviewResult,
) {
  const detailsUrl = config.githubOAuthCallbackUrl
    ? new URL(config.githubOAuthCallbackUrl).origin + "/#reviews/" + job.id
    : undefined;
  const current = await github.getPullRequest(token, job.repository, job.prNumber);
  controller.signal.throwIfAborted();
  if (
    current.state !== "open" ||
    current.draft ||
    current.head.sha !== job.headSha ||
    !config.allowedRepositories.has(job.repository.toLowerCase()) ||
    (publications?.isRepositoryEnabled && !(await publications.isRepositoryEnabled(job.repositoryId)))
  ) {
    job.status = "superseded";
    return;
  }
  const fingerprint = createHash("sha256")
    .update(`${job.repositoryId}:${job.prNumber}:${job.headSha}:COMMENT`)
    .digest("hex");
  const prior = await publications?.beginPublication(job, fingerprint);
  if (prior?.status === "published") {
    job.reviewId = Number(prior.github_review_id);
    job.reviewUrl = prior.github_review_url;
    return;
  }
  const pending = stored.filter(
    (finding) => finding.bindingStatus === "pending" && finding.path && finding.line && finding.side,
  );
  const comments = [...new Map(pending.map((finding) => [finding.id, finding])).values()].map((finding) => ({
    path: finding.path!,
    line: finding.line!,
    side: finding.side!,
    body: redactSecrets(inlineBody(job, finding, detailsUrl)),
  }));

  // 上次发布中断（进程退出）或结果不明：先查 GitHub 上是否已有这次的 Review，有就直接记为已发布。
  if (prior?.inserted === false && (prior.status === "pending" || prior.status === "uncertain")) {
    let existing: PublishedReview | undefined;
    try {
      existing = await findPublishedReview(github, token, job, fingerprint);
    } catch (error) {
      await markUncertain(publications, job);
      throw new Error("GitHub Review 发布结果待核对：无法查询已有 Review", { cause: error });
    }
    if (existing) return recordPublished(github, publications, job, token, existing, comments.length, review);
  }

  await publications?.saveReviewResult?.(job, publishedResult);
  controller.signal.throwIfAborted();
  let published: PublishedReview;
  try {
    const body =
      redactSecrets(reviewBody(job, publishedResult, job.status === "partial", detailsUrl)) +
      "\n\n" +
      reviewMarker(fingerprint);
    published = await github.createReview(token, job, body, comments);
  } catch (error) {
    // 4xx：GitHub 明确拒绝，没有创建。
    if (error instanceof GitHubApiError && error.status < 500) {
      await publications?.finishPublication(job, "failed");
      throw error;
    }
    // 5xx 或网络中断：GitHub 可能已经创建了 Review，先查一次再决定。
    let existing: PublishedReview | undefined;
    try {
      existing = await findPublishedReview(github, token, job, fingerprint);
    } catch {
      await markUncertain(publications, job);
      throw error;
    }
    if (!existing) {
      // 收到 5xx 响应说明请求已处理完，查不到即未创建，可以重试；网络中断时请求可能还在处理，不能重发。
      if (error instanceof GitHubApiError) await publications?.finishPublication(job, "failed");
      else await markUncertain(publications, job);
      throw error;
    }
    published = existing;
  }
  await recordPublished(github, publications, job, token, published, comments.length, review);
}

async function recordPublished(
  github: GitHubClient,
  publications: PublicationStore | undefined,
  job: ReviewJob,
  token: string,
  published: PublishedReview,
  commentCount: number,
  review: { model: string; durationMs: number; usage: AgentUsage },
) {
  job.reviewId = published.id;
  job.reviewUrl = published.html_url;
  await publications?.finishPublication(job, "published");
  if (commentCount && publications?.bindFindings) {
    try {
      const reviewComments = await github.getReviewCommentsForReview(token, job.repository, job.prNumber, published.id);
      const bound = await publications.bindFindings(job, published.id, reviewComments);
      if (bound !== commentCount)
        log("error", "finding_binding_incomplete", { jobId: job.id, expected: commentCount, bound });
    } catch (error) {
      await publications.bindFindings(job, published.id, []).catch(() => undefined);
      log("error", "finding_binding_incomplete", { jobId: job.id, reviewId: published.id }, error);
    }
  }
  log("info", "review_published", {
    jobId: job.id,
    deliveryId: job.deliveryId,
    repositoryId: job.repositoryId,
    prNumber: job.prNumber,
    headSha: job.headSha,
    reviewId: job.reviewId,
    model: review.model,
    durationMs: review.durationMs,
    usage: review.usage,
  });
}
