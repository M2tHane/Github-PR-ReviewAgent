import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { Empty } from "../components/common/empty-state.js";
import { ChevronRight, Search } from "../components/common/icons.js";
import { Status } from "../components/common/status-badge.js";
import { RepositoryOnboarding } from "../features/repositories/repository-onboarding.js";
import { scheduleLabels } from "../features/repositories/repository-settings.js";
import { numberText } from "../format.js";
import type { Repository, ServiceSettingsResponse } from "../types.js";

// 仓库列表一行一个仓库，设置都在各仓库自己的页面里。仓库多时可按名称筛选。
// 服务管理员（服务设置可编辑的人）右上角多一个"接入仓库"，在抽屉里接入 GitHub App 已安装的仓库。
export function RepositoryPage({
  items,
  onRepositoriesChange,
}: {
  items: Repository[];
  onRepositoriesChange: () => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [canOnboard, setCanOnboard] = useState(false),
    [onboarding, setOnboarding] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<ServiceSettingsResponse>("/api/service-settings", { signal: controller.signal })
      .then((value) => setCanOnboard(value.canEdit))
      .catch(() => setCanOnboard(false));
    return () => controller.abort();
  }, []);
  const shown = items.filter((repo) => repo.fullName.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <section>
      <div className="page-head">
        <div>
          <h2>仓库</h2>
          <p className="muted">管理接入的仓库：启停、审查范围、定时健康检查和群内开发都按仓库设置。</p>
        </div>
        {canOnboard && items.length > 0 && (
          <button type="button" onClick={() => setOnboarding(true)}>
            接入仓库
          </button>
        )}
      </div>
      {onboarding && <RepositoryOnboarding onChange={onRepositoriesChange} onClose={() => setOnboarding(false)} />}
      {!items.length ? (
        <div className="empty empty-steps">
          <p>还没有可管理的仓库。接入一个仓库分两步：</p>
          <ol>
            <li>在 GitHub 上给仓库安装 Pi Review App；</li>
            <li>{canOnboard ? "点下面的“接入仓库”，打开要用的仓库。" : "请服务管理员在本页“接入仓库”里打开它。"}</li>
          </ol>
          {canOnboard && (
            <div className="empty-action">
              <button type="button" className="primary" onClick={() => setOnboarding(true)}>
                接入仓库
              </button>
            </div>
          )}
        </div>
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
