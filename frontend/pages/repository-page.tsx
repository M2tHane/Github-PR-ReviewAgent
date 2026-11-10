import { Empty } from "../components/common/empty-state.js";
import { Status } from "../components/common/status-badge.js";
import { scheduleLabels } from "../features/repositories/repository-settings.js";
import { numberText } from "../format.js";
import type { Repository } from "../types.js";

// 仓库列表只放一行摘要，设置都在各仓库自己的页面里。
export function RepositoryPage({ items }: { items: Repository[] }) {
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>仓库</h2>
          <p className="muted">管理接入的仓库：启停、审查范围、定时健康检查和群内开发都按仓库设置。</p>
        </div>
      </div>
      {!items.length ? (
        <Empty>当前账号没有可管理的已接入仓库。</Empty>
      ) : (
        <div className="settings-list repo-list">
          {items.map((repo) => (
            <a href={`#repositories/${repo.id}`} key={repo.id}>
              <div>
                <h3>{repo.fullName}</h3>
                <p>
                  {repo.includePaths.length || repo.excludePaths.length
                    ? `审查范围：${repo.includePaths.length} 条包含、${repo.excludePaths.length} 条排除`
                    : "审查全部路径"}
                  {" · "}每次上限 {numberText(repo.budgetTokens)} tokens · 定时健康检查：
                  {scheduleLabels[repo.healthSchedule]}
                </p>
              </div>
              <Status value={repo.enabled ? "enabled" : "paused"} />
              <span aria-hidden="true">→</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
