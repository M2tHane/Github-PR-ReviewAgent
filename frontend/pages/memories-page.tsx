import { RuleImport } from "../features/memories/rule-import.js";
import { memorySourceLabel } from "../../src/memory/types.js";
import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Empty } from "../components/common/empty-state.js";
import { Pager } from "../components/common/pager.js";
import { Status } from "../components/common/status-badge.js";
import { RulePanel, ScopeChips } from "../features/memories/memory-detail.js";
import { dateText } from "../format.js";
import type { Memory, Repository as Repo } from "../types.js";
import { shortText } from "../../src/review/presentation.js";

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
  const [filter, setFilter] = useState(route === "rules/pending" ? "CANDIDATE" : "ALL"),
    [repositoryId, setRepositoryId] = useState("ALL"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const [importMode, setImportMode] = useState<"markdown" | "project" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const match = route.match(/^rules\/([0-9a-f-]{36})(\/edit)?$/i),
    selected = items.find((item) => item.id === match?.[1]),
    editing = Boolean(match?.[2]);
  useEffect(() => {
    if (route === "rules/pending") setFilter("CANDIDATE");
    setError("");
  }, [route]);
  const matches = (item: Memory, status: string) =>
    status === "ALL" ||
    (status === "INACTIVE"
      ? ["DEPRECATED", "SUPERSEDED", "REJECTED"].includes(item.status)
      : status === "ACTIVE"
        ? item.status === "ACTIVE" || Boolean(item.activeVersion)
        : item.status === status);
  const scoped = items.filter(
    (item) =>
      (repositoryId === "ALL" || item.repositoryId === Number(repositoryId)) &&
      [item.title, item.content, ...Object.values(item.scope).flat()]
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const shown = scoped.filter((item) => matches(item, filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 确认或忽略后列表会变短，页码超出时落到最后一页。
  const current = Math.min(page, Math.max(1, Math.ceil(shown.length / PAGE_SIZE))),
    visible = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  useEffect(() => setPage(1), [filter, repositoryId, search]);
  const close = () => {
    location.hash = filter === "CANDIDATE" ? "rules/pending" : "rules";
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
          title: String(data.get("title")).trim(),
          content: String(data.get("content")).trim(),
          rationale: String(data.get("rationale")).trim(),
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
      location.hash = `rules/${item.id}`;
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  if (editing && selected)
    return (
      <section className="rule-editor">
        <a href={`#rules/${selected.id}`} className="back-link">
          ← 返回规则详情
        </a>
        <div className="section-head">
          <div>
            <h2>编辑团队规则</h2>
            <p className="muted">
              {selected.activeVersion || selected.status === "ACTIVE"
                ? "保存后等待确认，当前生效规则继续使用。"
                : "完善规则内容，来源与证据继续保留。"}
            </p>
          </div>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {!["ACTIVE", "CANDIDATE"].includes(selected.status) ? (
          <Empty>这条规则已停用或忽略，不能编辑。</Empty>
        ) : (
          <form
            className="card"
            key={`${selected.id}-${selected.version}`}
            onSubmit={(event) => {
              event.preventDefault();
              void edit(selected, event.currentTarget);
            }}
          >
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
            <fieldset>
              <legend>适用范围</legend>
              <p className="muted">每行一项；留空表示不限制该维度。</p>
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
              <a className="button secondary" href={`#rules/${selected.id}`}>
                取消
              </a>
              <button type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存，等待确认"}
              </button>
            </div>
          </form>
        )}
      </section>
    );
  return (
    <section className="rules">
      <div className="section-head">
        <div>
          <h2 id="rules-title" tabIndex={-1}>
            团队规则
          </h2>
          <p className="muted">来自 PR 讨论或维护者确认导入的工程决定，按项目用于后续审查和开发任务。</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={() => setImportMode("markdown")}>
            导入 Markdown
          </button>
          <button className="secondary" onClick={() => setImportMode("project")}>
            从其他项目导入
          </button>
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
      <div className="rule-filters">
        <label className="search-field">
          查找规则
          <input
            type="search"
            value={search}
            placeholder="搜索名称、内容或适用范围"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          仓库
          <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
            <option value="ALL">所有仓库</option>
            {repositories.map((repo) => (
              <option value={repo.id} key={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <nav className="rule-tabs" aria-label="规则状态">
        {[
          ["ALL", "全部"],
          ["ACTIVE", "生效中"],
          ["CANDIDATE", "待确认"],
          ["INACTIVE", "已停用 / 已忽略"],
        ].map(([status, label]) => (
          <button
            key={status}
            className={filter === status ? "active" : ""}
            aria-pressed={filter === status}
            onClick={() => setFilter(status!)}
          >
            {label}
            <span>{scoped.filter((item) => matches(item, status!)).length}</span>
          </button>
        ))}
      </nav>
      {match && !selected && (
        <p className="alert" role="alert">
          规则不存在或当前账号无权查看。
          <button className="text-button" onClick={close}>
            返回列表
          </button>
        </p>
      )}
      {!shown.length ? (
        <Empty>
          {filter === "CANDIDATE"
            ? "没有待确认规则。合并 PR 中的新约定会出现在这里。"
            : "没有符合条件的规则，试试调整筛选。"}
        </Empty>
      ) : (
        <div className="rule-list">
          {visible.map((item) => (
            <article className="rule-row" key={item.id}>
              <div className="rule-line">
                <a className="rule-open" href={`#rules/${item.id}`}>
                  <h3>{item.title}</h3>
                </a>
                <Status
                  value={item.status}
                  label={item.status === "CANDIDATE" && item.activeVersion ? "待确认更新" : undefined}
                />
              </div>
              <ScopeChips scope={item.scope} limit={3} />
              <div className="rule-meta">
                <span>
                  {repositories.find((repo) => repo.id === item.repositoryId)?.fullName} ·{" "}
                  {memorySourceLabel(item.source)}
                </span>
                <span>更新于 {dateText(item.updatedAt)}</span>
              </div>
              {filter === "CANDIDATE" && (
                <div className="pending-rule">
                  <p>{shortText(item.content, 180)}</p>
                  {item.activeVersion && <small>当前生效版本继续用于审查。</small>}
                  <div className="actions">
                    <button className="secondary" disabled={busy} onClick={() => void action(item, "reject")}>
                      忽略
                    </button>
                    <a className="button secondary" href={`#rules/${item.id}/edit`}>
                      编辑
                    </a>
                    <button disabled={busy} onClick={() => void action(item, "approve")}>
                      {item.activeVersion ? "确认更新规则" : "确认加入团队规则"}
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <Pager
          page={current}
          pageSize={PAGE_SIZE}
          total={shown.length}
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
          candidates={items.filter(
            (item) =>
              item.repositoryId === selected.repositoryId && item.status === "CANDIDATE" && item.id !== selected.id,
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
