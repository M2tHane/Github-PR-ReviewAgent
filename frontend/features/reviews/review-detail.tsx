import { memorySourceLabel } from "../../../src/memory/types.js";
import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { Status } from "../../components/common/status-badge.js";
import { dateText } from "../../format.js";
import type { Job, Memory } from "../../types.js";
import type { Finding, ReviewResult } from "../../../src/review/types.js";
import { displayFinding } from "../../../src/review/presentation.js";
import { RunDetails } from "../../components/common/run-details.js";
import { ArrowLeft, External } from "../../components/common/icons.js";
import { previousHash } from "../../navigation.js";
import { SessionTimeline } from "../../components/common/session-timeline.js";
import { Discussions, DiscussionPaging, useDiscussions } from "./discussions.js";
import { groupVulnerabilities } from "../../../src/health/vulnerability-records.js";
import { isPriorityDependency, VulnerableDependencies } from "../../components/common/vulnerable-dependencies.js";

function DependencyChanges({ job, audit }: { job: Job; audit: NonNullable<ReviewResult["dependencyAudit"]> }) {
  const groups = groupVulnerabilities(audit.vulnerabilities);
  const ordered = [...groups.filter(isPriorityDependency), ...groups.filter((group) => !isPriorityDependency(group))];
  return (
    <section className="page-section">
      <div className="section-title">
        <h3>新引入依赖的已知漏洞{groups.length ? `（${groups.length} 个依赖）` : ""}</h3>
      </div>
      <p className="muted">
        {audit.manifests.join("、")} 里这次新增或换了版本的 {audit.queried} 个依赖已查询 OSV 漏洞库
        {groups.length
          ? "。高危以上且已能修复的会在 GitHub 上提醒，其余只在这里列出。"
          : audit.queried
            ? "，没有发现已知漏洞。"
            : "，但没有查成，原因见下方审查范围与限制。"}
      </p>
      {ordered.length > 0 && (
        <VulnerableDependencies
          groups={ordered}
          fileUrl={(path, line) =>
            `https://github.com/${job.repository}/blob/${job.target_sha}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`
          }
        />
      )}
    </section>
  );
}

function SourceLocation({
  job,
  location,
  className,
}: {
  job: Job;
  location: Pick<Finding, "path" | "line" | "side">;
  className?: string;
}) {
  if (!location.path) return <span className={className}>整体变更</span>;
  const sha = location.side === "LEFT" ? job.base_sha : job.target_sha;
  return (
    <a
      className={className}
      href={`https://github.com/${job.repository}/blob/${sha}/${location.path.split("/").map(encodeURIComponent).join("/")}${location.line ? "#L" + location.line : ""}`}
      target="_blank"
      rel="noreferrer"
    >
      {location.path}
      {location.line ? ":" + location.line : ""}
      <External />
    </a>
  );
}
const TIERS: Array<[tone: "must" | "should" | "may", label: string, severities: string[]]> = [
  ["must", "必须改", ["critical", "high"]],
  ["should", "建议改", ["medium"]],
  ["may", "可以不改", ["low"]],
];

function BackToReviews() {
  return (
    <a
      href="#reviews"
      className="back-link"
      onClick={(event) => {
        // 从列表点进来时后退，列表的筛选、页码和滚动位置都还在。
        const previous = previousHash();
        if (/^#reviews(\?|$)/.test(previous)) {
          event.preventDefault();
          history.back();
        }
      }}
    >
      <ArrowLeft />
      PR 审查
    </a>
  );
}

// 必须规则：一行汇总，下面只列违反和未确认的规则；标题优先用审查结果里的，其次查已加载的规则，最后用 ID 前 8 位。
function MustRules({ report, memories }: { report: ReviewResult; memories: Memory[] }) {
  const checks = report.ruleChecks ?? [],
    unchecked = report.uncheckedMustRules ?? [];
  const count = (result: string) => checks.filter((check) => check.result === result).length;
  const violated = checks.filter((check) => check.result === "violated");
  if (!checks.length && !unchecked.length) return null;
  const titleOf = (id: string) =>
    unchecked.find((rule) => rule.id === id)?.title || memories.find((rule) => rule.id === id)?.title || id.slice(0, 8);
  const items = [
    ...violated.map((check) => ({ id: check.id, kind: "violated" as const, note: check.note })),
    ...unchecked.map((rule) => ({ id: rule.id, kind: "unchecked" as const, note: undefined })),
  ];
  return (
    <section className="page-section must-rules" aria-labelledby="must-rules-title">
      <div className="section-title">
        <h3 id="must-rules-title">必须规则</h3>
      </div>
      <p className="must-summary">
        <span>遵守 {count("followed")}</span>
        <span className={violated.length ? "must-violation" : undefined}>违反 {violated.length}</span>
        <span>不适用 {count("not_applicable")}</span>
        <span className={unchecked.length ? "must-unchecked" : undefined}>未确认 {unchecked.length}</span>
      </p>
      {items.length > 0 && (
        <ul className="list must-list">
          {items.map((item) => (
            <li className="must-item" key={`${item.kind}-${item.id}`}>
              <span className={`must-tag ${item.kind === "violated" ? "must-violation" : "must-unchecked"}`}>
                {item.kind === "violated" ? "违反" : "未确认"}
              </span>
              <div className="must-body">
                <a className="must-title" href={`#rules/${item.id}`}>
                  {titleOf(item.id)}
                </a>
                {item.note && <p className="must-note">{item.note}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReviewDetails({ id, memories }: { id: string; memories: Memory[] }) {
  const [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState("");
  const discussions = useDiscussions(id),
    threads = discussions.items;
  useEffect(() => {
    const controller = new AbortController();
    setJob(null);
    setError("");
    void api<Job>(`/api/jobs/${id}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setJob(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      });
    return () => controller.abort();
  }, [id]);
  if (error)
    return (
      <section>
        <BackToReviews />
        <p className="alert" role="alert">
          {error}
        </p>
      </section>
    );
  if (!job)
    return (
      <p className="muted" role="status">
        正在加载审查详情…
      </p>
    );
  const report = job.review_result as ReviewResult | undefined;
  const findings: (Finding & { id?: string })[] =
    report?.findings ??
    [...new Map(threads.map((row) => [row.id, row])).values()].map((row) => ({
      ...row,
      ...row.presentation,
      evidenceLevel: row.evidence_level,
      memory: row.memory_id
        ? {
            ...row.presentation?.memory,
            id: row.memory_id,
            version: row.memory_version,
            source: row.presentation?.memory?.source ?? {},
          }
        : undefined,
    }));
  // 之前提过、仍未解决的问题在 GitHub 上不再发行内评论，这里也只列一行并指回原评论。
  const fresh = findings.filter((finding) => !finding.repeatOf),
    repeats = findings.filter((finding) => finding.repeatOf);
  const resolved = report?.resolvedPrevious ?? 0;
  const lead = [
    fresh.length
      ? `${report ? "发现" : "已加载"} ${fresh.length} 个${repeats.length || resolved ? "新" : ""}问题`
      : repeats.length
        ? "这次没有新问题"
        : job.status === "succeeded" && report
          ? "已检查范围内未发现需要处理的问题"
          : "当前没有完整的审查结论",
    repeats.length && `另有 ${repeats.length} 个之前提过、仍未解决`,
    resolved && `之前的 ${resolved} 个问题这次没有再发现`,
  ]
    .filter(Boolean)
    .join("，");
  const tierOf = (severity: string) => TIERS.find(([, , levels]) => levels.includes(severity))?.[0];
  const prUrl = `https://github.com/${job.repository}/pull/${job.pr_number}`;
  return (
    <section className="detail review-detail">
      <BackToReviews />
      <div className="detail-header">
        <a className="pr-ref detail-pr-ref" href={prUrl} target="_blank" rel="noreferrer" title="在 GitHub 打开 PR">
          <span className="pr-ref-repo">{job.repository}</span>
          <strong className="pr-ref-number">#{job.pr_number}</strong>
          <External />
        </a>
        <h2 className="detail-title">{job.payload?.title || `PR #${job.pr_number}`}</h2>
        <p className="detail-meta">
          <Status value={job.status} />
          <span aria-hidden="true">·</span>
          <code title={job.target_sha}>{job.target_sha.slice(0, 8)}</code>
          <span aria-hidden="true">·</span>
          <time dateTime={job.created_at}>{dateText(job.created_at)}</time>
          {job.github_review_url && (
            <>
              <span aria-hidden="true">·</span>
              <a href={job.github_review_url} target="_blank" rel="noreferrer">
                GitHub 上的审查
                <External />
              </a>
            </>
          )}
        </p>
        {job.job_type === "PR_REVIEW" && <p className="detail-lead">{lead}。自动审查，不代替 CI 测试。</p>}
        {job.last_error && (
          <p className="alert" role="alert">
            {job.last_error}
          </p>
        )}
      </div>
      <div className="detail-body">
        {report && <MustRules report={report} memories={memories} />}
        {TIERS.map(([tone, label]) => {
          const group = fresh.filter((finding) => tierOf(finding.severity) === tone);
          if (!group.length) return null;
          return (
            <section className="finding-group" key={tone} aria-label={`${label} ${group.length} 个`}>
              <h3 className="list-group-head">
                <span className={`sev sev-${tone}`}>{label}</span>
                <span className="group-count">{group.length}</span>
              </h3>
              <div className="list finding-list">
                {group.map((finding, i) => {
                  const display = displayFinding(finding),
                    thread = (job.finding_statuses ?? threads).find(
                      (item: { id: string; status: string }) => item.id === finding.id,
                    );
                  return (
                    <article className="finding" key={finding.id ?? i}>
                      <div className="finding-head">
                        <h4 className="finding-title">{display.title}</h4>
                        {thread && thread.status !== "OPEN" && <Status value={thread.status} />}
                      </div>
                      <SourceLocation job={job} location={finding} className="finding-where" />
                      {finding.restricted && (
                        <p className="muted">公开仓库：GitHub 上只提示了"发现安全问题"，细节只在这里显示。</p>
                      )}
                      <p>{display.reason}</p>
                      {display.fix?.trim() && (
                        <p>
                          <strong>建议：</strong>
                          {display.fix}
                        </p>
                      )}
                      {display.code && (
                        <pre>
                          <code>{display.code}</code>
                        </pre>
                      )}
                      {finding.memory && (
                        <p>
                          团队规则：
                          <a href={`#rules/${finding.memory.id}`}>{finding.memory.title ?? "查看引用规则"}</a>
                        </p>
                      )}
                      <details>
                        <summary>
                          查看完整依据
                          {finding.relatedLocations?.length ? `与 ${finding.relatedLocations.length} 个关联位置` : ""}
                        </summary>
                        <p className="rule-content">{finding.description}</p>
                        <p className="rule-content">
                          <strong>证据：</strong>
                          {finding.evidence}
                        </p>
                        <p className="rule-content">
                          <strong>影响：</strong>
                          {finding.impact}
                        </p>
                        <p className="rule-content">
                          <strong>完整建议：</strong>
                          {finding.suggestion}
                        </p>
                        {finding.relatedLocations?.map((location, index) => (
                          <p key={index}>
                            <SourceLocation job={job} location={location} />
                          </p>
                        ))}
                        {finding.candidates?.map((candidate, index) => (
                          <details key={index}>
                            <summary>
                              合并意见 {index + 1} · {candidate.description}
                            </summary>
                            <p className="muted">
                              {candidate.reviewerRole ?? "原始意见"} · {candidate.category} ·{" "}
                              <Status value={candidate.severity} /> · 证据 {candidate.evidenceLevel}
                            </p>
                            <SourceLocation job={job} location={candidate} />
                            <p>{candidate.evidence}</p>
                            <p>{candidate.impact}</p>
                            <p>{candidate.suggestion}</p>
                          </details>
                        ))}
                        {finding.memory && (
                          <small>
                            引用规则版本 v{finding.memory.version} · {memorySourceLabel(finding.memory.source)}
                          </small>
                        )}
                      </details>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
        {repeats.length > 0 && (
          <section className="finding-group">
            <h3 className="list-group-head">
              之前提过、仍未解决<span className="group-count">{repeats.length}</span>
            </h3>
            <div className="list">
              {repeats.map((finding, i) => {
                const commentId = finding.repeatOf?.commentId;
                return (
                  <div className="list-row" key={finding.id ?? i}>
                    <Status value={finding.severity} icon />
                    <span className="row-title">{finding.repeatOf?.title || displayFinding(finding).title}</span>
                    <SourceLocation job={job} location={finding} className="row-meta repeat-where" />
                    {commentId && (
                      <a
                        className="row-meta"
                        href={`https://github.com/${job.repository}/pull/${job.pr_number}#discussion_r${commentId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        之前的评论
                        <External />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {report?.dependencyAudit && <DependencyChanges job={job} audit={report.dependencyAudit} />}
        <section className="page-section">
          <div className="section-title">
            <h3>后续讨论与复核</h3>
          </div>
          {threads.some((item) => item.source_comment_id) && (
            <Discussions items={threads.filter((item) => item.source_comment_id)} />
          )}
          <DiscussionPaging page={discussions} />
          {!report && discussions.nextCursor && <p className="muted">历史记录的其余问题可随讨论继续加载。</p>}
        </section>
        <details className="audit-details">
          <summary>审查范围与限制</summary>
          {report ? (
            <>
              <p className="rule-content">{report.summary}</p>
              <h4>检查范围</h4>
              <ul>
                {(report.coverage ?? []).map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
              <h4>限制</h4>
              <ul>
                {(report.limitations ?? []).map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>这是一条历史记录，未保存新版完整报告；可查看原 GitHub Review 与下方运行信息。</p>
          )}
        </details>
        <details className="audit-details" id="run-info">
          <summary>运行信息</summary>
          <p>
            目标提交 <code>{job.target_sha}</code>
          </p>
          <small>
            Job {job.id} · Delivery {job.delivery_id ?? "无"}
          </small>
          <RunDetails runs={job.agent_runs ?? []} />
          <SessionTimeline sessions={job.agent_sessions ?? []} />
        </details>
      </div>
    </section>
  );
}
