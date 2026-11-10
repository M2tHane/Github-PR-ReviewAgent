import { Status } from "../components/common/status-badge.js";
import { DevelopmentForm, DevelopmentTasks, useDevelopment } from "../features/repositories/development-settings.js";
import { HealthScheduleForm, ReviewSettingsForm } from "../features/repositories/repository-settings.js";
import type { Repository } from "../types.js";

export type RepositoryTab = "review" | "health" | "development" | "tasks";
const tabs: Array<[key: RepositoryTab, label: string]> = [
  ["review", "审查"],
  ["health", "健康检查"],
  ["development", "群内开发"],
  ["tasks", "开发任务"],
];

export function RepositorySettingsPage({
  repo,
  tab,
  onRepositoryUpdated,
}: {
  repo: Repository;
  tab: RepositoryTab;
  onRepositoryUpdated: (repo: Repository) => void;
}) {
  const development = useDevelopment(repo);
  return (
    <section className="repo-settings">
      <a className="back-link" href="#repositories">
        ← 仓库
      </a>
      <div className="section-head">
        <div>
          <h2>{repo.fullName}</h2>
          <p className="muted">这个仓库的审查、健康检查和群内开发设置。</p>
        </div>
        <Status value={repo.enabled ? "enabled" : "paused"} />
      </div>
      <nav className="rule-tabs" aria-label="仓库设置分类">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => {
              location.hash = key === "review" ? `repositories/${repo.id}` : `repositories/${repo.id}/${key}`;
            }}
          >
            {label}
            {key === "tasks" && development.tasks.length > 0 && <span>{development.tasks.length}</span>}
          </button>
        ))}
      </nav>
      {/* 四个页签一直挂着、只切换显示：换页签不会丢掉没保存的修改。 */}
      <div hidden={tab !== "review"}>
        <ReviewSettingsForm repo={repo} onSaved={onRepositoryUpdated} />
      </div>
      <div hidden={tab !== "health"}>
        <HealthScheduleForm repo={repo} onSaved={onRepositoryUpdated} />
      </div>
      <div hidden={tab !== "development"}>
        <DevelopmentForm dev={development} repo={repo} />
      </div>
      <div hidden={tab !== "tasks"}>
        <DevelopmentTasks dev={development} repo={repo} />
      </div>
    </section>
  );
}
