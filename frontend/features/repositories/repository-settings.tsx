import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { dateText } from "../../format.js";
import type { Repository } from "../../types.js";

export const scheduleLabels: Record<Repository["healthSchedule"], string> = {
  off: "关闭",
  daily: "每日",
  weekly: "每周",
};

function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="feedback" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

// 路径多时输入框跟着变高，最多 12 行，再多就在框里滚动。
const rows = (paths: string[]) => Math.min(12, Math.max(3, paths.length + 1));

// 启停、审查范围和资源上限：一个表单，一次保存。
export function ReviewSettingsForm({ repo, onSaved }: { repo: Repository; onSaved: (repo: Repository) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function save(form: HTMLFormElement) {
    const data = new FormData(form),
      lines = (name: string) =>
        String(data.get(name) ?? "")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      enabled = data.get("enabled") === "on";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await api<Repository>(`/api/repositories/${repo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          // 暂停会取消这个仓库的任务，只在开关真的变了时才带上。
          ...(enabled === repo.enabled ? {} : { enabled }),
          includePaths: lines("includePaths"),
          excludePaths: lines("excludePaths"),
          outputLanguage: data.get("outputLanguage"),
          budgetTokens: Number(data.get("budgetTokens")),
        }),
      });
      onSaved(updated);
      setNotice("审查设置已保存。");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="card repo-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(event.currentTarget);
      }}
    >
      <Feedback error={error} notice={notice} />
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={repo.enabled} /> 启用仓库
      </label>
      <p className="muted">启用后接收新的 PR 审查和健康检查；暂停后不会发布新的审查结果。</p>
      <div className="row">
        <label>
          包含路径（每行一个）
          <textarea
            name="includePaths"
            rows={rows(repo.includePaths)}
            defaultValue={repo.includePaths.join("\n")}
            placeholder="留空表示所有路径"
          />
        </label>
        <label>
          排除路径（每行一个）
          <textarea
            name="excludePaths"
            rows={rows(repo.excludePaths)}
            defaultValue={repo.excludePaths.join("\n")}
            placeholder="vendor/**"
          />
        </label>
      </div>
      <div className="row">
        <label>
          输出语言
          <input name="outputLanguage" required defaultValue={repo.outputLanguage} />
        </label>
        <label>
          每次任务的 Token 上限
          <input name="budgetTokens" type="number" min="1" required defaultValue={repo.budgetTokens} />
        </label>
      </div>
      <div className="repo-form-foot">
        <button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存审查设置"}
        </button>
        <small>
          GitHub App installation #{repo.installationId} ·{" "}
          <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">
            在 GitHub 查看 ↗
          </a>
        </small>
      </div>
    </form>
  );
}

export function HealthScheduleForm({ repo, onSaved }: { repo: Repository; onSaved: (repo: Repository) => void }) {
  const [schedule, setSchedule] = useState(repo.healthSchedule);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => setSchedule(repo.healthSchedule), [repo.healthSchedule]);
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onSaved(
        await api<Repository>(`/api/repositories/${repo.id}/health-schedule`, {
          method: "PATCH",
          body: JSON.stringify({ schedule }),
        }),
      );
      setNotice(schedule === "off" ? "定时检查已关闭。" : "定时检查已保存。");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="card repo-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Feedback error={error} notice={notice} />
      <label htmlFor="health-schedule">
        定时检查频率
        <select
          id="health-schedule"
          value={schedule}
          disabled={busy}
          onChange={(event) => setSchedule(event.target.value as Repository["healthSchedule"])}
        >
          <option value="off">关闭</option>
          <option value="daily" disabled={!repo.enabled}>
            每日
          </option>
          <option value="weekly" disabled={!repo.enabled}>
            每周
          </option>
        </select>
      </label>
      <p className="muted">
        默认关闭。启用后首个任务在一个周期后触发，统一按 UTC 计时。
        {!repo.enabled && "仓库已暂停，只能关闭定时检查。"}
      </p>
      {repo.healthNextRunAt && (
        <p>
          下次运行 <strong>{dateText(repo.healthNextRunAt)}</strong>
          <small className="health-utc">UTC {repo.healthNextRunAt.slice(0, 19).replace("T", " ")}</small>
        </p>
      )}
      {repo.healthLastError && <p className="error">{repo.healthLastError}</p>}
      <div className="repo-form-foot">
        <button type="submit" disabled={busy || (!repo.enabled && schedule !== "off")}>
          {busy ? "保存中…" : "保存频率"}
        </button>
        <a href={`#settings/health?repo=${repo.id}`}>查看健康报告、手动运行 →</a>
      </div>
    </form>
  );
}
