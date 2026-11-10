import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { SessionTimeline } from "../../components/common/session-timeline.js";
import { dateText } from "../../format.js";
import type { Repository } from "../../types.js";
import type { DevelopmentSettings } from "../../../src/development/types.js";
import type { AgentSessionRow } from "../../../src/admin/dto.js";
import { NotificationMembers } from "./notification-members.js";

type Task = {
  id: string;
  requester: string;
  status: string;
  kind?: "develop" | "discuss" | "notice" | "revise";
  issue_number?: number | null;
  target_branch: string;
  branch: string;
  pr_number: number | null;
  title: string | null;
  result: string | null;
  notification_status: string;
  notification_error: string | null;
  created_at: string;
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
        .then((data) => setTasks(data.tasks))
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
      setNotice("开发设置已保存。未发布任务会按新设置取消，请重新发起。");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return {
    settings,
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
  const { settings, configured, error, notice, busy, update, save } = dev;
  const [linking, setLinking] = useState(false);
  return (
    <div className="card repo-form">
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
      {!settings ? (
        !error && <p role="status">加载中…</p>
      ) : (
        <>
          {!configured && (
            <p className="alert">
              尚未配置智能机器人。请设置 Bot ID 和 Secret 后启用；原群通知 Webhook 无法接收 @ 消息。
            </p>
          )}
          <form onSubmit={save} className="development-form">
            <fieldset disabled={busy}>
              <legend>群与目标分支</legend>
              <label>
                群 ID
                <input
                  required
                  value={settings.chatId}
                  onChange={(e) => update({ chatId: e.target.value.trim() })}
                  placeholder="在群内 @ 智能机器人获取群 ID"
                />
              </label>
              <label>
                PR 目标分支
                <input
                  required
                  value={settings.targetBranch}
                  onChange={(e) => update({ targetBranch: e.target.value.trim() })}
                  placeholder="例如 dev 或 main"
                />
              </label>
              <p className="muted">
                每个群只能绑定一个仓库及目标分支。AI 从该分支创建新开发分支，完成后引用原需求回复 PR
                链接，不自动合并。PR 审查完成通知也发送到这个群，不再 @成员。
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  disabled={!configured}
                  onChange={(e) => update({ enabled: e.target.checked })}
                />
                启用群内开发任务
              </label>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>成员身份</legend>
              <p className="muted">按企业微信成员 ID 识别；未设置的成员不能发起任务。至少保留一名管理员。</p>
              {settings.members.map((member, index) => (
                <div className="development-member" key={member.key}>
                  <label>
                    成员 ID
                    <input
                      required
                      aria-label={`成员 ${index + 1} ID`}
                      value={member.userid}
                      onChange={(e) =>
                        update({
                          members: settings.members.map((m, i) =>
                            i === index ? { ...m, userid: e.target.value.trim() } : m,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    身份
                    <select
                      aria-label={`成员 ${index + 1} 身份`}
                      value={member.role}
                      onChange={(e) =>
                        update({
                          members: settings.members.map((m, i) =>
                            i === index ? { ...m, role: e.target.value as "admin" | "developer" } : m,
                          ),
                        })
                      }
                    >
                      <option value="developer">开发</option>
                      <option value="admin">管理员</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => update({ members: settings.members.filter((_, i) => i !== index) })}
                  >
                    移除成员
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary"
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
              <p className="muted">
                需求不清楚时 AI 会开 issue 讨论，只有提需求的人在 issue 里回复“开始”才会开发。按下面的关联认人：
                <button type="button" className="text-button" onClick={() => setLinking(true)}>
                  GitHub 账号关联
                </button>
              </p>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>文件保护规则</legend>
              <p className="muted">
                开发命中任意保护范围时整项拒绝。管理员发起的任务可修改这些文件，原规则继续有效。此设置由拥有仓库维护权限的管理页用户维护。
              </p>
              {settings.protections.map((rule, index) => (
                <div className="card development-rule" key={rule.key}>
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
                  <small>填写精确文件或以 / 结尾的目录；目录/** 也可，** 表示整个仓库。</small>
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
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => update({ protections: settings.protections.filter((_, i) => i !== index) })}
                  >
                    移除规则
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary"
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
            </fieldset>
            <button disabled={busy} type="submit">
              {busy ? "保存中…" : "保存开发设置"}
            </button>
          </form>
        </>
      )}
      {linking && <NotificationMembers repo={repo} onClose={() => setLinking(false)} />}
    </div>
  );
}

export function DevelopmentTasks({ dev, repo }: { dev: Development; repo: Repository }) {
  const { tasks, error, busy, refresh } = dev;
  return (
    <>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="subhead">
        <h3>最近的开发任务</h3>
        <button type="button" className="secondary" disabled={busy} onClick={refresh}>
          刷新
        </button>
      </div>
      {tasks.length >= 50 && <p className="muted">只显示最近 50 条。</p>}
      {!tasks.length && <p className="muted">还没有任务。在绑定群内 @Bot，发送文字，可在同一条消息中附图片。</p>}
      {tasks.map((task) => (
        <article className="card development-task" key={task.id}>
          <strong>
            {kindLabels[task.kind ?? "develop"]}
            {statuses[task.status] ?? task.status}
          </strong>
          <p>
            {task.requester} · {dateText(task.created_at)}
          </p>
          {task.issue_number && (
            <a
              href={`https://github.com/${repo.fullName}/issues/${task.issue_number}`}
              target="_blank"
              rel="noreferrer"
            >
              issue #{task.issue_number}
            </a>
          )}
          {task.result && <p>{task.result}</p>}
          {task.pr_number && (
            <a href={`https://github.com/${repo.fullName}/pull/${task.pr_number}`} target="_blank" rel="noreferrer">
              PR #{task.pr_number} {task.title}
            </a>
          )}
          <p className="muted">目标分支：{task.target_branch}</p>
          <SessionTimeline sessions={task.agent_sessions ?? []} />
          {task.status === "uncertain" && (
            <p>
              请核对分支：<code>{task.branch}</code>。不会自动重复创建 PR。
            </p>
          )}
          <small>
            群通知：
            {
              (
                {
                  pending: "待发送",
                  sending: "发送中",
                  sent: "已发送",
                  failed: "失败",
                  uncertain: "结果待核对",
                  skipped: "不发（只在 issue 里回复）",
                } as Record<string, string>
              )[task.notification_status]
            }
          </small>
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
        </article>
      ))}
    </>
  );
}
