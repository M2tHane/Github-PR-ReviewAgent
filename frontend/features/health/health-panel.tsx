import { Select } from "../../components/common/select.js";
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { Empty, ListSkeleton } from "../../components/common/empty-state.js";
import { Check } from "../../components/common/icons.js";
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
  // 没指定仓库时，默认选最近有健康检查记录的仓库；都没有记录再选第一个。
  useEffect(() => {
    if (repositoryId || selected || !repositories.length) return;
    const controller = new AbortController();
    const fallback = () => setRepositoryId((current) => current || String(repositories[0]!.id));
    void api<{ items: Job[] }>("/api/health", { signal: controller.signal })
      .then((value) => {
        const latest = value.items.find((item) => repositories.some((repo) => repo.id === Number(item.repository_id)));
        if (latest) setRepositoryId((current) => current || String(latest.repository_id));
        else fallback();
      })
      .catch(() => {
        if (!controller.signal.aborted) fallback();
      });
    return () => controller.abort();
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
      <div className="page-head">
        <h2 id="health-title">健康检查</h2>
        <p className="muted">查看需要关注的意见与未覆盖范围。</p>
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
        <p className="feedback health-feedback" role="status">
          <Check />
          {notice}
        </p>
      )}
      {!repositories.length ? (
        <Empty action={<a href="#settings/service">去服务设置接入仓库</a>}>
          当前没有可管理的已登记仓库，请先完成现有仓库接入。
        </Empty>
      ) : (
        <>
          <div className="toolbar health-toolbar">
            <Select
              id="health-repository"
              compact
              prefix="仓库："
              aria-label="仓库"
              value={repositoryId}
              onChange={(value) => {
                setRepositoryId(value);
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
            </Select>
            <span className="muted toolbar-note">
              默认分支 · 最近 30 天 · 每任务 {numberText(repository?.budgetTokens)} tokens
            </span>
            <span className="toolbar-end">
              <button
                className="ghost compact"
                disabled={loadingList}
                onClick={() => {
                  setError("");
                  setPage(0);
                  setRefresh((value) => value + 1);
                }}
              >
                刷新
              </button>
              <button
                className="primary compact"
                disabled={busy || !repository?.enabled}
                aria-busy={busy}
                onClick={() => void run()}
              >
                {busy ? "处理中…" : active ? "查看当前健康任务" : "运行健康检查"}
              </button>
            </span>
          </div>
          {repository && (
            <p className="muted health-schedule">
              定时检查：{scheduleLabels[repository.healthSchedule]}
              {repository.healthNextRunAt && ` · 下次 ${dateText(repository.healthNextRunAt)}`} ·{" "}
              <a href={`#repositories/${repository.id}/health`}>修改设置</a>
            </p>
          )}
          {repository?.healthLastError && <p className="alert">{repository.healthLastError}</p>}
          <div className="health-layout">
            <aside className="health-history" aria-labelledby="health-history-title">
              <h3 className="list-group-head" id="health-history-title">
                检查记录 {items.length > 0 && <span className="group-count">{items.length}</span>}
              </h3>
              {loadingList && !items.length ? (
                <ListSkeleton rows={3} label="正在加载记录…" />
              ) : !items.length ? (
                <Empty>暂无报告。运行一次检查即可建立基线。</Empty>
              ) : (
                <div className="list health-history-list">
                  {items.map((item) => (
                    <button
                      className={`health-history-item${selected === item.id ? " selected" : ""}`}
                      key={item.id}
                      onClick={() => choose(item.id)}
                      aria-current={selected === item.id ? "true" : undefined}
                    >
                      <span className="history-line">
                        <code>{String(item.target_sha).slice(0, 10)}</code>
                        <Status value={item.status} label={healthStatuses[item.status]} />
                      </span>
                      <span className="history-meta">
                        {dateText(item.created_at)} · {item.has_report ? `${item.finding_count} 条意见` : "任务记录"} ·{" "}
                        {item.payload?.trigger === "schedule" ? "定时" : "手动"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {nextPage !== null && (
                <button className="compact health-more" disabled={loadingList} onClick={() => setPage(nextPage)}>
                  加载更多
                </button>
              )}
            </aside>
            {/* 三栏都先有一行小标题，盒子从标题下方开始，上沿才能对齐。 */}
            <div className="health-detail" aria-busy={loadingDetail} aria-labelledby="health-detail-title">
              <h3 className="list-group-head" id="health-detail-title">
                报告
                {detail && (
                  <code className="group-count" title={detail.job.target_sha}>
                    {String(detail.job.target_sha).slice(0, 10)}
                  </code>
                )}
              </h3>
              {loadingDetail ? (
                <ListSkeleton rows={4} label="正在加载任务详情…" />
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
            {detail?.report && healthSections(detail.report, filter).length > 1 && (
              <aside className="health-toc">
                <h3 className="list-group-head">报告目录</h3>
                <HealthSectionNav report={detail.report} filter={filter} className="health-toc-nav" />
              </aside>
            )}
          </div>
        </>
      )}
    </section>
  );
}
