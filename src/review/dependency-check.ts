import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readWorkspaceFile } from "../workspace/workspace.js";
import {
  DEPENDENCY_LIMITS,
  ecosystemOf,
  parseManifest,
  type Dependency,
  type OsvClient,
} from "../health/vulnerabilities.js";
import { groupVulnerabilities, isPriorityVulnerability } from "../health/vulnerability-records.js";
import { displayFinding, shortText } from "./presentation.js";
import type { Finding, ReviewResult, StoredFinding } from "./types.js";

const exec = promisify(execFile);
const keyOf = (item: Dependency) => `${item.ecosystem}\0${item.name}\0${item.version}`;

// 只看 PR 改动过的锁文件，找出这次新引入或换了版本的依赖再去查 OSV；锁文件没变就不发请求。
// 结果由服务端直接生成，不经过模型。
export async function checkDependencyChanges(
  root: string,
  baseSha: string,
  files: Array<{ filename: string; status?: string }>,
  osv: Pick<OsvClient, "audit">,
  previous: StoredFinding[],
  signal: AbortSignal,
): Promise<{ findings: Finding[]; limitations: string[]; audit?: ReviewResult["dependencyAudit"] }> {
  const manifests = files.filter((file) => file.status !== "removed" && ecosystemOf(file.filename));
  if (!manifests.length) return { findings: [], limitations: [] };
  const limitations: string[] = [],
    added: Dependency[] = [];
  for (const { filename } of manifests.slice(0, DEPENDENCY_LIMITS.manifests)) {
    signal.throwIfAborted();
    try {
      const info = await lstat(join(root, filename));
      if (!info.isFile() || info.isSymbolicLink() || info.size > DEPENDENCY_LIMITS.manifestBytes)
        throw new Error("锁文件过大或不是普通文件");
      const head = parseManifest(filename, await readWorkspaceFile(root, filename, signal))!;
      const before = await exec("git", ["-C", root, "show", `${baseSha}:${filename}`], {
        signal,
        maxBuffer: DEPENDENCY_LIMITS.manifestBytes,
      }).then(
        ({ stdout }) => parseManifest(filename, stdout)!.dependencies,
        () => [] as Dependency[],
      );
      const known = new Set(before.map(keyOf));
      added.push(...head.dependencies.filter((item) => !known.has(keyOf(item))));
    } catch {
      signal.throwIfAborted();
      limitations.push(`${filename} 无法读取或解析，没有检查新增依赖的漏洞。`);
    }
  }
  if (manifests.length > DEPENDENCY_LIMITS.manifests)
    limitations.push(`改动了 ${manifests.length} 个锁文件，只检查前 ${DEPENDENCY_LIMITS.manifests} 个。`);
  const unique = [...new Map(added.map((item) => [keyOf(item), item])).values()];
  if (!unique.length) return { findings: [], limitations };
  const result = await osv.audit(added, signal);
  limitations.push(...result.missingData.map((item) => item.detail));
  const groups = groupVulnerabilities(result.vulnerabilities);
  const findings: Finding[] = [];
  let quiet = 0;
  for (const group of groups) {
    // 和健康检查一样只把"高危以上并且已能修复"的当成问题发出来，其余只在管理页列出。
    if (!group.records.some(isPriorityVulnerability)) {
      quiet++;
      continue;
    }
    const top = group.records[0]!;
    const cve = top.aliases.find((alias) => alias.startsWith("CVE-"));
    const ids = group.records.map((record) => record.id);
    const title = shortText(`新引入的 ${group.package} ${group.version} 有已知漏洞`, 40);
    const prior = previous.find((item) => item.path === group.manifestPath && displayFinding(item).title === title);
    findings.push({
      category: "security",
      severity: group.severity === "critical" ? "critical" : "high",
      evidenceLevel: "strong",
      path: group.manifestPath,
      ...(group.line ? { line: group.line, side: "RIGHT" as const } : {}),
      description: `这次改动引入的 ${group.package} ${group.version} 有 ${group.records.length} 个已知漏洞（OSV 漏洞库）。`,
      evidence: `${ids.slice(0, 10).join("、")}${ids.length > 10 ? ` 等 ${ids.length} 个` : ""}`,
      impact: top.summary || "漏洞库没有提供摘要。",
      suggestion: group.upgradeTo ? `升级到 ${group.upgradeTo} 或更高。` : "暂无修复版本，评估是否需要替换。",
      display: {
        title,
        reason: shortText(`${cve ?? top.id}：${top.summary || "已知漏洞"}`, 50),
        fix: shortText(
          group.upgradeTo
            ? `升级到 ${group.upgradeTo} 或更高${group.records.length > 1 ? `，可修掉 ${group.records.length - group.unfixed} 个` : ""}`
            : "暂无修复版本",
          30,
        ),
        ...(prior ? { previousFindingId: prior.id } : {}),
      },
    });
  }
  if (quiet) limitations.push(`新引入的依赖里另有 ${quiet} 个只有中低危或暂无修复版本的漏洞，详见管理页。`);
  return {
    findings,
    limitations,
    audit: {
      manifests: manifests.map((file) => file.filename),
      queried: result.queried,
      vulnerabilities: result.vulnerabilities,
    },
  };
}
