import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Status, statusLabels } from "../components/common/status-badge.js";
import { ReviewRow, SeverityLegend } from "../features/reviews/review-row.js";
import { dateText, numberText, percentText, relativeTime } from "../format.js";
import { Empty, ListSkeleton } from "../components/common/empty-state.js";
import { ChevronRight } from "../components/common/icons.js";
import type { Job, Memory, Overview, Repository as Repo } from "../types.js";

// 意见回复后的去向；顺序即条形图和图例的顺序。
const QUALITY_PARTS: Array<[key: "fixed" | "withdrawn" | "exception" | "discussing" | "open", label: string]> = [
  ["fixed", "已修复"],
  ["withdrawn", "误判撤回"],
  ["exception", "认可为例外"],
  ["discussing", "仍在讨论"],
  ["open", "没有回应"],
];

function ReviewQuality({ quality }: { quality: Overview["quality"] }) {
  const parts = QUALITY_PARTS.map(([key, label]) => ({ key, label, count: quality[key] }));
  return (
    <section className="page-section">
      <div className="section-title">
        <h3>审查质量 · 近 {quality.days} 天</h3>
        <a href="#settings/discussions">查看讨论</a>
      </div>
      {!quality.findings ? (
        <Empty>
          近 {quality.days} 天{quality.reviews ? `完成了 ${numberText(quality.reviews)} 次审查，` : ""}
          还没有发出审查意见。
        </Empty>
      ) : (
        <div className="panel quality">
          <p className="quality-lead">
            {numberText(quality.reviews)} 次审查，发出 <strong>{numberText(quality.findings)}</strong> 条意见
          </p>
          <div className="quality-bar" aria-hidden="true">
            {parts
              .filter((part) => part.count > 0)
              .map((part) => (
                <span className={`quality-${part.key}`} style={{ flexGrow: part.count }} key={part.key} />
              ))}
          </div>
          <dl className="quality-parts">
            {parts.map((part) => (
              <div key={part.key}>
                <dt>
                  <span className={`quality-dot quality-${part.key}`} aria-hidden="true" />
                  {part.label}
                </dt>
                <dd>
                  {numberText(part.count)}
                  <small>{percentText(part.count, quality.findings)}</small>
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted quality-note">
            按开发者在评论里的回复统计。没回复就直接改掉的问题算在“没有回应”里，所以实际修复数只会更多。
          </p>
        </div>
      )}
    </section>
  );
}

export function OverviewPage({
  repositories,
  memories,
  login,
}: {
  repositories: Repo[];
  memories: Memory[];
  login: string;
}) {
  const pending = memories.filter((item) => item.status === "CANDIDATE").length,
    active = memories.filter((item) => item.status === "ACTIVE" || item.activeVersion).length;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [health, setHealth] = useState<Job[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const failed = (cause: unknown) => {
      if (!controller.signal.aborted) setError(messageOf(cause));
    };
    void api<Overview>("/api/overview", { signal: controller.signal }).then(setOverview).catch(failed);
    void api<{ items: Job[] }>("/api/health", { signal: controller.signal })
      .then((value) => setHealth(value.items))
      .catch(failed);
    return () => controller.abort();
  }, []);
  const latestHealth = new Map<number, Job>();
  for (const job of health ?? []) if (!latestHealth.has(job.repository_id)) latestHealth.set(job.repository_id, job);
  const enabled = repositories.filter((repo) => repo.enabled).length;
  const attention = overview?.attention ?? 0;
  return (
    <section className="overview">
      <div className="page-head">
        <h2>概览</h2>
        <p className="muted">
          {login} · {numberText(enabled)} 个仓库已启用 · {numberText(active)} 条规则生效中
          {overview && ` · 近 7 天 ${numberText(overview.reviewsThisWeek)} 次 PR 审查`}
        </p>
      </div>

      <section className="page-section">
        <div className="section-title">
          <h3>需要处理</h3>
        </div>
        {!pending && overview && !attention ? (
          <Empty>没有需要处理的事。</Empty>
        ) : (
          <div className="list">
            <a className="list-row" href="#rules/pending">
              <Status value={pending ? "CANDIDATE" : "ACTIVE"} icon />
              <span className="row-title">待确认的规则</span>
              <span className={`col-count${pending ? " count-attention" : ""}`}>{numberText(pending)}</span>
              <ChevronRight className="row-chevron" />
            </a>
            <a className="list-row" href="#settings/runs">
              <Status value={attention ? "failed" : "succeeded"} icon />
              <span className="row-title">近 7 天需要排查的任务</span>
              <span className={`col-count${attention ? " count-danger" : ""}`}>
                {overview ? numberText(attention) : "—"}
              </span>
              <ChevronRight className="row-chevron" />
            </a>
          </div>
        )}
      </section>

      <section className="page-section">
        <div className="section-title">
          <h3>最近 PR 审查</h3>
          <span className="section-title-end">
            <SeverityLegend />
            <a href="#reviews">查看全部</a>
          </span>
        </div>
        {!overview ? (
          error ? (
            <Empty>没有读到审查记录。</Empty>
          ) : (
            <ListSkeleton />
          )
        ) : !overview.latestReviews.length ? (
          <Empty>还没有审查记录。接入的仓库有新 PR 时会出现在这里。</Empty>
        ) : (
          <div className="list">
            {overview.latestReviews.map((job) => (
              <ReviewRow job={job} key={job.id} />
            ))}
          </div>
        )}
      </section>

      {overview && <ReviewQuality quality={overview.quality} />}

      <section className="page-section">
        <div className="section-title">
          <h3>仓库健康检查</h3>
          <a href="#settings/health">查看与管理</a>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : health === null ? (
          <ListSkeleton rows={2} />
        ) : !health.length ? (
          <Empty action={<a href="#settings/health">去运行一次</a>}>还没有健康检查记录。</Empty>
        ) : (
          <div className="list">
            {[...latestHealth.values()].slice(0, 3).map((job) => (
              <a className="list-row" href={`#health/${job.id}`} key={job.id}>
                <Status value={job.status} icon />
                <span className="row-title health-repo" title={job.repository}>
                  {job.repository}
                </span>
                <span className="row-meta health-conclusion">
                  {job.has_report
                    ? job.status === "partial"
                      ? "覆盖不足"
                      : job.finding_count
                        ? "有建议需要查看"
                        : "已检查范围未产出意见"
                    : (statusLabels[job.status] ?? "尚无有效报告")}
                  {job.has_report ? ` · ${numberText(job.finding_count)} 条意见` : ""}
                </span>
                <time className="row-meta col-time" dateTime={job.created_at} title={dateText(job.created_at)}>
                  {relativeTime(job.created_at)}
                </time>
              </a>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
