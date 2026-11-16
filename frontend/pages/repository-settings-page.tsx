import { useState } from "react";
import { api, messageOf } from "../api/client.js";
import { dateText } from "../format.js";
import { Status } from "../components/common/status-badge.js";
import { DevelopmentForm, DevelopmentTasks, useDevelopment } from "../features/repositories/development-settings.js";
import { Feedback, HealthScheduleForm, ReviewSettingsForm } from "../features/repositories/repository-settings.js";
import { ArrowLeft } from "../components/common/icons.js";
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
        <ArrowLeft />
        仓库
      </a>
      <div className="page-head">
        <h2 className="detail-title">{repo.fullName}</h2>
        <Status value={repo.enabled ? "enabled" : "paused"} />
      </div>
      <nav className="tabs" aria-label="仓库设置分类">
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
        <RulesSyncSettings repo={repo} onSaved={onRepositoryUpdated} />
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

function RulesSyncSettings({ repo, onSaved }: { repo: Repository; onSaved: (repo: Repository) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(enabled?: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (enabled !== undefined) {
        const updated = await api<Repository>(`/api/repositories/${repo.id}`, {
          method: "PATCH",
          body: JSON.stringify({ rulesSyncEnabled: enabled }),
        });
        onSaved(updated);
        setNotice(
          enabled
            ? repo.enabled
              ? "已开启，首次同步已加入队列。"
              : "已开启，将在仓库恢复启用后同步。"
            : "已关闭同步。已有 PR 仍由维护者处理。",
        );
      } else {
        const result = await api<{ jobId: string | null }>(`/api/repositories/${repo.id}/rules-sync`, {
          method: "POST",
        });
        setNotice(
          result.jobId
            ? "同步已加入队列；已有排队任务时会复用。完成后刷新页面查看结果。"
            : "仓库已暂停或同步已关闭，未加入队列。",
        );
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-labelledby={`rules-sync-${repo.id}`}>
      <h3 id={`rules-sync-${repo.id}`}>规则文件同步</h3>
      <div className="settings-form">
        <div className="setting-row">
          <div className="setting-label">
            <label htmlFor={`rules-sync-enabled-${repo.id}`}>通过 PR 把规则同步到仓库文件</label>
            <p className="muted">
              默认关闭。开启后，规则变更会更新 .pi-review/rules.md，并在 AGENTS.md／CLAUDE.md 引用，供本地 Codex／Claude
              Code 读取。服务只提 PR，由维护者决定是否合并。
            </p>
          </div>
          <div className="setting-control">
            <label className="check">
              <input
                id={`rules-sync-enabled-${repo.id}`}
                type="checkbox"
                checked={repo.rulesSyncEnabled}
                disabled={busy}
                onChange={(event) => void run(event.target.checked)}
              />
              {repo.rulesSyncEnabled ? "已开启" : "已关闭"}
            </label>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">最近一次同步</span>
            {repo.rulesSyncAt && <p className="muted">{dateText(repo.rulesSyncAt)}</p>}
          </div>
          <div className="setting-control setting-value">
            {!repo.rulesSyncStatus && (
              <span className="muted">{repo.rulesSyncEnabled ? "暂无记录，等待首次同步。" : "尚未开启同步。"}</span>
            )}
            {repo.rulesSyncStatus === "pr" && (
              <span className="property-wrap">
                规则 PR：
                <a href={repo.rulesSyncPrUrl!} target="_blank" rel="noreferrer">
                  {repo.rulesSyncPrUrl}
                </a>
              </span>
            )}
            {repo.rulesSyncStatus === "unchanged" && <span>无变化，默认分支中的规则文件已是最新。</span>}
            {repo.rulesSyncStatus === "failed" && <span className="error">同步失败：{repo.rulesSyncError}</span>}
          </div>
        </div>
        <div className="form-foot">
          <button type="button" disabled={busy || !repo.rulesSyncEnabled || !repo.enabled} onClick={() => void run()}>
            {busy ? "处理中…" : "立即同步"}
          </button>
          <Feedback error={error} notice={notice} />
        </div>
      </div>
    </section>
  );
}
