import { Status } from "../../components/common/status-badge.js";
import { dateText, numberText, relativeTime } from "../../format.js";
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

// 右侧计数列：三档各占固定宽度，数字上下对齐；0 不显示。未完成的审查在这里显示状态文字。
export function ReviewOutcome({ job }: { job: Job }) {
  if (!["succeeded", "partial"].includes(job.status))
    return (
      <span className="outcome outcome-text">
        <Status value={job.status} plain />
      </span>
    );
  const tiers = severityTiers(job.new_severity_counts);
  const repeats = Number(job.repeat_count ?? 0);
  if (!tiers.some((tier) => tier.count > 0) && !repeats)
    return (
      <span className="outcome outcome-text">
        {job.status === "partial" ? (
          <Status value="partial" plain />
        ) : (
          <span className="outcome-clean">没有发现问题</span>
        )}
      </span>
    );
  return (
    <span className="outcome">
      {tiers.map((tier) => (
        <span
          className={`outcome-cell sev-count sev-${tier.tone}`}
          key={tier.tone}
          title={`${tier.label} ${tier.count} 个`}
        >
          {tier.count > 0 && (
            <>
              {numberText(tier.count)}
              <span className="sr-only"> 个{tier.label}</span>
            </>
          )}
        </span>
      ))}
      <span className="outcome-cell outcome-repeat">{repeats > 0 && `仍未解决 ${numberText(repeats)}`}</span>
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

// 一次 PR 审查的单行：仓库 #编号｜标题｜（SHA）｜计数列｜时间。编号加粗且永远完整，仓库名过长时截断。
// showSha 只用于 PR 审查页的完整列表。
export function ReviewRow({ job, showSha = false }: { job: Job; showSha?: boolean }) {
  const title = job.payload?.title;
  return (
    <a className="list-row review-row" href={`#reviews/${job.id}`}>
      <span className="pr-ref col-pr-ref" title={`${job.repository} #${job.pr_number}`}>
        <span className="pr-ref-repo">{job.repository}</span>
        <strong className="pr-ref-number">#{job.pr_number}</strong>
      </span>
      <span className={`row-title${title ? "" : " row-title-empty"}`} title={title || undefined}>
        {title || "（没有标题）"}
      </span>
      {showSha && <code className="row-meta col-sha">{job.target_sha.slice(0, 7)}</code>}
      <ReviewOutcome job={job} />
      <time className="row-meta col-time" dateTime={job.created_at} title={dateText(job.created_at)}>
        {relativeTime(job.created_at)}
      </time>
    </a>
  );
}
