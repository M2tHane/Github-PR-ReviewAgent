import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { Modal } from "../../components/common/modal.js";
import type { Repository } from "../../types.js";
import type { NotificationMember } from "../../../src/notifications/members.js";

type MembersResponse = { members: NotificationMember[]; configured: boolean };

export function NotificationMembers({ repo, onClose }: { repo: Repository; onClose: () => void }) {
  const [data, setData] = useState<MembersResponse>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState("");
  const [userid, setUserid] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const endpoint = `/api/repositories/${repo.id}/notification-members`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<MembersResponse>(endpoint, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, reload]);

  function reset() {
    setFormOpen(false);
    setEditing(undefined);
    setLogin("");
    setUserid("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const member = await api<NotificationMember>(endpoint, {
        method: "PUT",
        body: JSON.stringify({ githubLogin: login.trim(), wecomUserId: userid.trim() }),
      });
      setData(
        (current) =>
          current && {
            ...current,
            members: [...current.members.filter((item) => item.githubLogin !== member.githubLogin), member].sort(
              (a, b) => a.githubLogin.localeCompare(b.githubLogin),
            ),
          },
      );
      reset();
      setNotice(`已保存 ${member.githubLogin} 的关联，后续发送的通知立即使用新设置。`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(githubLogin: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`${endpoint}/${encodeURIComponent(githubLogin)}`, { method: "DELETE" });
      setData(
        (current) =>
          current && { ...current, members: current.members.filter((member) => member.githubLogin !== githubLogin) },
      );
      setRemoving(undefined);
      if (editing === githubLogin) reset();
      setNotice(`已删除 ${githubLogin} 的通知关联。`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        drawer
        titleId="notification-members-title"
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="drawer-head">
          <p className="eyebrow">项目设置</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭 GitHub 账号关联"
          >
            关闭
          </button>
        </div>
        <div className="drawer-body notification-members">
          <h2 id="notification-members-title">GitHub 账号关联</h2>
          <p className="notification-repository">{repo.fullName}</p>
          <p className="muted">
            把企业微信成员 ID 和 GitHub 账号对应起来。需求 issue 里，只有提需求的人关联的 GitHub
            账号回复“开始”才会开发。
          </p>
          {loading && <p role="status">正在加载成员…</p>}
          {error && !formOpen && !removing && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="feedback" role="status">
              {notice}
            </p>
          )}
          {!loading && !data && (
            <button type="button" className="secondary" onClick={() => setReload((value) => value + 1)}>
              重新加载
            </button>
          )}
          {data && !loading && (
            <>
              <div className="subhead notification-member-toolbar">
                <h3>
                  成员关联 <span className="muted">{data.members.length}</span>
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setError("");
                    setNotice("");
                    setFormOpen(true);
                  }}
                >
                  添加成员
                </button>
              </div>
              <div className="table-wrap">
                <table className="notification-member-table" aria-label="项目成员关联">
                  <thead>
                    <tr>
                      <th scope="col">GitHub 账号</th>
                      <th scope="col">企业微信成员 ID</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((member) => (
                      <tr key={member.githubLogin}>
                        <td>
                          <a href={`https://github.com/${member.githubLogin}`} target="_blank" rel="noreferrer">
                            {member.githubLogin} ↗
                          </a>
                        </td>
                        <td>{member.wecomUserId}</td>
                        <td>
                          <div className="actions">
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`编辑 ${member.githubLogin}`}
                              onClick={() => {
                                setEditing(member.githubLogin);
                                setLogin(member.githubLogin);
                                setUserid(member.wecomUserId);
                                setError("");
                                setNotice("");
                                setFormOpen(true);
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`删除 ${member.githubLogin}`}
                              onClick={() => {
                                setError("");
                                setNotice("");
                                setRemoving(member.githubLogin);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!data.members.length && (
                      <tr>
                        <td colSpan={3} className="muted">
                          还没有关联成员。点击右上角“添加成员”设置通知对象。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </Modal>
      {formOpen && (
        <Modal
          titleId="notification-member-form-title"
          onClose={() => {
            if (!busy) reset();
          }}
        >
          <form className="notification-member-form" onSubmit={(event) => void save(event)}>
            <h2 id="notification-member-form-title">{editing ? `编辑 ${editing}` : "添加成员关联"}</h2>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            <label>
              GitHub 登录名
              <input
                name="githubLogin"
                value={login}
                readOnly={Boolean(editing)}
                disabled={busy}
                required
                maxLength={39}
                placeholder="例如 alice，不含 @"
                autoComplete="off"
                onChange={(event) => setLogin(event.target.value)}
              />
            </label>
            <label>
              企业微信成员 ID
              <input
                name="wecomUserId"
                value={userid}
                disabled={busy}
                required
                maxLength={64}
                placeholder="通讯录中的成员账号，不是显示姓名"
                autoComplete="off"
                onChange={(event) => setUserid(event.target.value)}
              />
            </label>
            <p className="muted">
              请确认成员已加入通知群。关联仅对当前项目生效；同一 GitHub 账号在其他项目可设置不同的企业微信 ID。
            </p>
            <div className="actions">
              <button type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存关联"}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={reset}>
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          titleId="notification-member-delete-title"
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <h2 id="notification-member-delete-title">删除成员关联</h2>
          <p>
            确认删除 {removing} 在 {repo.fullName} 的关联？删除后，该成员不会收到此项目的 @ 通知。
          </p>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(undefined)}>
              取消
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove(removing)}>
              {busy ? "删除中…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
