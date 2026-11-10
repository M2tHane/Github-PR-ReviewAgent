import { useState } from "react";
import { useJobPage } from "../api/jobs.js";
import { Empty } from "../components/common/empty-state.js";
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
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>系统运行记录</h2>
          <p className="muted">保留期内的全部运行，默认显示需要排查的记录。</p>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={failures}
            onChange={(event) => {
              setFailures(event.target.checked);
              setPage(1);
            }}
          />{" "}
          只显示失败或发布待核对
        </label>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && (
          <p className="empty-line" role="status">
            正在加载…
          </p>
        )
      ) : !data.items.length ? (
        <Empty>{failures ? "没有失败或待核对的记录。" : "暂无运行记录。"}</Empty>
      ) : (
        // 每条记录一个整行的块：执行过程的时间线展开后用整行宽度，不再挤在表格的一列里。
        <div className="run-list" aria-busy={loading}>
          {data.items.map((job) => (
            <article className="run-row" key={job.id}>
              <div className="run-head">
                <div className="run-main">
                  <h3>
                    {jobLabels[job.job_type] ?? job.job_type}
                    <span className="run-target">
                      {job.repository} · {job.job_type === "HEALTH_AUDIT" ? "默认分支" : `PR #${job.pr_number}`}
                    </span>
                  </h3>
                  <span className="muted">
                    {dateText(job.created_at)}
                    {job.attempt > 1 ? ` · 第 ${job.attempt} 次尝试` : ""}
                  </span>
                </div>
                <Status value={job.status} />
                <a href={job.job_type === "HEALTH_AUDIT" ? `#health/${job.id}` : `#reviews/${job.id}`}>
                  {job.job_type === "HEALTH_AUDIT" ? "查看健康检查" : "查看详情"}
                </a>
              </div>
              {job.last_error && <p className="error run-error">{job.last_error}</p>}
              <RunDetails runs={job.agent_runs ?? []} />
              <SessionTimeline sessions={job.agent_sessions ?? []} />
            </article>
          ))}
        </div>
      )}
      {data && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} disabled={loading} onPage={setPage} />
      )}
    </section>
  );
}
