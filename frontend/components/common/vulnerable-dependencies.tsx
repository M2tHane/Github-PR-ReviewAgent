import type { VulnerableDependency } from "../../../src/health/vulnerability-records.js";
import { isPriorityVulnerability } from "../../../src/health/vulnerability-records.js";
import { Status } from "./status-badge.js";

const vulnerabilitySeverity: Record<string, string> = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  unknown: "未知等级",
};
export const isPriorityDependency = (group: VulnerableDependency) => group.records.some(isPriorityVulnerability);

export function VulnerableDependencies({
  groups,
  fileUrl,
}: {
  groups: VulnerableDependency[];
  fileUrl: (path: string, line?: number) => string;
}) {
  return (
    <ul className="vuln-list">
      {groups.map((group) => {
        const [first] = group.records;
        return (
          <li className={`health-finding severity-${group.severity}`} key={group.key}>
            <div className="health-finding-labels">
              <Status value={group.severity} label={vulnerabilitySeverity[group.severity]} />
              <span>{group.ecosystem}</span>
              {group.dev && <span>开发依赖</span>}
            </div>
            <h5 className="vuln-package">
              {group.package} <code>{group.version}</code>
            </h5>
            <p>
              <strong>修复：</strong>
              {group.upgradeTo ? `升级到 ${group.upgradeTo} 或更高` : "暂无修复版本"}
              {group.records.length > 1 &&
                (group.upgradeTo
                  ? `，可修掉 ${group.records.length - group.unfixed} 个漏洞${group.unfixed ? `，另有 ${group.unfixed} 个暂无修复版本` : ""}`
                  : `，共 ${group.records.length} 个漏洞`)}
            </p>
            <p className="muted">
              {group.records.length > 1 ? "最严重的一条：" : ""}
              {first!.summary || "漏洞库没有提供摘要。"}
            </p>
            <p className="vuln-meta">
              {group.records.length === 1 && (
                <a href={first!.url} target="_blank" rel="noreferrer">
                  {first!.id}
                </a>
              )}
              {group.records.length === 1 && first!.aliases.find((alias) => alias.startsWith("CVE-"))}
              <a href={fileUrl(group.manifestPath, group.line)} target="_blank" rel="noreferrer">
                {group.manifestPath}
                {group.line ? `:${group.line}` : ""}
              </a>
            </p>
            {group.records.length > 1 && (
              <details className="vuln-ids">
                <summary>查看全部 {group.records.length} 个漏洞</summary>
                <ul>
                  {group.records.map((record) => (
                    <li key={record.id}>
                      <a href={record.url} target="_blank" rel="noreferrer">
                        {record.id}
                      </a>{" "}
                      · {vulnerabilitySeverity[record.severity]}
                      {record.fixedVersions.length ? ` · 修复于 ${record.fixedVersions.join(" / ")}` : " · 暂无修复"}
                      {record.summary && <p>{record.summary}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
