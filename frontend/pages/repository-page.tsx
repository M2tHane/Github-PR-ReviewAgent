import { useState } from "react";
import { Empty } from "../components/common/empty-state.js";
import { ChevronRight, Search } from "../components/common/icons.js";
import { Status } from "../components/common/status-badge.js";
import { scheduleLabels } from "../features/repositories/repository-settings.js";
import { numberText } from "../format.js";
import type { Repository } from "../types.js";

// 仓库列表一行一个仓库，设置都在各仓库自己的页面里。仓库多时可按名称筛选。
export function RepositoryPage({ items }: { items: Repository[] }) {
  const [search, setSearch] = useState("");
  const shown = items.filter((repo) => repo.fullName.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <section>
      <div className="page-head">
        <h2>仓库</h2>
        <p className="muted">管理接入的仓库：启停、审查范围、定时健康检查和群内开发都按仓库设置。</p>
      </div>
      {!items.length ? (
        <Empty action={<a href="#settings/service">去服务设置接入仓库</a>}>当前账号没有可管理的已接入仓库。</Empty>
      ) : (
        <>
          {items.length > 8 && (
            <div className="toolbar">
              <span className="search-field">
                <Search />
                <input
                  type="search"
                  aria-label="查找仓库"
                  placeholder={`在 ${numberText(items.length)} 个仓库中查找`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </span>
            </div>
          )}
          {!shown.length ? (
            <Empty
              action={
                <button className="compact" onClick={() => setSearch("")}>
                  清除查找
                </button>
              }
            >
              没有名称包含“{search.trim()}”的仓库。
            </Empty>
          ) : (
            <div className="list repo-list">
              {shown.map((repo) => (
                <a className="list-row" href={`#repositories/${repo.id}`} key={repo.id}>
                  <Status value={repo.enabled ? "enabled" : "paused"} icon />
                  <span className="row-title" title={repo.fullName}>
                    {repo.fullName}
                  </span>
                  {!repo.enabled && <span className="row-tag">已暂停</span>}
                  <span className="row-meta col-scope-text">
                    {repo.includePaths.length || repo.excludePaths.length
                      ? `${repo.includePaths.length} 条包含 · ${repo.excludePaths.length} 条排除`
                      : "审查全部路径"}
                  </span>
                  <span className="row-meta col-budget" title="每次任务的 Token 上限">
                    {numberText(repo.budgetTokens)} tokens
                  </span>
                  <span className="row-meta col-schedule" title="定时健康检查">
                    健康检查：{scheduleLabels[repo.healthSchedule]}
                  </span>
                  <ChevronRight className="row-chevron" />
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
