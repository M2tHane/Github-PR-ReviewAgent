import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { Empty } from "../../components/common/empty-state.js";
import { Status, statusLabels } from "../../components/common/status-badge.js";
import { shortText } from "../../../src/review/presentation.js";
import type { Repository as Repo } from "../../types.js";

export function Discussions({ items }: { items: any[] }) {
  if (!items.length) return <Empty>暂无讨论记录。</Empty>;
  return (
    <div className="discussion-list">
      {items.map((item) => {
        const link = item.github_reply_url
          ? { href: item.github_reply_url, label: "查看回复 ↗" }
          : item.github_comment_id
            ? {
                href: `https://github.com/${item.repository}/pull/${item.pr_number}#discussion_r${item.github_comment_id}`,
                label: "查看原讨论 ↗",
              }
            : null;
        return (
          <article className="discussion" key={item.id + "-" + (item.source_comment_id ?? "root")}>
            <div className="card-head">
              <h3>{item.presentation?.display?.title ?? shortText(item.description, 80)}</h3>
              <Status value={item.status} />
            </div>
            <p className="muted discussion-where">
              {item.path ? `${item.path}${item.line ? ":" + item.line : ""}` : "整体变更"}
            </p>
            {item.human_reply_body && (
              <blockquote>
                <strong>{item.human_actor_login ?? "维护者"}：</strong>
                {item.human_reply_body}
              </blockquote>
            )}
            {item.reply_result && (
              <p>
                <strong>{statusLabels[item.reply_result.suggestedFindingStatus] ?? "复核结果"}</strong> ·{" "}
                {item.reply_result.summary}
              </p>
            )}
            {link && (
              <p>
                <a href={link.href} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              </p>
            )}
            <details>
              <summary>复核依据与详情</summary>
              <p>{item.evidence}</p>
              {item.reply_result && (
                <>
                  <ul>
                    {item.reply_result.evidence.map((entry: any, i: number) => (
                      <li key={i}>
                        {entry.path && (
                          <code>
                            {entry.path}
                            {entry.line ? ":" + entry.line : ""}
                          </code>
                        )}{" "}
                        {entry.detail}
                      </li>
                    ))}
                  </ul>
                  {item.reply_result.clarificationQuestion && <p>待补充：{item.reply_result.clarificationQuestion}</p>}
                  {item.decision_clue && (
                    <p className="pending-note">
                      可能形成团队约定：{item.decision_clue.summary}。仍需合并后提取并由维护者确认。
                    </p>
                  )}
                  <ul>
                    {item.reply_result.limitations?.map((text: string, i: number) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </>
              )}
              {item.reply_publish_status && (
                <p>
                  回复发布：
                  <Status value={item.reply_publish_status} />
                </p>
              )}
              <small>
                Finding {item.id} · 分析提交 {item.analysis_head_sha ?? item.head_sha}
              </small>
            </details>
          </article>
        );
      })}
    </div>
  );
}

const GROUP_PREVIEW = 5;
type DiscussionGroup = { key: string; repository: string; prNumber: number; title?: string; items: any[] };
// 已加载的讨论按 PR 归组，组的顺序沿用列表顺序（最近有动静的 PR 在前）。
export function groupByPullRequest(items: any[]): DiscussionGroup[] {
  const groups = new Map<string, DiscussionGroup>();
  for (const item of items) {
    const key = `${item.repository}#${item.pr_number}`;
    const group: DiscussionGroup = groups.get(key) ?? {
      key,
      repository: item.repository,
      prNumber: item.pr_number,
      title: item.pr_title || undefined,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function PullRequestDiscussions({ group }: { group: DiscussionGroup }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.items.length - GROUP_PREVIEW;
  return (
    <section className="discussion-group">
      <div className="subhead">
        <div className="discussion-group-title">
          <h3>{group.title || `PR #${group.prNumber}`}</h3>
          <span className="muted">
            {group.repository} · #{group.prNumber} · {group.items.length} 条
          </span>
        </div>
        <a href={`#reviews/${group.items[0].job_id}`}>查看审查 →</a>
      </div>
      <Discussions items={expanded || hidden <= 0 ? group.items : group.items.slice(0, GROUP_PREVIEW)} />
      {hidden > 0 && (
        <button className="secondary discussion-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `显示其余 ${hidden} 条`}
        </button>
      )}
    </section>
  );
}
type DiscussionPageResult = { items: any[]; nextCursor: string | null };
export function useDiscussions(jobId?: string, repositoryId?: string) {
  const [items, setItems] = useState<any[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  async function load(cursor: string | null, replace = false) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    const query = new URLSearchParams();
    if (jobId) query.set("jobId", jobId);
    if (repositoryId) query.set("repositoryId", repositoryId);
    if (cursor) query.set("cursor", cursor);
    try {
      const page = await api<DiscussionPageResult>(`/api/findings?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems((previous) => {
        const combined = replace ? page.items : [...previous, ...page.items];
        return [
          ...new Map(combined.map((item) => [item.id + ":" + (item.source_comment_id ?? "root"), item])).values(),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) setError(messageOf(cause));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    active.current?.abort();
    active.current = null;
    setItems([]);
    setNextCursor(null);
    void load(null, true);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [jobId, repositoryId]);
  return {
    items,
    nextCursor,
    loading,
    error,
    loadMore: () => void load(nextCursor),
    restart: () => {
      setItems([]);
      setNextCursor(null);
      void load(null, true);
    },
  };
}
export function DiscussionPaging({ page }: { page: ReturnType<typeof useDiscussions> }) {
  return (
    <div className="discussion-paging">
      {page.error && (
        <p className="alert" role="alert">
          {page.error}
        </p>
      )}
      <p role="status">
        {page.loading
          ? "正在加载讨论…"
          : `已加载 ${page.items.length} 条讨论${page.nextCursor ? "，还有更多记录" : ""}`}
      </p>
      <div className="actions">
        {(page.nextCursor || page.error) && (
          <button disabled={page.loading} onClick={page.loadMore}>
            {page.error ? "重试加载" : "加载更多讨论"}
          </button>
        )}
        <button className="secondary" disabled={page.loading} onClick={page.restart}>
          刷新讨论
        </button>
      </div>
    </div>
  );
}
export function DiscussionPage({ repositories }: { repositories: Repo[] }) {
  const [repositoryId, setRepositoryId] = useState("");
  const page = useDiscussions(undefined, repositoryId);
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>审查讨论</h2>
          <p className="muted">原问题、维护者回复与最新复核结论。</p>
        </div>
      </div>
      <label>
        筛选仓库
        <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">全部可访问仓库</option>
          {repositories.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.fullName}
            </option>
          ))}
        </select>
      </label>
      {page.items.length > 0 ? (
        <div className="discussion-groups">
          {groupByPullRequest(page.items).map((group) => (
            <PullRequestDiscussions group={group} key={group.key} />
          ))}
        </div>
      ) : !page.loading ? (
        <Discussions items={[]} />
      ) : null}
      <DiscussionPaging page={page} />
    </section>
  );
}
