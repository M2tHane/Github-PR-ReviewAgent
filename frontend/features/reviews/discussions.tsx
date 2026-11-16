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

const conclusionLabels: Record<string, string> = {
  FIXED: "已修复",
  MISJUDGMENT: "判断有误，撤回",
  VALID_EXCEPTION: "认可为例外",
  STILL_VALID: "仍需处理",
  NEEDS_CLARIFICATION: "需要补充说明",
};
const conclusionStatus: Record<string, string> = {
  FIXED: "FIXED",
  MISJUDGMENT: "WITHDRAWN",
  VALID_EXCEPTION: "EXCEPTION_PENDING",
  STILL_VALID: "STILL_VALID",
  NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
};
const publishLabels: Record<string, string> = {
  pending: "回复还没发到 GitHub",
  uncertain: "回复发布结果待核对",
  failed: "回复发布失败",
};
const clueLabels: Record<string, string> = {
  possible_exception: "可能形成例外",
  possible_rule_change: "可能形成规则",
  implementation_rationale: "可能形成实现说明",
};

// 一条讨论 = 一个问题（finding）加上它收到的各轮回复；接口按回复各返回一行，这里合并。
export type DiscussionThread = { key: string; finding: any; replies: any[] };
export function toThreads(items: any[]): DiscussionThread[] {
  const threads = new Map<string, DiscussionThread>();
  for (const item of items) {
    const thread: DiscussionThread = threads.get(item.id) ?? { key: item.id, finding: item, replies: [] };
    if (item.source_comment_id && !thread.replies.some((reply) => reply.source_comment_id === item.source_comment_id))
      thread.replies.push(item);
    threads.set(item.id, thread);
  }
  // GitHub 评论 ID 随时间递增，按它排出先后（接口没有逐条回复的时间）。
  for (const thread of threads.values())
    thread.replies.sort((a, b) => (BigInt(a.source_comment_id) < BigInt(b.source_comment_id) ? -1 : 1));
  return [...threads.values()];
}

// 每条讨论一行：状态｜问题标题｜最新回复（谁：说了什么）｜文件位置｜时间。点开是按先后排的对话。
export function Discussions({ items }: { items: any[] }) {
  return <DiscussionList threads={toThreads(items)} />;
}
function DiscussionList({ threads }: { threads: DiscussionThread[] }) {
  if (!threads.length) return <Empty>暂无讨论记录。</Empty>;
  return (
    <div className="list discussion-list">
      {threads.map((thread) => (
        <DiscussionRow thread={thread} key={thread.key} />
      ))}
    </div>
  );
}

const findingTitle = (item: any) => item.presentation?.display?.title ?? shortText(item.description, 80);
const actorOf = (reply: any) => reply.human_actor_login ?? "维护者";

function DiscussionRow({ thread }: { thread: DiscussionThread }) {
  const { finding, replies } = thread;
  const title = findingTitle(finding);
  const latest = replies.at(-1);
  return (
    <details className="discussion-row">
      <summary className="list-row">
        <span className="col-status discussion-status">
          <Status value={finding.status} />
        </span>
        <span className="row-title discussion-title" title={title}>
          {title}
        </span>
        <span
          className="row-meta discussion-reply"
          title={latest?.human_reply_body ? `${actorOf(latest)}：${latest.human_reply_body}` : undefined}
        >
          {latest?.human_reply_body ? (
            <>
              <span className="discussion-actor">{actorOf(latest)}：</span>
              {latest.human_reply_body}
            </>
          ) : (
            <span className="discussion-none">还没有回复</span>
          )}
        </span>
        <span className="row-meta discussion-rounds">{replies.length > 1 ? `${replies.length} 轮` : ""}</span>
        <code className="row-meta discussion-where" title={whereText(finding)}>
          {whereText(finding)}
        </code>
        <time
          className="row-meta col-time"
          dateTime={discussionTime(finding)}
          title={dateText(discussionTime(finding))}
        >
          {relativeTime(discussionTime(finding))}
        </time>
      </summary>
      <ThreadBody thread={thread} />
    </details>
  );
}

// 展开后是一条对话时间线：原问题 → 维护者回复 → 服务复核 →（下一轮）……依据默认收起。
function ThreadBody({ thread }: { thread: DiscussionThread }) {
  const { finding, replies } = thread;
  const reason = finding.presentation?.display?.reason || shortText(finding.evidence ?? finding.description ?? "", 140);
  const threadUrl = finding.github_comment_id
    ? `https://github.com/${finding.repository}/pull/${finding.pr_number}#discussion_r${finding.github_comment_id}`
    : null;
  const shas = [...new Set(replies.map((reply) => reply.analysis_head_sha).filter(Boolean))];
  return (
    <div className="thread">
      <div className="thread-top">
        <span className="thread-top-label">{replies.length ? `讨论经过 · ${replies.length} 轮回复` : "讨论经过"}</span>
        {threadUrl && (
          <a className="button compact thread-github" href={threadUrl} target="_blank" rel="noreferrer">
            在 GitHub 查看讨论
            <External />
          </a>
        )}
      </div>
      <ol className="thread-steps">
        <li className="thread-step thread-finding">
          <p className="thread-who">审查意见</p>
          <p className="thread-title">{findingTitle(finding)}</p>
          <p className="thread-text">{reason}</p>
          <p className="thread-meta">
            <code>{whereText(finding)}</code> · {dateText(finding.created_at)}
          </p>
        </li>
        {replies.map((reply, index) => (
          <ReplyRound key={reply.source_comment_id} reply={reply} round={replies.length > 1 ? index + 1 : 0} />
        ))}
        {!replies.length && (
          <li className="thread-step thread-waiting">
            <p className="thread-text muted">还没有人回复这条意见。</p>
          </li>
        )}
      </ol>
      <details className="thread-tech">
        <summary>技术信息</summary>
        <p>
          Finding <code>{finding.id}</code>
          {shas.length > 0 ? (
            <>
              {" "}
              · 分析提交 <code>{shas.map((sha) => String(sha).slice(0, 10)).join("、")}</code>
            </>
          ) : (
            <>
              {" "}
              · 审查提交 <code>{String(finding.head_sha ?? "").slice(0, 10)}</code>
            </>
          )}
        </p>
      </details>
    </div>
  );
}

function ReplyRound({ reply, round }: { reply: any; round: number }) {
  const result = reply.reply_result;
  const conclusion = result?.conclusion ?? result?.suggestedFindingStatus;
  const hasEvidence = Boolean(
    result && (result.evidence?.length || result.limitations?.length || result.clarificationQuestion),
  );
  return (
    <>
      <li className="thread-step thread-human">
        <p className="thread-who">
          {actorOf(reply)}
          {round > 0 && <span className="thread-round">第 {round} 轮</span>}
          {reply.human_reply_url && (
            <a className="thread-link" href={reply.human_reply_url} target="_blank" rel="noreferrer">
              原评论
              <External />
            </a>
          )}
        </p>
        <p className="thread-text thread-quote">{reply.human_reply_body || "（回复内容未保存）"}</p>
      </li>
      <li className="thread-step thread-service">
        <p className="thread-who">
          服务复核
          {reply.reply_publish_status && reply.reply_publish_status !== "published" && (
            <span className="thread-round">
              <Status
                value={reply.reply_publish_status}
                label={publishLabels[reply.reply_publish_status] ?? reply.reply_publish_status}
                plain
              />
            </span>
          )}
          {reply.github_reply_url && (
            <a className="thread-link" href={reply.github_reply_url} target="_blank" rel="noreferrer">
              服务的回复
              <External />
            </a>
          )}
        </p>
        {result ? (
          <>
            <p className="thread-text">
              <span className="thread-verdict">
                <Status
                  value={conclusionStatus[conclusion] ?? conclusion}
                  label={conclusionLabels[conclusion] ?? statusLabels[conclusion] ?? conclusion}
                />
              </span>
              {result.summary}
            </p>
            {reply.decision_clue && (
              <p className="thread-clue">
                {clueLabels[reply.decision_clue.type] ?? "可能形成规则"}：{reply.decision_clue.summary}
                （合并后提取，仍需维护者确认）
              </p>
            )}
            {hasEvidence && (
              <details className="thread-evidence">
                <summary>查看复核依据</summary>
                {result.clarificationQuestion && <p>待补充：{result.clarificationQuestion}</p>}
                {result.evidence?.length > 0 && (
                  <ul>
                    {result.evidence.map((entry: any, i: number) => (
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
                {result.limitations?.length > 0 && (
                  <>
                    <p className="thread-sub">限制</p>
                    <ul>
                      {result.limitations.map((text: string, i: number) => (
                        <li key={i}>{text}</li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            )}
          </>
        ) : (
          <p className="thread-text muted">复核还没完成。</p>
        )}
      </li>
    </>
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
    group.count += toThreads(pull.items).length;
    groups.set(pull.repository, group);
  }
  return [...groups.values()];
}
function PullRequestDiscussions({ group }: { group: DiscussionGroup }) {
  const [expanded, setExpanded] = useState(false);
  const threads = toThreads(group.items);
  const hidden = threads.length - GROUP_PREVIEW;
  return (
    <section className="discussion-group">
      <div className="discussion-group-head">
        <strong className="pr-ref-number discussion-pr">#{group.prNumber}</strong>
        <h4 title={group.title || undefined}>{group.title || "（没有标题）"}</h4>
        <span className="group-count">{threads.length} 条</span>
        <a href={`#reviews/${group.items[0].job_id}`}>查看审查</a>
      </div>
      <DiscussionList threads={expanded || hidden <= 0 ? threads : threads.slice(0, GROUP_PREVIEW)} />
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
