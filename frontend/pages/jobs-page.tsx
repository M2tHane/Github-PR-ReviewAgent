import { useState } from "react";
import { useJobPage } from "../api/jobs.js";
import { Empty, ListSkeleton } from "../components/common/empty-state.js";
import { Pager } from "../components/common/pager.js";
import { RunDetails } from "../components/common/run-details.js";
import { SessionTimeline } from "../components/common/session-timeline.js";
import { Status } from "../components/common/status-badge.js";
import { dateText, jobLabels } from "../format.js";

const PAGE_SIZE = 20;

export function JobsPage() {
  const [failures, setFailures] = useState(true),
    [page, setPage] = useState(1);
  const { data, loading, error } = useJobPage({
    status: failures ? "failed,timeout,uncertain" : undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const filters: Array<[value: boolean, label: string]> = [
    [true, "需要排查"],
    [false, "全部"],
  ];
  return (
    <section>
      <div className="page-head">
        <h2>运行记录</h2>
        <p className="muted">保留期内的全部运行，默认显示需要排查的记录（失败或发布待核对）。</p>
      </div>
      <div className="toolbar">
        <span className="segmented" role="group" aria-label="显示范围">
          {filters.map(([value, label]) => (
            <button
              key={label}
              className={failures === value ? "active" : ""}
              aria-pressed={failures === value}
              onClick={() => {
                setFailures(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && <ListSkeleton />
      ) : !data.items.length ? (
        failures ? (
          <Empty
            action={
              <button className="compact" onClick={() => setFailures(false)}>
                显示全部记录
              </button>
            }
          >
            没有失败或待核对的记录。
          </Empty>
        ) : (
          <Empty>暂无运行记录。</Empty>
        )
      ) : (
        // 每条记录一行；展开后执行过程用整行宽度。失败和待核对默认展开。
        <div className="list run-list" aria-busy={loading}>
          {data.items.map((job) => {
            const link =
              job.job_type === "RULES_SYNC"
                ? { href: `#repositories/${job.repository_id}`, label: "查看同步结果" }
                : job.job_type === "HEALTH_AUDIT"
                  ? { href: `#health/${job.id}`, label: "查看健康检查" }
                  : { href: `#reviews/${job.id}`, label: "查看详情" };
            const firstLine = job.last_error?.split("\n").find((line) => line.trim());
            return (
              <details
                className="run-row"
                key={job.id}
                open={["failed", "timeout", "interrupted", "uncertain"].includes(job.status)}
              >
                <summary>
                  <span className="list-row">
                    <Status value={job.status} icon />
                    <span className="row-title">
                      {jobLabels[job.job_type] ?? job.job_type}
                      <span className="run-target" title={job.repository}>
                        {job.repository} ·{" "}
                        {job.job_type === "HEALTH_AUDIT" || job.job_type === "RULES_SYNC"
                          ? "默认分支"
                          : `PR #${job.pr_number}`}
                      </span>
                    </span>
                    <span className="row-meta col-attempt">{job.attempt > 1 ? `第 ${job.attempt} 次尝试` : ""}</span>
                    <span className="col-status">
                      <Status value={job.status} plain />
                    </span>
                    <time className="row-meta col-date" dateTime={job.created_at}>
                      {dateText(job.created_at)}
                    </time>
                  </span>
                  {firstLine && <span className="run-error-line">{firstLine}</span>}
                </summary>
                <div className="run-body">
                  <a href={link.href}>{link.label}</a>
                  {job.last_error && <pre className="run-error">{job.last_error}</pre>}
                  <RunDetails runs={job.agent_runs ?? []} />
                  <SessionTimeline sessions={job.agent_sessions ?? []} />
                </div>
              </details>
            );
          })}
        </div>
      )}
      {data && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} disabled={loading} onPage={setPage} />
      )}
    </section>
  );
}
