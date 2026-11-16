import { Select } from "../../components/common/select.js";
import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { SessionTimeline } from "../../components/common/session-timeline.js";
import { Status } from "../../components/common/status-badge.js";
import { dateText, numberText, usageText, usageTotal } from "../../format.js";
import type { Repository } from "../../types.js";
import type { DevelopmentSettings, DevelopmentSource } from "../../../src/development/types.js";
import type { AgentSessionRow } from "../../../src/admin/dto.js";
import type { AgentUsage } from "../../../src/review/agent.js";
import { NotificationMembers } from "./notification-members.js";
import { Feedback } from "./repository-settings.js";
import { Empty } from "../../components/common/empty-state.js";
import { Check, External } from "../../components/common/icons.js";
import { PropertyList } from "../../components/common/property-list.js";

type Task = {
  id: string;
  requester: string | null;
  requester_login: string | null;
  source: DevelopmentSource;
  status: string;
  kind?: "develop" | "discuss" | "notice" | "revise";
  issue_number?: number | null;
  target_branch: string;
  branch: string;
  pr_number: number | null;
  title: string | null;
  prompt_summary: string;
  result: string | null;
  notification_status: string;
  notification_error: string | null;
  created_at: string;
  usage?: Partial<AgentUsage> | null;
  agent_sessions?: AgentSessionRow[];
};
type EditableSettings = Omit<DevelopmentSettings, "members" | "protections"> & {
  members: Array<DevelopmentSettings["members"][number] & { key: string }>;
  protections: Array<DevelopmentSettings["protections"][number] & { key: string }>;
};
function editable(settings: DevelopmentSettings): EditableSettings {
  return {
    ...settings,
    members: settings.members.map((m) => ({ ...m, key: crypto.randomUUID() })),
    protections: settings.protections.map((p) => ({ ...p, key: crypto.randomUUID() })),
  };
}
type Response = { settings?: DevelopmentSettings; configured: boolean; tasks: Task[] };
const kindLabels: Record<NonNullable<Task["kind"]>, string> = {
  develop: "",
  discuss: "issue 讨论回复 · ",
  notice: "提示 · ",
  revise: "PR 评论处理 · ",
};
const sourceLabels: Record<DevelopmentSource, string> = {
  wecom: "群消息",
  issue: "issue",
  pr_comment: "PR 评论",
  admin: "管理页",
  issue_label: "issue 标签",
};
const statuses: Record<string, string> = {
  queued: "等待执行",
  running: "开发中",
  publishing: "创建 PR 中",
  succeeded: "已完成",
  refused: "已拒绝",
  discussing: "已开 issue 讨论",
  failed: "失败",
  cancelled: "已取消",
  uncertain: "发布待核对",
};
// 设置和任务来自同一个接口；表单和任务列表分在两个页签里，共用这份状态。
export function useDevelopment(repo: Repository) {
  const [settings, setSettings] = useState<EditableSettings>();
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false),
    [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const endpoint = `/api/repositories/${repo.id}/development`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 刷新按钮通过 reload 主动重新读取服务器设置。
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<Response>(endpoint, { signal: controller.signal })
      .then((data) => {
        setConfigured(data.configured);
        setEnabled(data.settings?.enabled ?? false);
        setTasks(data.tasks);
        setSettings(
          editable(
            data.settings ?? { chatId: "", targetBranch: "", enabled: false, members: [], protections: [], version: 0 },
          ),
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      });
    return () => controller.abort();
  }, [endpoint, reload]);
  // 有排队或进行中的任务时每 5 秒刷新任务列表（不动正在编辑的设置），能看到任务开始、结束和新的执行记录。
  const active = tasks.some((task) => ["queued", "running", "publishing"].includes(task.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      api<Response>(endpoint)
        .then((data) => {
          setTasks(data.tasks);
          setEnabled(data.settings?.enabled ?? false);
        })
        .catch(() => undefined);
    }, 5_000);
    return () => clearInterval(timer);
  }, [active, endpoint]);
  function update(patch: Partial<EditableSettings>) {
    setSettings((s) => s && { ...s, ...patch });
    setNotice("");
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ settings: DevelopmentSettings }>(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          ...settings,
          members: settings!.members.map(({ key: _key, ...member }) => member),
          protections: settings!.protections.map(({ key: _key, ...rule }) => rule),
        }),
      });
      setSettings(editable(result.settings));
      setEnabled(result.settings.enabled);
      setNotice("开发设置已保存。未发布任务会按新设置取消，请重新发起。");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return {
    settings,
    enabled,
    configured,
    tasks,
    error,
    notice,
    busy,
    update,
    save,
    refresh: () => setReload((v) => v + 1),
  };
}
type Development = ReturnType<typeof useDevelopment>;

export function DevelopmentForm({ dev, repo }: { dev: Development; repo: Repository }) {
  const { settings, error, notice, busy, update, save } = dev;
  const [linking, setLinking] = useState(false);
  const id = (name: string) => `dev-${repo.id}-${name}`;
  return (
    <div className="dev-settings">
      {!settings ? (
        error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted" role="status">
            加载中…
          </p>
        )
      ) : (
        <form onSubmit={save} className="settings-form development-form">
          <fieldset className="form-section" disabled={busy}>
            <legend>目标分支与群绑定</legend>
            <div className="setting-row">
              <div className="setting-label">
                <label htmlFor={id("chat")}>群 ID（可选）</label>
                <p className="muted">绑定企微群后，群消息任务和 PR 审查通知发送到该群。</p>
              </div>
              <div className="setting-control">
                <input
                  id={id("chat")}
                  value={settings.chatId}
                  onChange={(e) => update({ chatId: e.target.value.trim() })}
                  placeholder="在群内 @ 智能机器人获取群 ID"
                />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <label htmlFor={id("branch")}>PR 目标分支</label>
                <p className="muted">
                  AI 从目标分支创建开发分支并提 PR，不自动合并。只用管理页或 issue 标签派任务时，群 ID 和成员可以留空。
                </p>
              </div>
              <div className="setting-control">
                <input
                  id={id("branch")}
                  required
                  value={settings.targetBranch}
                  onChange={(e) => update({ targetBranch: e.target.value.trim() })}
                  placeholder="例如 dev 或 main"
                />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-label">
                <label htmlFor={id("enabled")}>启用开发任务</label>
              </div>
              <div className="setting-control">
                <label className="check">
                  <input
                    id={id("enabled")}
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  {settings.enabled ? "已启用" : "未启用"}
                </label>
              </div>
            </div>
          </fieldset>
          <fieldset className="form-section" disabled={busy}>
            <legend>成员身份</legend>
            <p className="muted">
              仅用于企微群内派任务，按企业微信成员 ID 识别。绑定群时至少保留一名管理员；不绑群时可留空。
            </p>
            {settings.members.length > 0 && (
              <div className="list member-list">
                {settings.members.map((member, index) => (
                  <div className="member-row" key={member.key}>
                    <input
                      required
                      aria-label={`成员 ${index + 1} ID`}
                      placeholder="成员 ID"
                      value={member.userid}
                      onChange={(e) =>
                        update({
                          members: settings.members.map((m, i) =>
                            i === index ? { ...m, userid: e.target.value.trim() } : m,
                          ),
                        })
                      }
                    />
                    <Select
                      aria-label={`成员 ${index + 1} 身份`}
                      value={member.role}
                      onChange={(value) =>
                        update({
                          members: settings.members.map((m, i) =>
                            i === index ? { ...m, role: value as "admin" | "developer" } : m,
                          ),
                        })
                      }
                    >
                      <option value="developer">开发</option>
                      <option value="admin">管理员</option>
                    </Select>
                    <button
                      type="button"
                      className="ghost compact"
                      onClick={() => update({ members: settings.members.filter((_, i) => i !== index) })}
                    >
                      移除成员
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="form-inline">
              <button
                type="button"
                className="compact"
                onClick={() =>
                  update({
                    members: [
                      ...settings.members,
                      { userid: "", role: settings.members.length ? "developer" : "admin", key: crypto.randomUUID() },
                    ],
                  })
                }
              >
                添加成员
              </button>
            </div>
            <p className="muted">
              需求不清楚时 AI 会开 issue 讨论，只有提需求的人在 issue 里回复“开始”才会开发。按下面的关联认人：
              <button type="button" className="link-button" onClick={() => setLinking(true)}>
                GitHub 账号关联
              </button>
            </p>
          </fieldset>
          <fieldset className="form-section" disabled={busy}>
            <legend>文件保护规则</legend>
            <p className="muted">
              开发命中任意保护范围时整项拒绝。管理员发起的任务可修改这些文件，原规则继续有效。此设置由拥有仓库维护权限的管理页用户维护。
            </p>
            {settings.protections.length > 0 && (
              <div className="list protection-list">
                {settings.protections.map((rule, index) => (
                  <div className="protection-row" key={rule.key}>
                    <div className="protection-main">
                      <label>
                        规则名称
                        <input
                          required
                          value={rule.name}
                          onChange={(e) =>
                            update({
                              protections: settings.protections.map((r, i) =>
                                i === index ? { ...r, name: e.target.value } : r,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        规则说明
                        <textarea
                          required
                          value={rule.reason}
                          onChange={(e) =>
                            update({
                              protections: settings.protections.map((r, i) =>
                                i === index ? { ...r, reason: e.target.value } : r,
                              ),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="protection-paths">
                      <label>
                        保护范围（每行一个）
                        <textarea
                          required
                          value={rule.paths.join("\n")}
                          placeholder={"src/billing/\nconfig/production.json"}
                          onChange={(e) =>
                            update({
                              protections: settings.protections.map((r, i) =>
                                i === index ? { ...r, paths: e.target.value.split("\n") } : r,
                              ),
                            })
                          }
                        />
                      </label>
                      <small className="muted">填写精确文件或以 / 结尾的目录；目录/** 也可，** 表示整个仓库。</small>
                      <button
                        type="button"
                        className="ghost compact"
                        onClick={() => update({ protections: settings.protections.filter((_, i) => i !== index) })}
                      >
                        移除规则
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="form-inline">
              <button
                type="button"
                className="compact"
                onClick={() =>
                  update({
                    protections: [
                      ...settings.protections,
                      { name: "", paths: [], reason: "", key: crypto.randomUUID() },
                    ],
                  })
                }
              >
                添加保护规则
              </button>
            </div>
          </fieldset>
          <div className="form-foot">
            <button className="primary" disabled={busy} type="submit">
              {busy ? "保存中…" : "保存开发设置"}
            </button>
            <Feedback error={error} notice={notice} />
          </div>
        </form>
      )}
      {linking && <NotificationMembers repo={repo} onClose={() => setLinking(false)} />}
    </div>
  );
}

const notificationLabels: Record<string, string> = {
  pending: "待发送",
  sending: "发送中",
  sent: "已发送",
  failed: "失败",
  uncertain: "结果待核对",
  skipped: "不发送",
};

export function DevelopmentTasks({ dev, repo }: { dev: Development; repo: Repository }) {
  const { tasks, error, busy, refresh, enabled, settings } = dev;
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError("");
    setSubmitted(false);
    try {
      await api(`/api/repositories/${repo.id}/development/tasks`, { method: "POST", body: JSON.stringify({ prompt }) });
      setPrompt("");
      setSubmitted(true);
      refresh();
    } catch (cause) {
      setSubmitError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="panel task-form">
        <label htmlFor={`task-prompt-${repo.id}`} className="task-form-title">
          新建开发任务
        </label>
        <p className="muted">
          描述希望实现的效果，AI 会创建开发分支并提 PR。结果显示在下方，需要确认时会开 issue 讨论。
          {!enabled && (settings ? "请先在开发设置中保存目标分支并启用开发任务。" : "正在读取开发设置…")}
        </p>
        <textarea
          id={`task-prompt-${repo.id}`}
          required
          maxLength={12000}
          rows={4}
          value={prompt}
          disabled={!enabled || submitting}
          onChange={(event) => {
            setPrompt(event.target.value);
            setSubmitted(false);
          }}
          placeholder="例如：为订单列表增加按日期筛选，并验证空结果的展示。"
        />
        <div className="form-foot">
          <button type="submit" className="primary" disabled={!enabled || submitting || !prompt.trim()}>
            {submitting ? "提交中…" : "提交开发任务"}
          </button>
          {submitError && (
            <p className="alert inline-alert" role="alert">
              {submitError}
            </p>
          )}
          {submitted && (
            <p className="feedback" role="status">
              <Check />
              开发任务已加入队列，可在下方查看进度。
            </p>
          )}
          <span className="form-foot-end muted tabular">{numberText(prompt.length)} / 12,000 字</span>
        </div>
      </form>
      <div className="section-title">
        <h3>最近的开发任务 {tasks.length > 0 && <span className="group-count">{tasks.length}</span>}</h3>
        <button type="button" className="ghost compact" disabled={busy} onClick={refresh}>
          刷新
        </button>
      </div>
      {tasks.length >= 50 && <p className="muted tab-note">只显示最近 50 条。</p>}
      {!tasks.length && <Empty>还没有任务。可在上方提交需求，或为 GitHub issue 添加 pi-dev 标签。</Empty>}
      {tasks.length > 0 && (
        <div className="list task-list">
          {tasks.map((task) => {
            const title = task.title || task.prompt_summary;
            return (
              <details
                className="task-row"
                key={task.id}
                // 失败和发布待核对的任务需要人看，默认展开。
                open={task.status === "failed" || task.status === "uncertain"}
              >
                <summary className="list-row">
                  <Status value={task.status} label={statuses[task.status]} icon />
                  <span className={`row-title${title ? "" : " muted"}`} title={title || undefined}>
                    {title || "未命名任务"}
                  </span>
                  <span className="row-meta col-source" title={task.requester_login ?? task.requester ?? undefined}>
                    {kindLabels[task.kind ?? "develop"]}
                    {sourceLabels[task.source]} · {task.requester_login ?? task.requester}
                  </span>
                  <span className="row-meta col-ref">
                    {task.pr_number ? `PR #${task.pr_number}` : task.issue_number ? `issue #${task.issue_number}` : ""}
                  </span>
                  <span className="col-status">
                    <Status value={task.status} label={statuses[task.status]} plain />
                  </span>
                  <time className="row-meta col-date" dateTime={task.created_at}>
                    {dateText(task.created_at)}
                  </time>
                </summary>
                <div className="task-body">
                  {task.result && <p className="task-result">{task.result}</p>}
                  <PropertyList
                    items={[
                      task.pr_number && [
                        "PR",
                        <a
                          href={`https://github.com/${repo.fullName}/pull/${task.pr_number}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PR #{task.pr_number} {task.title}
                          <External />
                        </a>,
                      ],
                      task.issue_number && [
                        "issue",
                        <a
                          href={`https://github.com/${repo.fullName}/issues/${task.issue_number}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          issue #{task.issue_number}
                          <External />
                        </a>,
                      ],
                      ["目标分支", <code>{task.target_branch}</code>],
                      usageTotal({ usage: task.usage }) !== undefined && [
                        "用量",
                        <span className="usage-text">
                          {numberText(usageTotal({ usage: task.usage }))} tokens · {usageText({ usage: task.usage })}
                        </span>,
                      ],
                      ["群通知", notificationLabels[task.notification_status] ?? task.notification_status],
                    ]}
                  />
                  {task.status === "uncertain" && (
                    <p>
                      请核对分支：<code>{task.branch}</code>。不会自动重复创建 PR。
                    </p>
                  )}
                  {task.notification_error && (
                    <p className="muted">
                      {task.notification_error === "reply_window_expired"
                        ? "原消息已超过 24 小时回复期限，请在这里查看任务结果。"
                        : task.notification_error === "reply_context_missing"
                          ? "此任务没有保存原消息回复标识，请在这里查看结果。"
                          : task.notification_error === "repository_or_binding_changed"
                            ? "仓库或群绑定已变化，已停止发送旧通知。"
                            : "群回复未确认成功，请先检查群消息；不会自动重复发送。"}
                    </p>
                  )}
                  <SessionTimeline sessions={task.agent_sessions ?? []} />
                </div>
              </details>
            );
          })}
        </div>
      )}
    </>
  );
}
