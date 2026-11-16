import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { dateText } from "../../format.js";
import { Check } from "../../components/common/icons.js";
import type { OnboardingRepository } from "../../../src/admin/repository-onboarding.routes.js";

export function RepositoryOnboarding({ onChange }: { onChange: () => Promise<void> }) {
  const [rows, setRows] = useState<OnboardingRepository[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setRows(await api<OnboardingRepository[]>("/api/repository-onboarding"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function toggle(row: OnboardingRepository) {
    setBusy(row.id);
    setError("");
    setNotice("");
    try {
      const updated = await api<OnboardingRepository>(`/api/repository-onboarding/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ allowed: !row.allowed }),
      });
      setRows((items) => items!.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(`${updated.fullName} 已${updated.allowed ? "接入" : "移出"}，最多 30 秒后所有实例生效。`);
      await onChange();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="settings-section repository-onboarding" aria-labelledby="onboarding-title">
      <div className="section-title">
        <h3 id="onboarding-title">
          仓库接入
          {rows && rows.length > 0 && (
            <span className="group-count">
              共 {rows.length.toLocaleString("zh-CN")} 个 · 已接入{" "}
              {rows.filter((row) => row.allowed).length.toLocaleString("zh-CN")} 个
            </span>
          )}
        </h3>
        <button type="button" className="ghost compact" disabled={loading || busy !== null} onClick={() => void load()}>
          {loading ? "读取中…" : "刷新列表"}
        </button>
      </div>
      <p className="muted section-note">
        选择已安装 GitHub App 的仓库接入服务，无需重启。移出后不再处理新事件，执行中的任务在发布前停止。
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="feedback" role="status">
          <Check />
          {notice}
        </p>
      )}
      {rows === null ? (
        loading && (
          <p className="muted" role="status">
            正在读取 App 安装的仓库…
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="muted">暂无已安装的仓库。先在 GitHub 安装 App 并选择仓库，再刷新列表。</p>
      ) : (
        <>
          <ul className="list onboarding-list" aria-label="仓库接入列表">
            {rows.map((row) => (
              <li key={row.id}>
                <div className="onboarding-info">
                  <span className="row-title" title={row.fullName}>
                    {row.fullName}
                  </span>
                  <span className="row-meta">
                    {row.source === "config" ? "由配置文件接入" : row.source === "admin" ? "由管理页接入" : "未接入"}
                    {row.revokedAt && ` · GitHub 授权已撤销于 ${dateText(row.revokedAt)}，请先在 GitHub 恢复授权`}
                    {row.allowedBy &&
                      ` · 最近操作：${row.allowedBy} 于 ${dateText(row.allowedAt)} ${row.managedAllowed ? "接入" : "移出"}`}
                  </span>
                </div>
                <label className="check onboarding-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${row.fullName} 接入服务`}
                    checked={row.allowed}
                    disabled={busy !== null || loading || row.source === "config" || Boolean(row.revokedAt)}
                    onChange={() => void toggle(row)}
                  />
                  {busy === row.id ? "保存中…" : row.allowed ? "已接入" : "未接入"}
                </label>
              </li>
            ))}
          </ul>
          <p className="muted onboarding-foot">
            由配置文件接入的仓库需修改 GITHUB_ALLOWED_REPOSITORIES
            并重启才能移出。这里的开关不改变仓库原有的审查启停设置。
          </p>
        </>
      )}
    </section>
  );
}
