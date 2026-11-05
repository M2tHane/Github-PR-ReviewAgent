import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Status, statusLabels } from "../components/common/status-badge.js";
import { dateText, relativeTime } from "../format.js";
import type { Job, Memory, Repository as Repo } from "../types.js";

const WEEK_MS = 7 * 86_400_000;

// 和 GitHub 评论一致的三档：必须改 / 建议改 / 可以不改。
function severityTiers(counts: Record<string, number> | undefined) {
  const value = counts ?? {};
  return [
    { tone: "must", label: "必须改", count: (value.critical ?? 0) + (value.high ?? 0) },
    { tone: "should", label: "建议改", count: value.medium ?? 0 },
    { tone: "may", label: "可以不改", count: value.low ?? 0 },
  ];
}

function ReviewOutcome({ job }: { job: Job }) {
  if (!["succeeded", "partial"].includes(job.status)) return <Status value={job.status} />;
  const tiers = severityTiers(job.new_severity_counts).filter((tier) => tier.count > 0);
  const repeats = Number(job.repeat_count ?? 0);
  const partial = job.status === "partial" ? <Status value="partial" /> : null;
  if (!tiers.length && !repeats) return partial ?? <span className="outcome-clean">没有发现问题</span>;
  return (
    <span className="outcome">
      {partial}
      {tiers.map((tier) => (
        <span className={`sev sev-${tier.tone}`} key={tier.tone} title={`${tier.label} ${tier.count} 个`}>
          {tier.count}
          <span className="sr-only"> 个{tier.label}</span>
        </span>
      ))}
      {repeats > 0 && <span className="outcome-repeat">仍未解决 {repeats}</span>}
    </span>
  );
}

export function OverviewPage({
  repositories,
  memories,
  jobs,
  login,
}: {
  repositories: Repo[];
  memories: Memory[];
  jobs: Job[];
  login: string;
}) {
  const pending = memories.filter((item) => item.status === "CANDIDATE").length,
    active = memories.filter((item) => item.status === "ACTIVE" || item.activeVersion).length;
  const failures = jobs.filter((job) => ["failed", "timeout", "uncertain"].includes(job.status));
  const weekStart = Date.now() - WEEK_MS;
  const reviewsThisWeek = jobs.filter(
    (job) => job.job_type === "PR_REVIEW" && new Date(job.created_at).getTime() >= weekStart,
  ).length;
  const latestReviews = new Map<string, Job>();
  for (const job of jobs)
    if (job.job_type === "PR_REVIEW" && !latestReviews.has(`${job.repository}/${job.pr_number}`))
      latestReviews.set(`${job.repository}/${job.pr_number}`, job);
  const reviews = [...latestReviews.values()].slice(0, 8);
  const [health, setHealth] = useState<Job[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Job[] }>("/api/health", { signal: controller.signal })
      .then((value) => setHealth(value.items))
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      });
    return () => controller.abort();
  }, []);
  const latestHealth = new Map<number, Job>();
  for (const job of health ?? []) if (!latestHealth.has(job.repository_id)) latestHealth.set(job.repository_id, job);
  const enabled = repositories.filter((repo) => repo.enabled).length;
  return (
    <section className="overview">
      <div className="section-head">
        <div>
          <h2>概览</h2>
          <p className="muted">
            {login}，{enabled} 个仓库已启用
          </p>
        </div>
      </div>

      <div className="stats">
        <a className={`stat${pending ? " stat-attention" : ""}`} href="#rules/pending">
          <strong>{pending}</strong>
          <span>待确认的规则</span>
        </a>
        <a className={`stat${failures.length ? " stat-danger" : ""}`} href="#settings/runs">
          <strong>{failures.length}</strong>
          <span>需要排查的任务</span>
        </a>
        <a className="stat" href="#rules">
          <strong>{active}</strong>
          <span>生效中的规则</span>
        </a>
        <div className="stat">
          <strong>{reviewsThisWeek}</strong>
          <span>近 7 天 PR 审查</span>
        </div>
      </div>

      <section className="overview-section">
        <div className="subhead">
          <h3>最近 PR 审查</h3>
          <span className="legend" aria-hidden="true">
            <span className="sev sev-must">必须改</span>
            <span className="sev sev-should">建议改</span>
            <span className="sev sev-may">可以不改</span>
          </span>
        </div>
        {!reviews.length ? (
          <p className="empty-line">还没有审查记录。接入的仓库有新 PR 时会出现在这里。</p>
        ) : (
          <div className="review-list">
            {reviews.map((job) => (
              <a className="review-row" href={`#reviews/${job.id}`} key={job.id}>
                <div className="review-main">
                  <h4>{job.payload?.title || `PR #${job.pr_number}`}</h4>
                  <span className="review-meta">
                    <span className="review-repo">{job.repository}</span>
                    <span>#{job.pr_number}</span>
                    <time dateTime={job.created_at} title={dateText(job.created_at)}>
                      {relativeTime(job.created_at)}
                    </time>
                  </span>
                </div>
                <ReviewOutcome job={job} />
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="overview-section">
        <div className="subhead">
          <h3>仓库健康检查</h3>
          <a href="#settings/health">查看与管理</a>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : health === null ? (
          <p className="empty-line" role="status">
            正在加载…
          </p>
        ) : !health.length ? (
          <p className="empty-line">
            还没有健康检查记录。<a href="#settings/health">去运行一次</a>
          </p>
        ) : (
          <div className="grid">
            {[...latestHealth.values()].slice(0, 3).map((job) => (
              <a className="card health-conclusion" href={`#health/${job.id}`} key={job.id}>
                <span className="muted">{job.repository}</span>
                <h4>
                  {job.has_report
                    ? job.status === "partial"
                      ? "覆盖不足"
                      : job.finding_count
                        ? "有建议需要查看"
                        : "已检查范围未产出意见"
                    : (statusLabels[job.status] ?? "尚无有效报告")}
                </h4>
                <p>
                  {job.has_report
                    ? `${job.finding_count} 条意见 · ${job.status === "partial" ? "仍有未覆盖范围" : "查看建议与依据"}`
                    : "打开记录查看进度或失败原因。"}
                </p>
                <small>{relativeTime(job.created_at)}</small>
              </a>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
