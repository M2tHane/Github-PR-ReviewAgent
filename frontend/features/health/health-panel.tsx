import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { Empty } from "../../components/common/empty-state.js";
import { Status } from "../../components/common/status-badge.js";
import { dateText, numberText } from "../../format.js";
import type { Job, Repository as Repo } from "../../types.js";
import { scheduleLabels } from "../repositories/repository-settings.js";
import {
  HealthReportView,
  HealthSectionNav,
  healthSections,
  healthStatuses,
  type SeverityFilter,
} from "./health-report.js";
import type { HealthDetail } from "./types.js";

const healthHash = () => location.hash.match(/^#health\/([0-9a-f-]{36})$/i)?.[1] ?? "";
export function HealthPanel({ repositories }: { repositories: Repo[] }) {
  // 仓库设置页带着 ?repo=<id> 过来时直接选中那个仓库。
  const [repositoryId, setRepositoryId] = useState(() => {
    const id = new URLSearchParams(location.hash.split("?")[1] ?? "").get("repo") ?? "";
    return repositories.some((item) => String(item.id) === id) ? id : "";
  });
  const [items, setItems] = useState<Job[]>([]),
    [selected, setSelected] = useState(healthHash),
    [detail, setDetail] = useState<HealthDetail | null>(null);
  const [page, setPage] = useState(0),
    [nextPage, setNextPage] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [loadingList, setLoadingList] = useState(false),
    [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const repository = repositories.find((item) => String(item.id) === repositoryId);
  const active = items.find((item) => ["queued", "running"].includes(item.status));
  useEffect(() => {
    if (!repositoryId && !selected && repositories.length) setRepositoryId(String(repositories[0]!.id));
  }, [repositories, repositoryId, selected]);
  useEffect(() => {
    const changed = () => {
      const id = healthHash();
      if (id) setSelected(id);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (!repositoryId) return;
    const controller = new AbortController();
    let live = true;
    setLoadingList(true);
    void api<{ items: Job[]; nextPage: number | null }>(`/api/health?repositoryId=${repositoryId}&page=${page}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!live) return;
        setItems((previous) =>
          page === 0
            ? value.items
            : [...previous, ...value.items.filter((item) => !previous.some((old) => old.id === item.id))],
        );
        setNextPage(value.nextPage);
        setSelected((previous) => previous || value.items[0]?.id || "");
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "记录加载失败");
      })
      .finally(() => {
        if (live) setLoadingList(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [repositoryId, page, refresh]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setDetail(null);
    setFilter("all");
    setLoadingDetail(true);
    history.replaceState(null, "", `#health/${selected}`);
    const load = async () => {
      try {
        const value = await api<HealthDetail>(`/api/health/${selected}`, { signal: controller.signal });
        if (!live) return;
        setDetail(value);
        setRepositoryId(String(value.job.repository_id));
        setLoadingDetail(false);
        setItems((previous) =>
          previous.map((item) =>
            item.id === value.job.id
              ? {
                  ...item,
                  ...value.job,
                  has_report: Boolean(value.report),
                  finding_count: value.report?.result.findings.length ?? 0,
                  health_summary: value.report?.result.summary,
                }
              : item,
          ),
        );
        if (["queued", "running"].includes(value.job.status)) timer = setTimeout(() => void load(), 2500);
      } catch (cause) {
        if (live) {
          setError(cause instanceof Error ? cause.message : "报告加载失败");
          setLoadingDetail(false);
        }
      }
    };
    void load();
    return () => {
      live = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [selected, refresh]);
  const choose = (id: string) => {
    setError("");
    if (id === selected) setRefresh((value) => value + 1);
    setSelected(id);
  };
  const run = async () => {
    if (!repository) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<{ kind: string; job: { id: string } }>(`/api/repositories/${repository.id}/health`, {
        method: "POST",
        body: "{}",
      });
      choose(value.job.id);
      setPage(0);
      setRefresh((value) => value + 1);
      setNotice(value.kind === "duplicate" ? "已打开当前活动任务。" : "健康检查已加入队列。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建任务失败");
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await api<{ job: { id: string } }>(`/api/health/${selected}/retry`, { method: "POST", body: "{}" });
      choose(value.job.id);
      setRefresh((value) => value + 1);
      setNotice("已按原快照重新排队，沿用本任务剩余额度。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重试失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="health" aria-labelledby="health-title">
      <div className="section-head">
        <div>
          <h2 id="health-title">仓库健康检查</h2>
          <p className="muted">查看需要关注的意见与未覆盖范围。</p>
        </div>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
          {error.includes("登录") && (
            <>
              {" "}
              · <a href="/auth/github">重新登录</a>
            </>
          )}
        </p>
      )}
      {notice && (
        <p className="health-feedback" role="status">
          {notice}
        </p>
      )}
      {!repositories.length ? (
        <Empty>当前没有可管理的已登记仓库，请先完成现有仓库接入。</Empty>
      ) : (
        <>
          <div className="health-controls card">
            <div>
              <label htmlFor="health-repository">
                仓库
                <select
                  id="health-repository"
                  value={repositoryId}
                  onChange={(event) => {
                    setRepositoryId(event.target.value);
                    setPage(0);
                    setItems([]);
                    setSelected("");
                    setDetail(null);
                    setError("");
                    setNotice("");
                    history.replaceState(null, "", "#health");
                  }}
                >
                  <option value="" disabled>
                    选择仓库
                  </option>
                  {repositories.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.fullName}
                      {item.enabled ? "" : "（已暂停）"}
                    </option>
                  ))}
                </select>
              </label>
              <small>默认分支 · 最近 30 天 · 每任务 {numberText(repository?.budgetTokens)} tokens</small>
            </div>
            <div className="health-run-actions">
              <button disabled={busy || !repository?.enabled} aria-busy={busy} onClick={() => void run()}>
                {busy ? "处理中…" : active ? "查看当前健康任务" : "运行健康检查"}
              </button>
              <button
                className="secondary"
                disabled={loadingList}
                onClick={() => {
                  setError("");
                  setPage(0);
                  setRefresh((value) => value + 1);
                }}
              >
                刷新
              </button>
            </div>
          </div>
          <div className="health-layout">
            <aside className="health-sidebar">
              {repository && (
                <section className="card health-schedule">
                  <h3>定时检查</h3>
                  <p>
                    {scheduleLabels[repository.healthSchedule]}
                    {repository.healthNextRunAt && ` · 下次 ${dateText(repository.healthNextRunAt)}`}
                  </p>
                  {repository.healthLastError && <p className="error">{repository.healthLastError}</p>}
                  <a href={`#repositories/${repository.id}/health`}>修改设置 →</a>
                </section>
              )}
              <section className="card health-history">
                <h3>检查记录</h3>
                {loadingList && !items.length ? (
                  <p role="status">正在加载记录…</p>
                ) : !items.length ? (
                  <p className="muted">暂无报告。运行一次检查即可建立基线。</p>
                ) : (
                  <div className="health-history-list">
                    {items.map((item) => (
                      <button
                        className={`health-history-item ${selected === item.id ? "selected" : ""}`}
                        key={item.id}
                        onClick={() => choose(item.id)}
                        aria-current={selected === item.id ? "true" : undefined}
                      >
                        <span>
                          <code>{String(item.target_sha).slice(0, 10)}</code>
                          <Status value={item.status} label={healthStatuses[item.status]} />
                        </span>
                        <small>{dateText(item.created_at)}</small>
                        <span>
                          {item.has_report ? `${item.finding_count} 条意见` : "任务记录"} ·{" "}
                          {item.payload?.trigger === "schedule" ? "定时" : "手动"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {nextPage !== null && (
                  <button className="secondary" disabled={loadingList} onClick={() => setPage(nextPage)}>
                    加载更多
                  </button>
                )}
              </section>
              {detail?.report && healthSections(detail.report, filter).length > 1 && (
                <section className="card health-toc">
                  <h3>报告目录</h3>
                  <HealthSectionNav report={detail.report} filter={filter} className="health-toc-nav" />
                </section>
              )}
            </aside>
            <div className="health-detail" aria-busy={loadingDetail}>
              {loadingDetail ? (
                <div className="card" role="status">
                  正在加载任务详情…
                </div>
              ) : detail ? (
                <HealthReportView
                  detail={detail}
                  choose={choose}
                  retry={() => void retry()}
                  busy={busy}
                  enabled={repository?.enabled ?? false}
                  filter={filter}
                  setFilter={setFilter}
                />
              ) : (
                <Empty>选择一条记录查看证据，或运行新的健康检查。</Empty>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
