import { Select } from "../components/common/select.js";
import { RuleImport } from "../features/memories/rule-import.js";
import { ruleLevelLabels } from "../../src/memory/types.js";
import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Empty, ListSkeleton } from "../components/common/empty-state.js";
import { ArrowLeft, Check, Search } from "../components/common/icons.js";
import { Pager } from "../components/common/pager.js";
import { Status } from "../components/common/status-badge.js";
import { RulePanel, ScopeChips } from "../features/memories/memory-detail.js";
import { dateText, numberText } from "../format.js";
import type { Memory, Repository as Repo } from "../types.js";
import { shortText } from "../../src/review/presentation.js";
import type { RuleReviewQueue } from "../../src/memory/types.js";
import { RuleReviewRows } from "../features/memories/rule-review.js";

const PAGE_SIZE = 20;

export function MemoriesPage({
  items,
  repositories,
  reload,
  route,
}: {
  items: Memory[];
  repositories: Repo[];
  reload: () => Promise<void>;
  route: string;
}) {
  const [path, query = ""] = route.split("?");
  const params = new URLSearchParams(query);
  const [filter, setFilter] = useState(
      path === "rules/review" ? "REVIEW" : path === "rules/pending" ? "CANDIDATE" : "ALL",
    ),
    [repositoryId, setRepositoryId] = useState(params.get("repo") ?? "ALL"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const [importMode, setImportMode] = useState<"markdown" | "project" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [reviewQueue, setReviewQueue] = useState<RuleReviewQueue | null>(null),
    [reviewLoading, setReviewLoading] = useState(false),
    [reviewError, setReviewError] = useState("");
  async function refreshReview() {
    setReviewQueue(await api<RuleReviewQueue>("/api/rule-review"));
    setNotice("已记录理由，所选原因将在 90 天后重新检查。");
  }
  useEffect(() => {
    if (filter !== "REVIEW") return;
    const controller = new AbortController();
    setReviewLoading(true);
    setReviewError("");
    void api<RuleReviewQueue>("/api/rule-review", { signal: controller.signal })
      .then(setReviewQueue)
      .catch((cause) => {
        if (!controller.signal.aborted) setReviewError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReviewLoading(false);
      });
    return () => controller.abort();
  }, [filter, items]);
  const match = path!.match(/^rules\/([0-9a-f-]{36})(\/edit)?$/i),
    selected = items.find((item) => item.id === match?.[1]),
    editing = Boolean(match?.[2]);
  const suffix = repositoryId !== "ALL" ? `?repo=${repositoryId}` : "";
  const sameOwner = (a: Memory, b: Memory) => a.repositoryId === b.repositoryId;
  const previousPath = useRef(path);
  useEffect(() => {
    if (params.has("repo")) setRepositoryId(params.get("repo")!);
    if (path === "rules/pending") setFilter("CANDIDATE");
    if (path === "rules/review") setFilter("REVIEW");
    // 从"待确认""需要复查"的地址回到 #rules 时回到"全部"；关闭详情回到 #rules 时保留当前页签。
    if (path === "rules" && ["rules/pending", "rules/review"].includes(previousPath.current!)) setFilter("ALL");
    previousPath.current = path;
    setError("");
  }, [route]);
  const matches = (item: Memory, status: string) =>
    status === "ALL" ||
    (status === "INACTIVE"
      ? ["DEPRECATED", "SUPERSEDED", "REJECTED"].includes(item.status)
      : status === "ACTIVE"
        ? item.status === "ACTIVE" || Boolean(item.activeVersion)
        : item.status === status);
  const inScope = (item: Memory) =>
    (repositoryId === "ALL" || item.repositoryId === Number(repositoryId)) &&
    [item.title, item.content, ...Object.values(item.scope).flat()]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  const scoped = items.filter(inScope);
  const reviewItems = reviewQueue?.items.filter((item) => inScope(item.memory)) ?? [];
  const shown = scoped.filter((item) => matches(item, filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 确认或忽略后列表会变短，页码超出时落到最后一页。
  const total = filter === "REVIEW" ? reviewItems.length : shown.length;
  const current = Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE))),
    visible = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  useEffect(() => setPage(1), [filter, repositoryId, search]);
  const close = () => {
    location.hash =
      (filter === "REVIEW" ? "rules/review" : filter === "CANDIDATE" ? "rules/pending" : "rules") + suffix;
  };
  async function action(item: Memory, name: string, value: object = {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/memories/${item.id}/${name}`, { method: "POST", body: JSON.stringify(value) });
      await reload();
      setNotice(
        (
          {
            approve: "规则已确认生效。",
            reject: "已忽略这次提议。",
            deprecate: "规则已停用。",
            supersede: "替代规则已生效。",
          } as Record<string, string>
        )[name] ?? "已保存。",
      );
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function edit(item: Memory, form: HTMLFormElement) {
    const data = new FormData(form),
      lines = (name: string) =>
        String(data.get(name) ?? "")
          .split("\n")
          .map((text) => text.trim())
          .filter(Boolean);
    setBusy(true);
    setError("");
    try {
      await api(`/api/memories/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          level: data.get("level"),
          title: String(data.get("title")).trim(),
          content: String(data.get("content")).trim(),
          rationale: String(data.get("rationale")).trim(),
          ...(item.type === "exception" && data.has("exceptionTo")
            ? { exceptionTo: String(data.get("exceptionTo")) || null }
            : {}),
          scope: {
            ...item.scope,
            paths: lines("paths"),
            languages: lines("languages"),
            modules: lines("modules"),
            conditions: lines("conditions"),
          },
        }),
      });
      await reload();
      setNotice("修改已保存，确认后才用于后续审查。");
      location.hash = `rules/${item.id}${suffix}`;
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  if (editing && selected)
    return (
      <section className="rule-editor form-page">
        <a href={`#rules/${selected.id}${suffix}`} className="back-link">
          <ArrowLeft />
          返回规则详情
        </a>
        <div className="page-head">
          <h2>编辑规则</h2>
          <p className="muted">
            {selected.activeVersion || selected.status === "ACTIVE"
              ? "保存后等待确认，当前生效规则继续使用。"
              : "完善规则内容，来源与证据继续保留。"}
          </p>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {!["ACTIVE", "CANDIDATE"].includes(selected.status) ? (
          <Empty>这条规则不可编辑，或当前账号没有管理权限。</Empty>
        ) : (
          <form
            className="stack-form"
            key={`${selected.id}-${selected.version}`}
            onSubmit={(event) => {
              event.preventDefault();
              void edit(selected, event.currentTarget);
            }}
          >
            <label>
              规则级别
              <Select name="level" defaultValue={selected.level}>
                {Object.entries(ruleLevelLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              规则名称
              <input name="title" required defaultValue={selected.title} />
            </label>
            <label>
              规则内容
              <textarea className="rule-textarea" name="content" required defaultValue={selected.content} />
            </label>
            <label>
              修改依据
              <textarea name="rationale" required defaultValue={selected.rationale} />
            </label>
            <fieldset className="form-section">
              <legend>适用范围</legend>
              <p className="muted">每行一项；留空表示不限制该维度。</p>
              {selected.type === "exception" && <ExceptionSelector item={selected} items={items} />}
              <label>
                路径
                <textarea name="paths" defaultValue={(selected.scope.paths ?? []).join("\n")} />
              </label>
              <div className="row">
                <label>
                  语言
                  <textarea name="languages" defaultValue={(selected.scope.languages ?? []).join("\n")} />
                </label>
                <label>
                  模块
                  <textarea name="modules" defaultValue={(selected.scope.modules ?? []).join("\n")} />
                </label>
              </div>
              <label>
                适用条件
                <textarea name="conditions" defaultValue={(selected.scope.conditions ?? []).join("\n")} />
              </label>
            </fieldset>
            <div className="dialog-actions">
              <a className="button" href={`#rules/${selected.id}${suffix}`}>
                取消
              </a>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存，等待确认"}
              </button>
            </div>
          </form>
        )}
      </section>
    );
  return (
    <section className="rules">
      <div className="page-head">
        <div>
          <h2 id="rules-title" tabIndex={-1}>
            规则
          </h2>
          <p className="muted">管理仓库规则，确认工程决定、适用范围和级别。</p>
        </div>
        <div className="actions">
          <button onClick={() => setImportMode("markdown")}>导入 Markdown</button>
          <button onClick={() => setImportMode("project")}>从其他项目导入</button>
        </div>
      </div>
      {importMode && (
        <RuleImport
          mode={importMode}
          repositories={repositories}
          initialTarget={repositoryId}
          close={() => setImportMode(null)}
          imported={async (result, target) => {
            setRepositoryId(String(target));
            setFilter("ACTIVE");
            setNotice(`已导入并生效 ${result.imported.length} 条，跳过 ${result.skipped.length} 条重复规则。`);
            await reload();
          }}
        />
      )}
      {error && !selected && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="feedback" role="status">
          {notice}
        </p>
      )}
      <div className="toolbar">
        <span className="search-field">
          <Search />
          <input
            type="search"
            aria-label="查找规则"
            value={search}
            placeholder="搜索名称、内容或适用范围"
            onChange={(event) => setSearch(event.target.value)}
          />
        </span>
        <Select
          compact
          prefix="仓库："
          aria-label="仓库"
          value={repositoryId}
          onChange={(value) => setRepositoryId(value)}
        >
          <option value="ALL">所有仓库</option>
          {repositories.map((repo) => (
            <option value={repo.id} key={repo.id}>
              {repo.fullName}
            </option>
          ))}
        </Select>
      </div>
      <nav className="tabs" aria-label="规则状态">
        {[
          ["ALL", "全部"],
          ["ACTIVE", "生效中"],
          ["CANDIDATE", "待确认"],
          ["REVIEW", "需要复查"],
          ["INACTIVE", "已停用 / 已忽略"],
        ].map(([status, label]) => (
          <button
            key={status}
            className={filter === status ? "active" : ""}
            aria-pressed={filter === status}
            onClick={() => setFilter(status!)}
          >
            {label}
            <span>
              {status === "REVIEW"
                ? reviewQueue === null
                  ? "—"
                  : reviewItems.length
                : scoped.filter((item) => matches(item, status!)).length}
            </span>
          </button>
        ))}
      </nav>
      {match && !selected && (
        <p className="alert" role="alert">
          规则不存在或当前账号无权查看。
          <button className="link-button" onClick={close}>
            返回列表
          </button>
        </p>
      )}
      {filter === "REVIEW" ? (
        <>
          <p className="muted tab-note">
            按生效规则的使用情况、适用路径和到期时间提示复查，由维护者决定是否修改或停用。
          </p>
          {reviewLoading ? (
            <ListSkeleton label="正在检查规则与默认分支文件树…" />
          ) : reviewError ? (
            <p className="alert" role="alert">
              {reviewError}
            </p>
          ) : (
            <>
              {Boolean(reviewQueue?.uncheckedRepositories.length) && (
                <p className="alert">
                  以下仓库的文件树不完整或暂时无法读取，涉及它们的规则未判断路径失效：
                  {reviewQueue!.uncheckedRepositories.join("、")}
                </p>
              )}
              {reviewItems.length ? (
                <RuleReviewRows
                  items={reviewItems.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)}
                  repositories={repositories}
                  suffix={suffix}
                  refresh={refreshReview}
                />
              ) : (
                <Empty>没有需要复查的规则。</Empty>
              )}
            </>
          )}
        </>
      ) : !shown.length ? (
        filter === "CANDIDATE" ? (
          <Empty
            action={
              <button className="compact" onClick={() => setFilter("ACTIVE")}>
                查看生效中的规则
              </button>
            }
          >
            没有待确认规则。合并 PR 中的新约定会出现在这里。
          </Empty>
        ) : (
          <Empty
            action={
              search || repositoryId !== "ALL" || filter !== "ALL" ? (
                <button
                  className="compact"
                  onClick={() => {
                    setSearch("");
                    setRepositoryId("ALL");
                    setFilter("ALL");
                  }}
                >
                  清除筛选
                </button>
              ) : undefined
            }
          >
            {search || repositoryId !== "ALL" || filter !== "ALL"
              ? "没有符合条件的规则，试试调整筛选。"
              : "还没有规则。PR 合并后会抽取待确认规则，也可以从 Markdown 导入。"}
          </Empty>
        )
      ) : (
        <div className="list rule-list">
          {visible.map((item) => {
            const repository = repositories.find((repo) => repo.id === item.repositoryId)?.fullName;
            // 从没生效过的待确认规则不会交给审查，不显示引用和修复次数。
            const used = item.status !== "CANDIDATE" || Boolean(item.activeVersion);
            const statusLabel = item.status === "CANDIDATE" && item.activeVersion ? "待确认更新" : undefined;
            return (
              <article className={`rule-row${filter === "CANDIDATE" ? " rule-row-pending" : ""}`} key={item.id}>
                <div className="list-row">
                  <Status value={item.status} label={statusLabel} icon />
                  <a className="row-title rule-open" href={`#rules/${item.id}${suffix}`} title={item.title}>
                    {item.title}
                  </a>
                  <span className="col-scope">
                    <ScopeChips scope={item.scope} limit={1} />
                  </span>
                  <span className="row-meta col-repo" title={repository}>
                    {repository}
                  </span>
                  <span className={`col-level level-${item.level}`}>{ruleLevelLabels[item.level]}</span>
                  <span className="col-num" title="被意见引用次数">
                    {used && `引用 ${numberText(item.usage.cited)}`}
                  </span>
                  <span className="col-num" title="引用后已修复次数">
                    {used && `修复 ${numberText(item.usage.fixed)}`}
                  </span>
                  <time
                    className="row-meta col-date"
                    dateTime={item.updatedAt}
                    title={`更新于 ${dateText(item.updatedAt)}`}
                  >
                    {dateText(item.updatedAt)}
                  </time>
                </div>
                {filter === "CANDIDATE" && (
                  <div className="row-sub">
                    <p className="row-preview" title={item.content}>
                      {statusLabel && <span className="pending-label">{statusLabel} · </span>}
                      {shortText(item.content, 180)}
                    </p>
                    <span className="row-actions">
                      <button className="ghost compact" disabled={busy} onClick={() => void action(item, "reject")}>
                        忽略
                      </button>
                      <a className="button ghost compact" href={`#rules/${item.id}/edit${suffix}`}>
                        编辑
                      </a>
                      <button className="compact" disabled={busy} onClick={() => void action(item, "approve")}>
                        <Check />
                        {item.activeVersion ? "确认更新" : "确认生效"}
                      </button>
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {total > 0 && !reviewLoading && (
        <Pager
          page={current}
          pageSize={PAGE_SIZE}
          total={total}
          onPage={(value) => {
            setPage(value);
            document.getElementById("rules-title")?.scrollIntoView();
          }}
        />
      )}
      {selected && (
        <RulePanel
          key={selected.id}
          item={selected}
          repository={repositories.find((repo) => repo.id === selected.repositoryId)}
          suffix={suffix}
          rules={items}
          candidates={items.filter(
            (item) => sameOwner(item, selected) && item.status === "CANDIDATE" && item.id !== selected.id,
          )}
          busy={busy}
          action={action}
          close={close}
          error={error}
        />
      )}
    </section>
  );
}

function ExceptionSelector({ item, items }: { item: Memory; items: Memory[] }) {
  const [value, setValue] = useState(item.exceptionTo ?? "");
  const rules = items.filter(
    (rule) =>
      rule.repositoryId === item.repositoryId &&
      rule.id !== item.id &&
      (rule.status === "ACTIVE" || Boolean(rule.activeVersion)),
  );
  const unavailable = Boolean(value && !rules.some((rule) => rule.id === value));
  const selected = items.find((rule) => rule.id === value);
  return (
    <>
      <label style={{ minWidth: 0 }}>
        例外于
        <Select name="exceptionTo" value={value} onChange={(value) => setValue(value)}>
          <option value="">不关联</option>
          {unavailable && (
            <option value={value} disabled>
              当前关联不可选（已失效或不存在）
            </option>
          )}
          {rules.map((rule) => (
            <option value={rule.id} key={rule.id} title={rule.title}>
              {shortText(rule.title, 80)}
            </option>
          ))}
        </Select>
      </label>
      {value && (
        <p className="muted" style={{ overflowWrap: "anywhere" }}>
          当前关联：{selected?.title ?? value}
          {unavailable && "。请选择生效规则或不关联；未选择时保留原关联。"}
        </p>
      )}
      {!rules.length && <p className="muted">当前归属暂无其他可关联的生效规则。可先保存，批准前需关联生效规则。</p>}
    </>
  );
}
