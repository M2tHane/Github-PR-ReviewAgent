import { useState } from "react";
import { useJobPage } from "../api/jobs.js";
import type { AgentSessionRow } from "../../src/admin/dto.js";
import { Empty, ListSkeleton } from "../components/common/empty-state.js";
import { Pager } from "../components/common/pager.js";
import { RunDetails } from "../components/common/run-details.js";
import { durationText, SessionSteps, sessionRoleLabel } from "../components/common/session-timeline.js";
import { Status } from "../components/common/status-badge.js";
import { errorReason } from "../error-reason.js";
import { dateText, jobLabels, numberText } from "../format.js";
import type { Job } from "../types.js";

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
        // 每条记录两行：类型、仓库 #PR、状态、尝试次数、时间；下面一行是大白话原因。默认全部收起。
        <div className="list run-list" aria-busy={loading}>
          {data.items.map((job) => (
            <RunRow job={job} key={job.id} />
          ))}
        </div>
      )}
      {data && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} disabled={loading} onPage={setPage} />
      )}
    </section>
  );
}

function RunRow({ job }: { job: Job }) {
  const link =
    job.job_type === "RULES_SYNC"
      ? { href: `#repositories/${job.repository_id}`, label: "查看同步结果" }
      : job.job_type === "HEALTH_AUDIT"
        ? { href: `#health/${job.id}`, label: "查看健康检查" }
        : { href: `#reviews/${job.id}`, label: "查看详情" };
  const reason = errorReason(job.last_error);
  const retried = job.attempt > 1 ? `已重试 ${job.attempt - 1} 次` : "";
  return (
    <details className="run-row">
      <summary>
        <span className="list-row">
          <span className="run-type">{jobLabels[job.job_type] ?? job.job_type}</span>
          <span className="pr-ref run-target" title={job.repository}>
            <span className="pr-ref-repo">{job.repository}</span>
            {job.job_type === "HEALTH_AUDIT" || job.job_type === "RULES_SYNC" ? (
              <span className="pr-ref-branch">默认分支</span>
            ) : (
              <strong className="pr-ref-number">#{job.pr_number}</strong>
            )}
          </span>
          <span className="col-status">
            <Status value={job.status} />
          </span>
          <span className="row-meta col-attempt">{job.attempt > 0 ? `第 ${job.attempt} 次尝试` : ""}</span>
          <time className="row-meta col-date" dateTime={job.created_at}>
            {dateText(job.created_at)}
          </time>
        </span>
        {reason && (
          <span
            className={`run-reason${["failed", "timeout", "interrupted", "uncertain"].includes(job.status) ? " is-error" : ""}`}
          >
            {reason}
            {retried && <span className="muted"> · {retried}</span>}
          </span>
        )}
      </summary>
      <div className="run-body">
        <a href={link.href}>{link.label}</a>
        <Attempts job={job} />
        {(job.agent_runs?.length ?? 0) > 0 && (
          <div className="run-usage">
            <h4 className="run-subtitle">模型与用量</h4>
            <RunDetails runs={job.agent_runs ?? []} />
          </div>
        )}
        {job.last_error && (
          <details className="run-raw">
            <summary>原始错误</summary>
            <pre className="run-error">{job.last_error}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

// 各次尝试一张小表；点“查看执行过程”在表下展开那一次的步骤。
function Attempts({ job }: { job: Job }) {
  const sessions = [...(job.agent_sessions ?? [])].sort(
    (a, b) => a.attempt - b.attempt || a.started_at.localeCompare(b.started_at),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [latest, setLatest] = useState<Record<string, AgentSessionRow>>({});
  if (!sessions.length)
    return (
      <p className="muted run-none">{job.status === "queued" ? "还没开始执行。" : "这次运行没有留下执行过程。"}</p>
    );
  const chosen = sessions.find((session) => session.id === selected);
  return (
    <div className="run-attempts">
      <table className="attempt-table" aria-label="各次尝试">
        <thead>
          <tr>
            <th scope="col">第几次</th>
            <th scope="col">角色</th>
            <th scope="col">结果</th>
            <th scope="col" className="num">
              耗时
            </th>
            <th scope="col" className="num">
              步数
            </th>
            <th scope="col">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((row) => {
            const session = latest[row.id] ?? row;
            const open = selected === session.id;
            return (
              <tr key={session.id} className={open ? "is-selected" : undefined}>
                <td className="num-left">第 {session.attempt} 次</td>
                <td>{sessionRoleLabel(session.role)}</td>
                <td>
                  <Status value={session.status} />
                </td>
                <td className="num">{durationText(session.duration_ms) || "—"}</td>
                <td className="num">{numberText(session.steps)}</td>
                <td className="attempt-action">
                  <button
                    type="button"
                    className="link-button"
                    aria-expanded={open}
                    onClick={() => setSelected(open ? null : session.id)}
                  >
                    {open ? "收起执行过程" : "查看执行过程"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {chosen && (
        <div className="attempt-steps">
          <h4 className="run-subtitle">
            第 {chosen.attempt} 次 · {sessionRoleLabel(chosen.role)} 的执行过程
          </h4>
          <SessionSteps
            key={chosen.id}
            session={chosen}
            onUpdate={(value) => setLatest((items) => ({ ...items, [value.id]: value }))}
          />
        </div>
      )}
    </div>
  );
}
