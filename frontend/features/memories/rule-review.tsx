import { Select } from "../../components/common/select.js";
import { useState } from "react";
import type { RuleReviewItem, RuleReviewReason } from "../../../src/memory/types.js";
import { api, messageOf } from "../../api/client.js";
import { dateText, numberText } from "../../format.js";
import { Status } from "../../components/common/status-badge.js";
import type { Repository } from "../../types.js";

const labels: Record<RuleReviewReason["reason"], string> = {
  noisy: "噪声大",
  sleeping: "沉睡",
  path_invalid: "路径失效",
  expired: "已到期",
};
function evidence(reason: RuleReviewReason) {
  switch (reason.reason) {
    case "noisy":
      return `引用 ${numberText(reason.cited)} 次，撤回 ${numberText(reason.withdrawn)} 次（${Math.round(reason.withdrawnRatio * 100)}%）`;
    case "sleeping":
      return `自 ${dateText(reason.approvedAt)} 生效，最近 ${reason.days} 天未被引用${reason.lastCitedAt ? `；上次引用 ${dateText(reason.lastCitedAt)}` : ""}`;
    case "path_invalid":
      return `${reason.repositories} 个适用仓库的默认分支均无匹配文件：${reason.paths.join("、")}`;
    case "expired":
      return `到期时间：${dateText(reason.expiresAt)}`;
  }
}
export function RuleReviewRows({
  items,
  repositories,
  suffix,
  refresh,
}: {
  items: RuleReviewItem[];
  repositories: Repository[];
  suffix: string;
  refresh: () => Promise<void>;
}) {
  const [dismiss, setDismiss] = useState<{ id: string; reason: RuleReviewReason["reason"] } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="list rule-list">
      {items.map(({ memory, reasons }) => {
        const repository = repositories.find((repo) => repo.id === memory.repositoryId)?.fullName;
        return (
          <article className="rule-row rule-row-review" key={memory.id}>
            <div className="list-row">
              <Status value="CANDIDATE" label="需要复查" icon />
              <a className="row-title rule-open" href={`#rules/${memory.id}${suffix}`} title={memory.title}>
                {memory.title}
              </a>
              <span className="row-meta col-repo" title={repository}>
                {repository}
              </span>
              <button
                className="compact row-action"
                onClick={() => {
                  setDismiss({ id: memory.id, reason: reasons[0]!.reason });
                  setError("");
                }}
              >
                暂不处理
              </button>
            </div>
            <ul className="rule-review-reasons">
              {reasons.map((reason) => (
                <li key={reason.reason}>
                  <span className="chip">{labels[reason.reason]}</span>
                  <span>{evidence(reason)}</span>
                </li>
              ))}
            </ul>
            {dismiss?.id === memory.id && (
              <form
                className="rule-review-dismiss"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const note = String(new FormData(event.currentTarget).get("note")).trim();
                  setBusy(true);
                  setError("");
                  try {
                    await api(`/api/memories/${memory.id}/dismiss-review`, {
                      method: "POST",
                      body: JSON.stringify({ reason: dismiss.reason, note }),
                    });
                    await refresh();
                    setDismiss(null);
                  } catch (cause) {
                    setError(messageOf(cause));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  暂不处理的原因项
                  <Select
                    value={dismiss.reason}
                    onChange={(value) => setDismiss({ ...dismiss, reason: value as RuleReviewReason["reason"] })}
                  >
                    {reasons.map((reason) => (
                      <option key={reason.reason} value={reason.reason}>
                        {labels[reason.reason]}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  处理理由
                  <textarea name="note" required placeholder="说明为什么暂时保留这条规则" />
                </label>
                <p className="muted">保存后，这条规则的所选原因在 90 天内不再提示；其他原因仍保留。</p>
                {error && (
                  <p className="alert" role="alert">
                    {error}
                  </p>
                )}
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => setDismiss(null)}>
                    取消
                  </button>
                  <button className="primary" disabled={busy}>
                    {busy ? "保存中…" : "保存理由"}
                  </button>
                </div>
              </form>
            )}
          </article>
        );
      })}
    </div>
  );
}
