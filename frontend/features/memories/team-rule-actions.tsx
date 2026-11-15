import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import type { Memory, Repository, RuleOverride, Team } from "../../types.js";
import { ruleLevelLabels, type RuleLevel } from "../../../src/memory/types.js";
import { shortText } from "../../../src/review/presentation.js";

export function TeamRuleActions({
  item,
  teams,
  repository,
  reload,
}: {
  item: Memory;
  teams: Team[];
  repository?: Repository;
  reload: () => Promise<void>;
}) {
  const eligible = teams.filter((team) => item.repositoryId !== null && team.repositoryIds.includes(item.repositoryId));
  const [teamId, setTeamId] = useState(eligible[0]?.id ?? "");
  const [override, setOverride] = useState<RuleOverride>();
  const [action, setAction] = useState("disable");
  const [level, setLevel] = useState<RuleLevel>(item.level);
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const loadOverride = async () => {
    const data = await api<{ overrides: RuleOverride[] }>(`/api/repositories/${repository!.id}/team-rules`);
    const current = data.overrides.find((entry) => entry.memoryId === item.id);
    setOverride(current);
    setReason(current?.reason ?? "");
    setAction(current?.action ?? "disable");
    setLevel(current?.level ?? item.level);
  };
  useEffect(() => {
    if (item.teamId && repository) void loadOverride().catch((cause) => setError(messageOf(cause)));
  }, [item.id, repository?.id]);
  async function save(path: string, method: string, value?: object) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await api(path, { method, body: JSON.stringify(value) });
      if (item.teamId) {
        await loadOverride();
        setCancelling(false);
        setNotice(method === "DELETE" ? "已恢复采用团队规则。" : "已保存本项目覆盖。");
      } else setNotice("已提交团队候选，等待团队管理员确认。原项目规则在批准前继续生效。");
      await reload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!(item.teamId && repository) && !(item.repositoryId !== null && (item.status === "ACTIVE" || item.activeVersion)))
    return null;
  return (
    <section className="rule-section team-rule-actions">
      {item.teamId && repository ? (
        <>
          <h3>在本项目覆盖</h3>
          <p className="muted">{repository.fullName} · 只调整本项目，填写理由后保存。</p>
          {override ? (
            <div className="override-current">
              <strong>
                {override.action === "disable" ? "在本项目停用" : `本项目级别：${ruleLevelLabels[override.level!]}`}
              </strong>
              <p className="rule-content">{override.reason}</p>
              <small>操作人：{override.actor}</small>
            </div>
          ) : (
            <p>当前采用团队级别：{ruleLevelLabels[item.level]}</p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(
                `/api/repositories/${repository.id}/rule-overrides/${item.id}`,
                cancelling ? "DELETE" : "PUT",
                cancelling
                  ? { reason }
                  : {
                      action,
                      level: action === "level" ? level : null,
                      reason,
                    },
              );
            }}
          >
            {!cancelling && (
              <label>
                项目覆盖
                <select value={action} onChange={(event) => setAction(event.target.value)}>
                  <option value="disable">在本项目停用</option>
                  <option value="level">调整本项目级别</option>
                </select>
              </label>
            )}
            {!cancelling && action === "level" && (
              <label>
                本项目级别
                <select value={level} onChange={(event) => setLevel(event.target.value as RuleLevel)}>
                  {Object.entries(ruleLevelLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {cancelling ? "取消覆盖理由" : "覆盖理由"}
              <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="actions">
              <button disabled={busy}>{cancelling ? "确认取消覆盖" : "保存项目覆盖"}</button>
              {override && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setCancelling(!cancelling);
                    setReason(cancelling ? override.reason : "");
                  }}
                >
                  {cancelling ? "返回修改覆盖" : "取消覆盖"}
                </button>
              )}
            </div>
          </form>
        </>
      ) : (
        <>
          <h3>提升为团队规则</h3>
          <p className="muted">复制当前生效版本为团队候选。团队管理员批准后，本项目原规则变为已替代。</p>
          {eligible.length ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(`/api/repositories/${item.repositoryId}/promotions/${item.id}`, "POST", { teamId });
              }}
            >
              <label>
                目标团队
                <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                  {eligible.map((team) => (
                    <option key={team.id} value={team.id}>
                      {shortText(team.name, 80)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="secondary" disabled={busy || !teamId}>
                提交团队候选
              </button>
            </form>
          ) : (
            <p className="muted">本项目尚未划入团队，请服务管理员先设置仓库归属。</p>
          )}
        </>
      )}
      {notice && (
        <p className="feedback" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
