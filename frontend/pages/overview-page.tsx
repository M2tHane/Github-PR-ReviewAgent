import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { statusLabels } from "../components/common/status-badge.js";
import { ReviewRow, SeverityLegend } from "../features/reviews/review-row.js";
import { numberText, percentText, relativeTime } from "../format.js";
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
    <section className="overview-section">
      <div className="subhead">
        <h3>审查质量 · 近 {quality.days} 天</h3>
        <a href="#settings/discussions">查看讨论</a>
      </div>
      {!quality.findings ? (
        <p className="empty-line">
          近 {quality.days} 天{quality.reviews ? `完成了 ${numberText(quality.reviews)} 次审查，` : ""}
          还没有发出审查意见。
        </p>
      ) : (
        <div className="card quality">
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
          <strong>{numberText(pending)}</strong>
          <span>待确认的规则</span>
        </a>
        <a className={`stat${overview?.attention ? " stat-danger" : ""}`} href="#settings/runs">
          <strong>{overview ? numberText(overview.attention) : "—"}</strong>
          <span>近 7 天需要排查的任务</span>
        </a>
        <a className="stat" href="#rules">
          <strong>{numberText(active)}</strong>
          <span>生效中的规则</span>
        </a>
        <a className="stat" href="#reviews">
          <strong>{overview ? numberText(overview.reviewsThisWeek) : "—"}</strong>
          <span>近 7 天 PR 审查</span>
        </a>
      </div>

      <section className="overview-section">
        <div className="subhead">
          <h3>最近 PR 审查</h3>
          <SeverityLegend />
          <a href="#reviews">查看全部 →</a>
        </div>
        {!overview ? (
          <p className="empty-line" role="status">
            {error ? "没有读到审查记录。" : "正在加载…"}
          </p>
        ) : !overview.latestReviews.length ? (
          <p className="empty-line">还没有审查记录。接入的仓库有新 PR 时会出现在这里。</p>
        ) : (
          <div className="review-list">
            {overview.latestReviews.map((job) => (
              <ReviewRow job={job} key={job.id} />
            ))}
          </div>
        )}
      </section>

      {overview && <ReviewQuality quality={overview.quality} />}

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
