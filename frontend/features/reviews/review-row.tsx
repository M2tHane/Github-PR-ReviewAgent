import { Status } from "../../components/common/status-badge.js";
import { dateText, relativeTime } from "../../format.js";
import type { Job } from "../../types.js";

// 和 GitHub 评论一致的三档：必须改 / 建议改 / 可以不改。
function severityTiers(counts: Record<string, number> | undefined) {
  const value = counts ?? {};
  return [
    { tone: "must", label: "必须改", count: (value.critical ?? 0) + (value.high ?? 0) },
    { tone: "should", label: "建议改", count: value.medium ?? 0 },
    { tone: "may", label: "可以不改", count: value.low ?? 0 },
  ];
}

export function ReviewOutcome({ job }: { job: Job }) {
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

export function SeverityLegend() {
  return (
    <span className="legend" aria-hidden="true">
      <span className="sev sev-must">必须改</span>
      <span className="sev sev-should">建议改</span>
      <span className="sev sev-may">可以不改</span>
    </span>
  );
}

// 一次 PR 审查的列表行；showSha 用于同一个 PR 有多次审查的完整列表。
export function ReviewRow({ job, showSha = false }: { job: Job; showSha?: boolean }) {
  return (
    <a className="review-row" href={`#reviews/${job.id}`}>
      <div className="review-main">
        <h4>{job.payload?.title || `PR #${job.pr_number}`}</h4>
        <span className="review-meta">
          <span className="review-repo">{job.repository}</span>
          <span>#{job.pr_number}</span>
          {showSha && <code>{job.target_sha.slice(0, 7)}</code>}
          <time dateTime={job.created_at} title={dateText(job.created_at)}>
            {relativeTime(job.created_at)}
          </time>
        </span>
      </div>
      <ReviewOutcome job={job} />
    </a>
  );
}
