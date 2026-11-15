import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Empty } from "../components/common/empty-state.js";
import { Pager } from "../components/common/pager.js";
import { Modal } from "../components/common/modal.js";
import type { Team, Repository } from "../types.js";
import { shortText } from "../../src/review/presentation.js";

type TeamsResponse = { teams: Team[]; canManageTeams: boolean; repositories: Repository[] };
export function TeamsPage({ reload }: { reload: () => Promise<void> }) {
  const [data, setData] = useState<TeamsResponse>();
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const load = async () => setData(await api<TeamsResponse>("/api/teams"));
  useEffect(() => {
    void load().catch((cause) => setError(messageOf(cause)));
  }, []);
  const selected = data?.teams.find((team) => team.id === selectedId);
  const shown = data?.teams.filter((team) => team.name.toLowerCase().includes(search.toLowerCase())) ?? [];
  const current = Math.min(page, Math.max(1, Math.ceil(shown.length / 12)));
  async function mutate(path: string, method: string, value?: object) {
    setError("");
    setBusy(true);
    try {
      await api(path, { method, body: JSON.stringify(value) });
      await load();
      await reload();
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="teams-page">
      <div className="section-head">
        <div>
          <h2>团队</h2>
          <p className="muted">团队管理员管理成员与共享规则；服务管理员设置团队、仓库归属与团队管理员。</p>
        </div>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p role="status">正在加载团队…</p>
      ) : (
        <>
          {data.canManageTeams && (
            <form
              className="card team-create"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                void mutate("/api/teams", "POST", { name: new FormData(form).get("name") }).then((ok) => {
                  if (ok) form.reset();
                });
              }}
            >
              <label>
                新团队名称
                <input name="name" required placeholder="例如：平台工程团队" />
              </label>
              <button disabled={busy}>创建团队</button>
            </form>
          )}
          <label>
            查找团队
            <input
              type="search"
              value={search}
              placeholder="按团队名称搜索"
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {!shown.length ? (
            <Empty>暂无符合条件的团队。</Empty>
          ) : (
            <div className="team-grid">
              {shown.slice((current - 1) * 12, current * 12).map((team) => (
                <article className="card team-card" key={team.id}>
                  <h3 title={team.name}>{team.name}</h3>
                  <p className="muted">
                    {team.repositoryIds.length} 个仓库 · {team.members.length} 位成员{team.canManage && " · 可管理"}
                  </p>
                  <div className="actions">
                    <button className="secondary" onClick={() => setSelectedId(team.id)}>
                      {team.canManage ? "管理团队" : "查看团队"}
                    </button>
                    <a className="button secondary" href={`#rules?team=${team.id}`}>
                      查看规则
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
          <Pager page={current} pageSize={12} total={shown.length} onPage={setPage} />
          {selected && (
            <Modal
              drawer
              titleId="team-title"
              onClose={() => {
                setSelectedId("");
                setDeleting(false);
              }}
            >
              <div className="drawer-head">
                <span className="eyebrow">团队管理</span>
                <button className="icon-button" aria-label="关闭团队" onClick={() => setSelectedId("")}>
                  ×
                </button>
              </div>
              <div className="drawer-body team-detail">
                <h2 id="team-title">{selected.name}</h2>
                {error && (
                  <p className="alert" role="alert">
                    {error}
                  </p>
                )}
                {data.canManageTeams && (
                  <form
                    key={selected.id + selected.name}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate(`/api/teams/${selected.id}`, "PATCH", {
                        name: new FormData(event.currentTarget).get("name"),
                      });
                    }}
                  >
                    <label>
                      团队名称
                      <input name="name" defaultValue={selected.name} required />
                    </label>
                    <button className="secondary" disabled={busy}>
                      保存名称
                    </button>
                  </form>
                )}
                <section className="rule-section">
                  <h3>仓库归属</h3>
                  <p className="muted">同一仓库可属于多个团队。移出后，相关项目覆盖一并移除。</p>
                  {data.canManageTeams ? (
                    <form
                      key={selected.id + selected.repositoryIds.join(",")}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void mutate(`/api/teams/${selected.id}/repositories`, "PUT", {
                          repositoryIds: new FormData(event.currentTarget).getAll("repositoryId").map(Number),
                        });
                      }}
                    >
                      <div className="team-repositories">
                        {data.repositories.map((repo) => (
                          <label className="check" key={repo.id}>
                            <input
                              name="repositoryId"
                              type="checkbox"
                              value={repo.id}
                              defaultChecked={selected.repositoryIds.includes(repo.id)}
                            />
                            {repo.fullName}
                          </label>
                        ))}
                      </div>
                      {!data.repositories.length && <p>暂无可划入仓库。</p>}
                      <button className="secondary" disabled={busy}>
                        保存仓库归属
                      </button>
                    </form>
                  ) : (
                    <ul>
                      {selected.repositoryIds.length ? (
                        selected.repositoryIds.map((id) => (
                          <li key={id}>
                            {data.repositories.find((repo) => repo.id === id)?.fullName ?? `仓库 #${id}`}
                          </li>
                        ))
                      ) : (
                        <li>暂无仓库</li>
                      )}
                    </ul>
                  )}
                </section>
                <section className="rule-section">
                  <h3>成员</h3>
                  <p className="muted">普通成员只表示团队归属。团队管理员可以管理共享规则；管理员由服务管理员指定。</p>
                  <ul className="team-members">
                    {selected.members.map((member) => (
                      <li key={member.login}>
                        <span>
                          {member.login}
                          <small>{member.role === "admin" ? "团队管理员" : "成员"}</small>
                        </span>
                        {(data.canManageTeams || (selected.canManage && member.role === "member")) && (
                          <button
                            className="text-button danger"
                            disabled={busy}
                            onClick={() =>
                              void mutate(`/api/teams/${selected.id}/members`, "DELETE", { login: member.login })
                            }
                          >
                            移除
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {!selected.members.length && <p className="muted">暂无成员，请由服务管理员指定管理员。</p>}
                  {selected.canManage && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget,
                          values = new FormData(form);
                        void mutate(`/api/teams/${selected.id}/members`, "PUT", {
                          login: values.get("login"),
                          role: values.get("role"),
                        }).then((ok) => {
                          if (ok) form.reset();
                        });
                      }}
                    >
                      <div className="row">
                        <label>
                          GitHub 用户名
                          <input name="login" required />
                        </label>
                        <label>
                          角色
                          <select name="role">
                            <option value="member">成员</option>
                            {data.canManageTeams && <option value="admin">团队管理员</option>}
                          </select>
                        </label>
                      </div>
                      <button className="secondary" disabled={busy}>
                        保存成员
                      </button>
                    </form>
                  )}
                </section>
                <a className="button secondary" href={`#rules?team=${selected.id}`}>
                  管理「{shortText(selected.name, 30)}」的规则
                </a>
                {data.canManageTeams && (
                  <section className="rule-section">
                    {!deleting ? (
                      <button className="text-button danger" onClick={() => setDeleting(true)}>
                        删除团队
                      </button>
                    ) : (
                      <>
                        <p className="alert">删除后，该团队的规则、成员、仓库归属和项目覆盖都会删除。</p>
                        <div className="actions">
                          <button className="secondary" onClick={() => setDeleting(false)}>
                            取消
                          </button>
                          <button
                            className="danger-button"
                            disabled={busy}
                            onClick={() =>
                              void mutate(`/api/teams/${selected.id}`, "DELETE").then((ok) => {
                                if (ok) {
                                  setSelectedId("");
                                  setDeleting(false);
                                }
                              })
                            }
                          >
                            确认删除团队
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                )}
              </div>
            </Modal>
          )}
        </>
      )}
    </section>
  );
}
