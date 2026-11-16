import { Select } from "../../components/common/select.js";
import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { Empty, ListSkeleton } from "../../components/common/empty-state.js";
import { External } from "../../components/common/icons.js";
import { Status, statusLabels } from "../../components/common/status-badge.js";
import { dateText, relativeTime } from "../../format.js";
import { shortText } from "../../../src/review/presentation.js";
import type { Repository as Repo } from "../../types.js";

const findingStatuses = ["OPEN", "STILL_VALID", "NEEDS_CLARIFICATION", "EXCEPTION_PENDING", "FIXED", "WITHDRAWN"];
const whereText = (item: any) => (item.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : "整体变更");
const discussionTime = (item: any) => item.updated_at ?? item.created_at;

// 每条讨论一行：状态｜问题标题｜最新回复（谁：说了什么）｜文件位置｜时间。点这一行展开复核依据。
export function Discussions({ items }: { items: any[] }) {
  if (!items.length) return <Empty>暂无讨论记录。</Empty>;
  return (
    <div className="list discussion-list">
      {items.map((item) => (
        <DiscussionRow item={item} key={item.id + "-" + (item.source_comment_id ?? "root")} />
      ))}
    </div>
  );
}

function DiscussionRow({ item }: { item: any }) {
  const title = item.presentation?.display?.title ?? shortText(item.description, 80);
  const actor = item.human_actor_login ?? "维护者";
  const link = item.github_reply_url
    ? { href: item.github_reply_url, label: "在 GitHub 查看回复" }
    : item.github_comment_id
      ? {
          href: `https://github.com/${item.repository}/pull/${item.pr_number}#discussion_r${item.github_comment_id}`,
          label: "在 GitHub 查看原讨论",
        }
      : null;
  return (
    <details className="discussion-row">
      <summary className="list-row">
        <span className="col-status discussion-status">
          <Status value={item.status} />
        </span>
        <span className="row-title discussion-title" title={title}>
          {title}
        </span>
        <span
          className="row-meta discussion-reply"
          title={item.human_reply_body ? `${actor}：${item.human_reply_body}` : undefined}
        >
          {item.human_reply_body ? (
            <>
              <span className="discussion-actor">{actor}：</span>
              {item.human_reply_body}
            </>
          ) : (
            <span className="discussion-none">还没有回复</span>
          )}
        </span>
        <code className="row-meta discussion-where" title={whereText(item)}>
          {whereText(item)}
        </code>
        <time className="row-meta col-time" dateTime={discussionTime(item)} title={dateText(discussionTime(item))}>
          {relativeTime(discussionTime(item))}
        </time>
      </summary>
      <div className="discussion-body">
        {item.human_reply_body && (
          <blockquote>
            <strong>{actor}：</strong>
            {item.human_reply_body}
          </blockquote>
        )}
        {item.reply_result && (
          <p>
            <strong>{statusLabels[item.reply_result.suggestedFindingStatus] ?? "复核结果"}</strong> ·{" "}
            {item.reply_result.summary}
          </p>
        )}
        <h4 className="run-subtitle">复核依据</h4>
        <p>{item.evidence}</p>
        {item.reply_result && (
          <>
            {item.reply_result.evidence?.length > 0 && (
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
            )}
            {item.reply_result.clarificationQuestion && <p>待补充：{item.reply_result.clarificationQuestion}</p>}
            {item.decision_clue && (
              <p className="pending-note">
                可能形成团队约定：{item.decision_clue.summary}。仍需合并后提取并由维护者确认。
              </p>
            )}
            {item.reply_result.limitations?.length > 0 && (
              <ul>
                {item.reply_result.limitations.map((text: string, i: number) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {item.reply_publish_status && (
          <p>
            回复发布：
            <Status value={item.reply_publish_status} />
          </p>
        )}
        <p className="discussion-foot">
          <small className="muted">
            Finding {item.id} · 分析提交 {item.analysis_head_sha ?? item.head_sha}
          </small>
          {link && (
            <a className="discussion-link" href={link.href} target="_blank" rel="noreferrer">
              {link.label}
              <External />
            </a>
          )}
        </p>
      </div>
    </details>
  );
}

const GROUP_PREVIEW = 5;
type DiscussionGroup = { key: string; repository: string; prNumber: number; title?: string; items: any[] };
type RepositoryGroup = { repository: string; count: number; pulls: DiscussionGroup[] };
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
// 再按仓库归组，仓库顺序同样沿用最近动静。
function groupByRepository(items: any[]): RepositoryGroup[] {
  const groups = new Map<string, RepositoryGroup>();
  for (const pull of groupByPullRequest(items)) {
    const group = groups.get(pull.repository) ?? { repository: pull.repository, count: 0, pulls: [] };
    group.pulls.push(pull);
    group.count += pull.items.length;
    groups.set(pull.repository, group);
  }
  return [...groups.values()];
}
function PullRequestDiscussions({ group }: { group: DiscussionGroup }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.items.length - GROUP_PREVIEW;
  return (
    <section className="discussion-group">
      <div className="discussion-group-head">
        <strong className="pr-ref-number discussion-pr">#{group.prNumber}</strong>
        <h4 title={group.title || undefined}>{group.title || "（没有标题）"}</h4>
        <span className="group-count">{group.items.length} 条</span>
        <a href={`#reviews/${group.items[0].job_id}`}>查看审查</a>
      </div>
      <Discussions items={expanded || hidden <= 0 ? group.items : group.items.slice(0, GROUP_PREVIEW)} />
      {hidden > 0 && (
        <button className="compact discussion-more" onClick={() => setExpanded(!expanded)}>
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
      <span className="muted" role="status">
        {page.loading
          ? "正在加载讨论…"
          : `已加载 ${page.items.length} 条讨论${page.nextCursor ? "，还有更多记录" : ""}`}
      </span>
      <span className="actions">
        <button className="ghost compact" disabled={page.loading} onClick={page.restart}>
          刷新讨论
        </button>
        {(page.nextCursor || page.error) && (
          <button className="compact" disabled={page.loading} onClick={page.loadMore}>
            {page.error ? "重试加载" : "加载更多讨论"}
          </button>
        )}
      </span>
    </div>
  );
}
export function DiscussionPage({ repositories }: { repositories: Repo[] }) {
  const [repositoryId, setRepositoryId] = useState(""),
    [status, setStatus] = useState("");
  const page = useDiscussions(undefined, repositoryId);
  // 状态筛选作用于已加载的讨论（接口按时间分页，没有状态参数）。
  const shown = status ? page.items.filter((item) => item.status === status) : page.items;
  return (
    <section>
      <div className="page-head">
        <h2>审查讨论</h2>
        <p className="muted">原问题、维护者回复与最新复核结论，按仓库和 PR 归组。</p>
      </div>
      <div className="toolbar">
        <Select
          compact
          prefix="仓库："
          aria-label="筛选仓库"
          value={repositoryId}
          onChange={(value) => setRepositoryId(value)}
        >
          <option value="">全部可访问仓库</option>
          {repositories.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.fullName}
            </option>
          ))}
        </Select>
        <Select compact prefix="状态：" aria-label="筛选状态" value={status} onChange={(value) => setStatus(value)}>
          <option value="">全部状态</option>
          {findingStatuses.map((value) => (
            <option key={value} value={value}>
              {statusLabels[value]}
            </option>
          ))}
        </Select>
        {status && page.nextCursor && <span className="toolbar-note">只筛选已加载的讨论，加载更多可能找到更多。</span>}
      </div>
      {shown.length > 0 ? (
        <div className="discussion-groups">
          {groupByRepository(shown).map((group) => (
            <section className="discussion-repo" key={group.repository} aria-label={group.repository}>
              <h3 className="discussion-repo-head">
                <span className="discussion-repo-name" title={group.repository}>
                  {group.repository}
                </span>
                <span className="group-count">{group.count} 条</span>
              </h3>
              {group.pulls.map((pull) => (
                <PullRequestDiscussions group={pull} key={pull.key} />
              ))}
            </section>
          ))}
        </div>
      ) : page.loading ? (
        <ListSkeleton />
      ) : status && page.items.length ? (
        <Empty
          action={
            <button type="button" className="compact" onClick={() => setStatus("")}>
              清除状态筛选
            </button>
          }
        >
          已加载的讨论里没有“{statusLabels[status]}”的。
        </Empty>
      ) : (
        <Discussions items={[]} />
      )}
      <DiscussionPaging page={page} />
    </section>
  );
}
