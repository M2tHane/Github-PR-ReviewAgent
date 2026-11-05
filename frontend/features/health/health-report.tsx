import type { DependencyAudit, HealthDimension, SastRecord, SastScan, SecretScan } from "../../../src/health/types.js";
import { groupVulnerabilities } from "../../../src/health/vulnerability-records.js";
import { isPriorityDependency, VulnerableDependencies } from "../../components/common/vulnerable-dependencies.js";
import { Status } from "../../components/common/status-badge.js";
import { dateText, numberText } from "../../format.js";
import type { HealthDetail } from "./types.js";

const healthLabels: Record<HealthDimension, string> = {
  code: "代码与团队规则",
  ci: "CI / 测试结果",
  dependencies: "依赖声明",
  documentation: "文档一致性",
  security: "安全",
};
const healthSourceLabels: Record<string, string> = {
  checks: "GitHub Checks",
  workflows: "GitHub Actions",
  files: "源码",
  memory: "团队规则",
  dependencies: "依赖",
  vulnerabilities: "依赖漏洞",
  secrets: "密钥扫描",
  sast: "代码规则扫描",
  security_audit: "安全链路分析",
  analysis: "分析",
};
function SecretScanView({ scan, fileUrl }: { scan: SecretScan; fileUrl: (path: string, line?: number) => string }) {
  return (
    <section className="health-dimension" aria-label="密钥泄露">
      <h4>
        密钥泄露 <span className="muted">{scan.records.length} 处</span>
      </h4>
      <p>
        {scan.records.length
          ? `扫描了 ${scan.scannedFiles} 个文件，发现 ${scan.records.length} 处疑似密钥。请先在对应平台作废并更换这些密钥，再从代码里删除；只删除代码撤销不了已经提交到 Git 历史里的内容。`
          : `扫描了 ${scan.scannedFiles} 个文件，没有发现疑似密钥${scan.status === "incomplete" ? "；部分文件没有扫描，原因见上方" : ""}。`}
      </p>
      {scan.records.length > 0 && (
        <ul className="vuln-list">
          {scan.records.map((record) => (
            <li className="health-finding severity-critical secret-record" key={record.id}>
              <Status value="critical" label={record.label} />
              <a href={fileUrl(record.path, record.line)} target="_blank" rel="noreferrer">
                {record.path}:{record.line}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="muted vuln-manifests">报告只记录位置和类型，不保存密钥原文；只扫描当前快照，不含 Git 历史。</p>
    </section>
  );
}

const sastSeverity: Record<string, string> = { high: "高", medium: "中", low: "低" };
const surfaceLabels: Record<string, string> = {
  http_route: "HTTP 路由",
  webhook: "Webhook",
  sql: "SQL",
  command: "执行命令",
  file: "读写文件",
  network: "对外请求",
  data_access: "按 ID 取数据",
  deserialize: "反序列化",
  code_eval: "执行代码",
};
function SastList({ records, fileUrl }: { records: SastRecord[]; fileUrl: (path: string, line?: number) => string }) {
  return (
    <ul className="vuln-list">
      {records.map((record) => (
        <li className={`health-finding severity-${record.severity}`} key={record.id}>
          <div className="health-finding-labels">
            <Status value={record.severity} label={sastSeverity[record.severity]} />
            <span>{record.label}</span>
          </div>
          <p className="vuln-meta">
            <a href={fileUrl(record.path, record.line)} target="_blank" rel="noreferrer">
              {record.path}:{record.line}
            </a>
          </p>
          <p className="muted">{record.message}</p>
        </li>
      ))}
    </ul>
  );
}

function SastScanView({ scan, fileUrl }: { scan: SastScan; fileUrl: (path: string, line?: number) => string }) {
  const main = scan.records.filter((record) => record.severity !== "low"),
    low = scan.records.filter((record) => record.severity === "low");
  return (
    <section className="health-dimension" aria-label="代码规则扫描">
      <h4>代码规则扫描 {scan.scannedFiles > 0 && <span className="muted">{scan.records.length} 处</span>}</h4>
      <p>
        {scan.status === "disabled"
          ? "代码规则扫描已关闭（SAST_SCAN_ENABLED=false）。"
          : !scan.scannedFiles
            ? scan.status === "incomplete"
              ? "代码规则扫描没有完成，原因见上方。"
              : "检查范围内没有支持的源码文件（JS/TS、Python、Java、Go）。"
            : scan.records.length
              ? `用 Semgrep 扫描了 ${scan.scannedFiles} 个源码文件，${scan.records.length} 处写法有风险。这些是按固定规则找到的候选，是否真能被利用要看输入来源；模型确认过的会出现在下方"安全"维度。`
              : `用 Semgrep 扫描了 ${scan.scannedFiles} 个源码文件，没有命中危险写法${scan.status === "incomplete" ? "；部分内容没有扫描，原因见上方" : ""}。`}
      </p>
      {main.length > 0 && <SastList records={main} fileUrl={fileUrl} />}
      {low.length > 0 && (
        <details className="vuln-others">
          <summary>其余 {low.length} 处低风险写法（如 MD5 / SHA-1，用于校验和时无需处理）</summary>
          <SastList records={low} fileUrl={fileUrl} />
        </details>
      )}
    </section>
  );
}

function DependencyAuditView({
  audit,
  fileUrl,
}: {
  audit: DependencyAudit;
  fileUrl: (path: string, line?: number) => string;
}) {
  // 一个依赖只出现一次：只要有一条高危以上且能修复的漏洞，整个依赖就排进优先列表。
  const groups = groupVulnerabilities(audit.vulnerabilities);
  const priority = groups.filter(isPriorityDependency),
    others = groups.filter((group) => !isPriorityDependency(group));
  const otherCount = others.reduce((sum, group) => sum + group.records.length, 0);
  return (
    <section className="health-dimension" aria-label="依赖漏洞">
      <h4>依赖漏洞 {audit.queried > 0 && <span className="muted">{audit.vulnerabilities.length} 个</span>}</h4>
      <p>
        {audit.status === "disabled"
          ? "依赖漏洞检查已关闭（VULNERABILITY_SCAN_ENABLED=false）。"
          : audit.status === "no_manifest"
            ? "检查范围内没有支持的锁文件，未检查依赖漏洞。目前支持 package-lock.json、go.mod、Cargo.lock、poetry.lock、uv.lock、requirements*.txt 和 pom.xml。"
            : !audit.queried
              ? "依赖漏洞没有查成，原因见上方。"
              : !audit.vulnerabilities.length
                ? `已查询 ${audit.queried} 个依赖版本，没有发现已知漏洞${audit.status === "incomplete" ? "；部分依赖未检查，原因见上方" : ""}。`
                : `已查询 ${audit.queried} 个依赖版本，发现 ${audit.vulnerabilities.length} 个已知漏洞${priority.length ? `。${priority.length} 个依赖有高危以上且已能修复的漏洞，建议优先升级` : "，没有高危以上且已能修复的"}${audit.status === "incomplete" ? "。部分依赖未检查，原因见上方" : ""}。`}
      </p>
      {priority.length > 0 && <VulnerableDependencies groups={priority} fileUrl={fileUrl} />}
      {others.length > 0 && (
        <details className="vuln-others">
          <summary>
            其余 {others.length} 个依赖，共 {otherCount} 个漏洞（中低危、未知等级或暂无修复版本）
          </summary>
          <VulnerableDependencies groups={others} fileUrl={fileUrl} />
        </details>
      )}
      {audit.manifests.length > 0 && (
        <p className="muted vuln-manifests">
          锁文件：
          {audit.manifests.map((manifest) => `${manifest.path}（${manifest.dependencies} 个依赖）`).join("、")}
        </p>
      )}
    </section>
  );
}
export const healthStatuses: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "执行完成",
  partial: "部分覆盖",
  failed: "失败",
  timeout: "超时",
  cancelled: "已取消",
};
export function HealthReportView({
  detail,
  choose,
  retry,
  busy,
  enabled,
}: {
  detail: HealthDetail;
  choose: (id: string) => void;
  retry: () => void;
  busy: boolean;
  enabled: boolean;
}) {
  const { job, report, usage } = detail;
  const remaining = Math.max(
    0,
    Number(job.payload?.scope?.budgetTokens ?? 0) - usage.totalTokens - usage.unreportedTokens,
  );
  const sourceUrl = (path: string, line?: number) =>
    `https://github.com/${job.repository}/blob/${job.target_sha}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
  const priorityVulnerabilities = groupVulnerabilities(report?.dependencyAudit?.vulnerabilities ?? []).filter(
    isPriorityDependency,
  ).length;
  return (
    <article className="health-report" id="health-detail">
      <header className="health-report-head">
        <div>
          <p className="eyebrow">固定快照</p>
          <h3>{job.repository}</h3>
          <p>
            默认分支 {job.payload?.defaultBranch} · {dateText(report?.completedAt ?? job.created_at)}
          </p>
        </div>
        {!report && <Status value={job.status} label={healthStatuses[job.status]} />}
      </header>
      {job.last_error && (
        <p className="alert" role="alert">
          {job.last_error}
        </p>
      )}
      {!report && (
        <div className="health-awaiting">
          <p>
            {["queued", "running"].includes(job.status) ? "任务进行中，结果会自动更新。" : "本任务尚未生成有效报告。"}
          </p>
          {["failed", "timeout", "cancelled"].includes(job.status) && (
            <>
              <button className="secondary" disabled={busy || !enabled || remaining <= 0} onClick={retry}>
                按原快照重试
              </button>
              <small>
                {remaining > 0
                  ? `重试沿用剩余 ${numberText(remaining)} tokens。`
                  : "累计预算已耗尽，可从上方发起新的检查。"}
              </small>
            </>
          )}
        </div>
      )}
      {report && (
        <>
          <h4 className="health-verdict">
            {job.status === "partial"
              ? "覆盖不足"
              : priorityVulnerabilities ||
                  report.result.findings.some((finding) => ["high", "critical"].includes(finding.severity))
                ? "有高优先级意见"
                : report.result.findings.length
                  ? "有建议需要查看"
                  : "已检查范围未产出意见"}
          </h4>
          <p>
            {report.result.findings.length} 条意见 ·{" "}
            {report.result.findings.filter((finding) => ["high", "critical"].includes(finding.severity)).length} 条高 /
            严重
            {priorityVulnerabilities > 0 && ` · ${priorityVulnerabilities} 个依赖需优先升级`}
          </p>
          {report.missingData.length > 0 && (
            <section className="health-notice" aria-label="缺失数据与覆盖限制">
              <strong>这些范围尚未完整覆盖</strong>
              <ul>
                {report.missingData.map((item, index) => (
                  <li key={index}>
                    <strong>{healthSourceLabels[item.source] ?? item.source}：</strong>
                    {item.detail}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {report.secretScan && <SecretScanView scan={report.secretScan} fileUrl={sourceUrl} />}
          {report.sastScan && <SastScanView scan={report.sastScan} fileUrl={sourceUrl} />}
          {report.dependencyAudit && <DependencyAuditView audit={report.dependencyAudit} fileUrl={sourceUrl} />}
          {(Object.keys(healthLabels) as HealthDimension[])
            .filter((dimension) => report.result.findings.some((finding) => finding.dimension === dimension))
            .map((dimension) => {
              const findings = report.result.findings.filter((item) => item.dimension === dimension);
              return (
                <section className="health-dimension" key={dimension}>
                  <h4>
                    {healthLabels[dimension]} <span className="muted">{findings.length} 条意见</span>
                  </h4>
                  {!findings.length ? (
                    <p className="muted">在已检查范围内未产出该维度意见；覆盖限制见上方。</p>
                  ) : (
                    findings.map((finding) => (
                      <article
                        className={`health-finding severity-${finding.severity}`}
                        key={finding.id}
                        id={finding.id}
                      >
                        <div className="health-finding-labels">
                          <Status value={finding.severity} />
                          <span>{healthLabels[finding.dimension]}</span>
                          {finding.chain && finding.evidenceLevel === "weak" && (
                            <span className="needs-review">需人工确认：没追到入口</span>
                          )}
                        </div>
                        <h5>{finding.description}</h5>
                        {finding.chain && (
                          <ol className="security-chain">
                            {finding.chain.source && (
                              <li>
                                <span className="chain-role">入口</span>
                                <a
                                  href={sourceUrl(finding.chain.source.path, finding.chain.source.line)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {finding.chain.source.path}:{finding.chain.source.line}
                                </a>
                                <span className="muted">{finding.chain.source.detail}</span>
                              </li>
                            )}
                            {finding.chain.steps.map((step, index) => (
                              <li key={index}>
                                <span className="chain-role">经过</span>
                                <a href={sourceUrl(step.path, step.line)} target="_blank" rel="noreferrer">
                                  {step.path}:{step.line}
                                </a>
                                <span className="muted">{step.detail}</span>
                              </li>
                            ))}
                            <li>
                              <span className="chain-role chain-sink">危险操作</span>
                              <a
                                href={sourceUrl(finding.chain.sink.path, finding.chain.sink.line)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {finding.chain.sink.path}:{finding.chain.sink.line}
                              </a>
                              <span className="muted">{finding.chain.sink.detail}</span>
                            </li>
                            <li className="chain-missing">
                              <span className="chain-role">缺少</span>
                              {finding.chain.missingControl}
                            </li>
                          </ol>
                        )}
                        <p>
                          <strong>建议：</strong>
                          {finding.suggestion}
                        </p>
                        <details>
                          <summary>查看影响与依据</summary>
                          <p>{finding.impact}</p>
                          <ul>
                            {finding.references.map((reference, index) => (
                              <li key={index}>
                                {reference.kind === "code" ? (
                                  <a href={sourceUrl(reference.path, reference.line)} target="_blank" rel="noreferrer">
                                    {reference.path}:{reference.line}
                                  </a>
                                ) : reference.kind === "memory" ? (
                                  <code>
                                    {reference.id} v{reference.version}
                                  </code>
                                ) : reference.kind === "sast" ? (
                                  (() => {
                                    const record = report.sastScan?.records.find((item) => item.id === reference.id);
                                    return record ? (
                                      <a href={sourceUrl(record.path, record.line)} target="_blank" rel="noreferrer">
                                        规则扫描 · {record.label} · {record.path}:{record.line}
                                      </a>
                                    ) : (
                                      <code>{reference.id}</code>
                                    );
                                  })()
                                ) : reference.kind === "secret" ? (
                                  (() => {
                                    const record = report.secretScan?.records.find((item) => item.id === reference.id);
                                    return record ? (
                                      <a href={sourceUrl(record.path, record.line)} target="_blank" rel="noreferrer">
                                        {record.label} · {record.path}:{record.line}
                                      </a>
                                    ) : (
                                      <code>{reference.id}</code>
                                    );
                                  })()
                                ) : reference.kind === "vulnerability" ? (
                                  <a
                                    href={`https://osv.dev/vulnerability/${encodeURIComponent(reference.id)}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    依赖漏洞 · {reference.id}
                                  </a>
                                ) : (
                                  <a
                                    href={report.sources.find((source) => source.id === reference.sourceId)?.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    CI 来源 · {reference.sourceId}
                                  </a>
                                )}
                                <p>{reference.detail}</p>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </article>
                    ))
                  )}
                </section>
              );
            })}
          <details className="full-health-report">
            <summary>查看完整报告与历史对比</summary>
            <p>
              固定快照：
              <a href={`https://github.com/${job.repository}/tree/${job.target_sha}`} target="_blank" rel="noreferrer">
                {job.payload?.defaultBranch} / <code>{job.target_sha}</code>
              </a>
            </p>
            <dl className="health-meta">
              <div>
                <dt>数据窗口</dt>
                <dd>
                  {dateText(job.payload?.windowStart)}
                  <br />至 {dateText(job.payload?.windowEnd)}
                </dd>
              </div>
              <div>
                <dt>任务用量 / 预算</dt>
                <dd>
                  {numberText(usage.totalTokens)} / {numberText(Number(job.payload?.scope?.budgetTokens ?? 0))} tokens
                </dd>
              </div>
              <div>
                <dt>触发方式</dt>
                <dd>
                  {job.payload?.trigger === "schedule" ? "定时检查" : "手动检查"} · 第 {job.attempt} 次尝试
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{dateText(job.created_at)}</dd>
              </div>
            </dl>
            {usage.unreportedTokens > 0 && (
              <p className="health-notice">
                另保留 {numberText(usage.unreportedTokens)} tokens 的未回报消耗，已计入本任务额度。
              </p>
            )}
            <p className="rule-content">{report.result.summary}</p>
            <section className="health-comparison">
              <h4>历史对比</h4>
              <p className="muted">仅比较同口径的观察数量，数量下降不等于问题已修复。</p>
              {detail.previous && (
                <button className="secondary" onClick={() => choose(detail.previous!.jobId)}>
                  查看上次报告 · {dateText(detail.previous.completedAt)}
                </button>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">维度</th>
                      <th scope="col">上次</th>
                      <th scope="col">本次</th>
                      <th scope="col">变化</th>
                      <th scope="col">可比性</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.comparison?.dimensions.map((item) => (
                      <tr key={item.dimension}>
                        <th scope="row">{healthLabels[item.dimension]}</th>
                        <td>{detail.previous ? item.before : "—"}</td>
                        <td>{item.after}</td>
                        <td>{item.delta === null ? "—" : `${item.delta > 0 ? "+" : ""}${item.delta}`}</td>
                        <td>
                          {item.reason}
                          {detail.previous && (
                            <small>
                              上次：严重 {item.previousSeverity.critical} / 高 {item.previousSeverity.high} / 中{" "}
                              {item.previousSeverity.medium} / 低 {item.previousSeverity.low}
                            </small>
                          )}
                          <small>
                            本次：严重 {item.currentSeverity.critical} / 高 {item.currentSeverity.high} / 中{" "}
                            {item.currentSeverity.medium} / 低 {item.currentSeverity.low}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <details className="health-evidence">
              <summary>实际读取范围与团队规则（{report.coverage.files.length} 个选定文件）</summary>
              <p>
                包含路径：{report.scope.includePaths.join("、") || "全部路径"}；排除路径：
                {report.scope.excludePaths.join("、") || "无额外排除"}。
              </p>
              <p>范围内 {report.coverage.eligibleFiles} 个路径；以下为工具实际返回给模型的行数。</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">文件</th>
                      <th scope="col">已读取 / 总行数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.coverage.files.map((file) => (
                      <tr key={file.path}>
                        <td>
                          <code>{file.path}</code>
                        </td>
                        <td>
                          {file.readLines} / {file.totalLines}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                实际提供的团队规则：
                {report.coverage.memoryReferences.length
                  ? report.coverage.memoryReferences.map((item) => (
                      <code className="health-memory-ref" key={item.id}>
                        {item.id} v{item.version}
                      </code>
                    ))
                  : "无"}
              </p>
              {report.coverage.skippedFiles.length > 0 && (
                <details>
                  <summary>跳过的文件（最多显示 200 项）</summary>
                  <ul>
                    {report.coverage.skippedFiles.map((item) => (
                      <li key={item.path}>
                        <code>{item.path}</code> · {item.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </details>
            {report.securityAudit && (
              <details className="health-evidence">
                <summary>
                  攻击面地图（{report.securityAudit.sources.length} 个入口 · {report.securityAudit.sinks.length}{" "}
                  处危险操作）
                </summary>
                <p>
                  {report.securityAudit.status === "skipped"
                    ? "没有找到入口或危险操作，这次没有做安全链路分析。"
                    : report.securityAudit.status === "failed"
                      ? "安全链路分析没有完成或没通过校验，原因见上方。"
                      : "按规则找到的入口和危险操作，交给安全审查 Agent 追链路；只是线索，可能有遗漏。"}
                  {report.securityAudit.truncated && " 数量超过上限，只列出前一部分。"}
                </p>
                <ul>
                  {[...report.securityAudit.sources, ...report.securityAudit.sinks].map((point) => (
                    <li key={point.id}>
                      {point.role === "source" ? "入口" : "危险操作"} · {surfaceLabels[point.kind] ?? point.kind} ·{" "}
                      <a href={sourceUrl(point.path, point.line)} target="_blank" rel="noreferrer">
                        {point.path}:{point.line}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details className="health-evidence">
              <summary>CI 来源（{report.sources.length} 项）</summary>
              {!report.sources.length ? (
                <p>没有可用 CI 来源，原因见缺失数据。</p>
              ) : (
                <ul>
                  {report.sources.map((source) => (
                    <li key={source.id}>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.name}
                      </a>{" "}
                      · {source.conclusion ?? source.status}
                      <p>
                        <code>{source.sha.slice(0, 12)}</code> · {source.target ? "目标 SHA" : "历史 SHA"} ·{" "}
                        {dateText(source.at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <details className="health-evidence">
              <summary>方法限制与运行信息</summary>
              <ul>
                {report.result.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
              <p>
                {report.model} · {(report.durationMs / 1000).toFixed(1)} s
              </p>
              <p>
                采集时间：{dateText(report.collectedAt)}；完成时间：{dateText(report.completedAt)}。
              </p>
              <p>
                输入 {usage.input} · 输出 {usage.output} · 缓存读取 {usage.cacheRead} · 缓存写入 {usage.cacheWrite}
              </p>
              <small>Job {job.id}</small>
            </details>
          </details>
        </>
      )}
    </article>
  );
}
