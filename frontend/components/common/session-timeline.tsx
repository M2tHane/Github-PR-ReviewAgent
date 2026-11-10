import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { numberText } from "../../format.js";
import { Status } from "./status-badge.js";
import type { AgentSessionDetail, AgentSessionRow } from "../../../src/admin/dto.js";

type Step = AgentSessionDetail["timeline"][number];

const roleLabels: Record<string, string> = {
  general_review: "PR 审查",
  reply_handler: "回复复核",
  decision_extractor: "规则提取",
  health_auditor: "健康检查",
  security_auditor: "安全链路分析",
  developer: "开发",
  discussion: "issue 讨论",
  revision: "PR 评论修改",
};
const kindLabels: Record<Step["kind"], string> = {
  service: "服务",
  input: "输入",
  model: "模型",
  tool: "工具",
  note: "说明",
};
// 超过 1 分钟的步骤高亮，方便找到时间花在哪。
const SLOW_MS = 60_000;
// 展开的记录还在进行时，每 5 秒刷新一次。
const REFRESH_MS = 5_000;

const pad = (value: number) => String(value).padStart(2, "0");
export function durationText(ms?: number | null) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${pad(seconds % 60)}秒`;
  return `${Math.floor(minutes / 60)}时${pad(minutes % 60)}分`;
}
// 距离 Agent 启动的时间，例如 03:12；超过 1 小时显示 1:03:12。
function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600),
    rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours ? `${hours}:${rest}` : rest;
}

export function SessionTimeline({ sessions }: { sessions: AgentSessionRow[] }) {
  if (!sessions.length) return null;
  return (
    <div className="session-list">
      {sessions.map((session) => (
        <SessionItem key={session.id} session={session} />
      ))}
    </div>
  );
}

function SessionItem({ session }: { session: AgentSessionRow }) {
  const [detail, setDetail] = useState<AgentSessionDetail>(),
    [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  // 展开后才加载步骤（会话内容可能有几 MB）；还在进行时定时刷新，摘要也跟着更新。
  const current = detail ?? session;
  const running = current.status === "running";
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在展开、刷新时机变化时重新读取。
  useEffect(() => {
    if (!open || (detail && !running)) return;
    let stopped = false;
    const load = () => {
      setLoading(!detail);
      api<AgentSessionDetail>(`/api/agent-sessions/${session.id}`)
        .then(
          (value) => {
            if (stopped) return;
            setDetail(value);
            setError("");
          },
          (caught) => !stopped && setError(messageOf(caught)),
        )
        .finally(() => !stopped && setLoading(false));
    };
    if (!detail) load();
    const timer = running || !detail ? setInterval(load, REFRESH_MS) : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, running, session.id]);
  return (
    <details className="agent-session" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        执行过程 · {roleLabels[current.role] ?? current.role}
        {current.attempt > 1 ? ` · 第 ${current.attempt} 次` : ""} · <Status value={current.status} /> ·{" "}
        {durationText(current.duration_ms)} · {numberText(current.steps)} 步
      </summary>
      <p className="session-actions">
        <a href={`/api/agent-sessions/${session.id}/raw`} download>
          下载原始记录（JSONL）
        </a>
        {running && <span className="muted">进行中，每 5 秒自动刷新</span>}
        {current.truncated && <span className="muted">部分内容过长，已截断保存</span>}
      </p>
      {current.error && <p className="error">{current.error}</p>}
      {loading && <p className="muted">正在加载步骤…</p>}
      {error && <p className="error">{error}</p>}
      {detail &&
        (detail.timeline.length ? (
          <ol className="session-steps">
            {detail.timeline.map((step, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: 时间线只读，加载后不会增删或重排
                key={index}
                className={`session-step step-${step.kind}${step.error ? " step-error" : ""}${
                  (step.durationMs ?? 0) >= SLOW_MS ? " step-slow" : ""
                }`}
              >
                {step.detail ? (
                  <details>
                    <summary>
                      <StepLine step={step} />
                    </summary>
                    <pre>{step.detail}</pre>
                  </details>
                ) : (
                  <StepLine step={step} />
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">没有记录到步骤。</p>
        ))}
    </details>
  );
}

function StepLine({ step }: { step: Step }) {
  const meta = [durationText(step.durationMs), step.tokens ? `${numberText(step.tokens)} tokens` : ""].filter(Boolean);
  return (
    <span className="step-line">
      <time>{clock(step.at)}</time>
      <span className="step-kind">{kindLabels[step.kind]}</span>
      <span className="step-title">{step.title}</span>
      {meta.length > 0 && <span className="step-meta">{meta.join(" · ")}</span>}
    </span>
  );
}
