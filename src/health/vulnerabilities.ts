import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readWorkspaceFile } from "../workspace/workspace.js";
import type {
  DependencyEcosystem,
  HealthMissingData,
  HealthScope,
  VulnerabilityRecord,
  VulnerabilitySeverity,
} from "./types.js";
import { scopedPaths } from "./health.service.js";
import { compareVersions, sortVulnerabilities } from "./vulnerability-records.js";

export const DEPENDENCY_LIMITS = {
  manifests: 30,
  manifestBytes: 8 * 1024 * 1024,
  queries: 5000,
  details: 300,
  concurrency: 8,
  promptRecords: 50,
};

export interface Dependency {
  ecosystem: DependencyEcosystem;
  name: string;
  version: string;
  manifestPath: string;
  line?: number;
  dev: boolean;
}
interface ParsedManifest {
  ecosystem: DependencyEcosystem;
  dependencies: Dependency[];
  unresolved: number;
}

// 这些文件说明仓库有依赖，但目前还解析不了；报告里要写明，不能当成没有漏洞。
const UNSUPPORTED = new Set([
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "gradle.lockfile",
  "build.gradle",
  "build.gradle.kts",
  "packages.lock.json",
]);

export function ecosystemOf(path: string): DependencyEcosystem | undefined {
  const name = basename(path);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") return "npm";
  if (name === "go.mod") return "Go";
  if (name === "Cargo.lock") return "crates.io";
  if (name === "poetry.lock" || name === "uv.lock" || /^requirements[^/]*\.txt$/.test(name)) return "PyPI";
  if (name === "pom.xml") return "Maven";
  return undefined;
}

function lineAt(content: string, index: number) {
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < index; i = content.indexOf("\n", i + 1)) line++;
  return line;
}

function parseNpmLock(path: string, content: string): ParsedManifest {
  const data = JSON.parse(content);
  const dependencies: Dependency[] = [];
  const push = (name: string, version: unknown, dev: boolean, line?: number) => {
    // git、file、link 依赖的 version 不是注册表版本，查 OSV 会误报。
    if (typeof version === "string" && !/^(?:git|file|link|https?):/.test(version))
      dependencies.push({ ecosystem: "npm", name, version, manifestPath: path, line, dev });
  };
  if (data?.packages && typeof data.packages === "object") {
    const lines = new Map<string, number>();
    for (const [index, text] of content.split(/\r?\n/).entries()) {
      const match = /^\s*"([^"]*node_modules\/[^"]+)":\s*\{/.exec(text);
      if (match && !lines.has(match[1]!)) lines.set(match[1]!, index + 1);
    }
    for (const [key, value] of Object.entries<any>(data.packages)) {
      if (!key.includes("node_modules/") || !value || value.link) continue;
      if (typeof value.resolved === "string" && !/^https?:/.test(value.resolved)) continue;
      const name = typeof value.name === "string" ? value.name : key.slice(key.lastIndexOf("node_modules/") + 13);
      push(name, value.version, value.dev === true, lines.get(key));
    }
  } else {
    const walk = (entries: unknown) => {
      if (!entries || typeof entries !== "object") return;
      for (const [name, value] of Object.entries<any>(entries)) {
        push(name, value?.version, value?.dev === true);
        walk(value?.dependencies);
      }
    };
    walk(data?.dependencies);
  }
  return { ecosystem: "npm", dependencies, unresolved: 0 };
}

function parseGoMod(path: string, content: string): ParsedManifest {
  const found: Dependency[] = [],
    replaced = new Set<string>();
  let block: "require" | "replace" | null = null;
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const text = raw.replace(/\/\/.*$/, "").trim();
    const opened = /^(require|replace)\s*\($/.exec(text);
    if (opened) {
      block = opened[1] as "require" | "replace";
      continue;
    }
    if (block && text === ")") {
      block = null;
      continue;
    }
    const replace =
      block === "replace" ? /^(\S+)(?:\s+\S+)?\s+=>/.exec(text) : /^replace\s+(\S+)(?:\s+\S+)?\s+=>/.exec(text);
    if (replace) {
      replaced.add(replace[1]!);
      continue;
    }
    const require = block === "require" ? /^(\S+)\s+v(\S+)$/.exec(text) : /^require\s+(\S+)\s+v(\S+)$/.exec(text);
    if (require)
      found.push({
        ecosystem: "Go",
        name: require[1]!,
        version: require[2]!,
        manifestPath: path,
        line: index + 1,
        dev: false,
      });
  }
  // 被 replace 的模块实际用的不是这里写的版本，按原版本查会给出错误结论。
  const dependencies = found.filter((item) => !replaced.has(item.name));
  return { ecosystem: "Go", dependencies, unresolved: found.length - dependencies.length };
}

// Cargo.lock、poetry.lock、uv.lock 都是 [[package]] 块，只取块头部的 name、version、source。
function parsePackageBlocks(
  path: string,
  content: string,
  ecosystem: DependencyEcosystem,
  accept: (source: string | undefined) => boolean,
): ParsedManifest {
  const dependencies: Dependency[] = [];
  let current: { name?: string; version?: string; source?: string; line?: number } | null = null,
    collecting = false;
  const flush = () => {
    if (current?.name && current.version && accept(current.source))
      dependencies.push({
        ecosystem,
        name: ecosystem === "PyPI" ? current.name.toLowerCase().replace(/[._-]+/g, "-") : current.name,
        version: current.version,
        manifestPath: path,
        line: current.line,
        dev: false,
      });
  };
  for (const [index, text] of content.split(/\r?\n/).entries()) {
    if (/^\[\[package\]\]\s*$/.test(text)) {
      flush();
      current = {};
      collecting = true;
      continue;
    }
    if (text.startsWith("[")) {
      collecting = false;
      continue;
    }
    const field = collecting ? /^(name|version|source)\s*=\s*(.+?)\s*$/.exec(text) : null;
    if (!field || !current) continue;
    const value = field[2]!.replace(/^"(.*)"$/, "$1");
    if (field[1] === "name") {
      current.name = value;
      current.line = index + 1;
    } else if (field[1] === "version") current.version = value;
    else current.source = value;
  }
  flush();
  return { ecosystem, dependencies, unresolved: 0 };
}

function parseRequirements(path: string, content: string): ParsedManifest {
  const dependencies: Dependency[] = [];
  let unresolved = 0;
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    const text = raw
      .replace(/(^|\s)#.*$/, "")
      .split(/\s+--/)[0]!
      .replace(/\\$/, "")
      .split(";")[0]!
      .trim();
    if (!text || text.startsWith("-")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s,*]+)$/.exec(text);
    if (match)
      dependencies.push({
        ecosystem: "PyPI",
        name: match[1]!.toLowerCase().replace(/[._-]+/g, "-"),
        version: match[2]!,
        manifestPath: path,
        line: index + 1,
        dev: false,
      });
    else if (/^[A-Za-z0-9]/.test(text)) unresolved++;
  }
  return { ecosystem: "PyPI", dependencies, unresolved };
}

function parsePom(path: string, content: string): ParsedManifest {
  const properties = new Map<string, string>();
  for (const block of content.matchAll(/<properties>([\s\S]*?)<\/properties>/g))
    for (const entry of block[1]!.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) properties.set(entry[1]!, entry[2]!);
  const dependencies: Dependency[] = [];
  let unresolved = 0;
  for (const match of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(match[1]!)?.[1];
    const group = tag("groupId"),
      artifact = tag("artifactId");
    if (!group || !artifact) continue;
    const version = tag("version")?.replace(/\$\{([^}]+)\}/g, (whole, key) => properties.get(key) ?? whole);
    // 没写版本（由 parent / BOM 管理）、引用不到的属性、版本范围，都确定不了实际版本。
    if (!version || version.includes("${") || /[[\](),]/.test(version)) {
      unresolved++;
      continue;
    }
    dependencies.push({
      ecosystem: "Maven",
      name: `${group}:${artifact}`,
      version,
      manifestPath: path,
      line: lineAt(content, match.index!),
      dev: tag("scope") === "test",
    });
  }
  return { ecosystem: "Maven", dependencies, unresolved };
}

export function parseManifest(path: string, content: string): ParsedManifest | undefined {
  const name = basename(path);
  switch (ecosystemOf(path)) {
    case "npm":
      return parseNpmLock(path, content);
    case "Go":
      return parseGoMod(path, content);
    case "crates.io":
      return parsePackageBlocks(path, content, "crates.io", (source) => Boolean(source?.startsWith("registry+")));
    case "PyPI":
      if (name === "uv.lock")
        return parsePackageBlocks(path, content, "PyPI", (source) => Boolean(source?.includes("registry")));
      if (name === "poetry.lock") return parsePackageBlocks(path, content, "PyPI", () => true);
      return parseRequirements(path, content);
    case "Maven":
      return parsePom(path, content);
    default:
      return undefined;
  }
}

// 锁文件单独读取：通常比普通源码大很多，不能受健康检查单文件上限影响。
export async function collectDependencies(root: string, scope: HealthScope, signal: AbortSignal) {
  const paths = await scopedPaths(root, scope, signal);
  const manifests: Array<{ path: string; ecosystem: DependencyEcosystem; dependencies: number }> = [],
    dependencies: Dependency[] = [],
    missingData: HealthMissingData[] = [];
  const missing = (reason: string, detail: string) => missingData.push({ source: "vulnerabilities", reason, detail });
  const unsupported = paths.filter((path) => UNSUPPORTED.has(basename(path)));
  if (unsupported.length)
    missing(
      "unsupported_manifest",
      `暂不支持解析 ${[...new Set(unsupported.map((path) => basename(path)))].join("、")}，这些依赖未检查漏洞。`,
    );
  const candidates = paths.filter((path) => ecosystemOf(path));
  if (candidates.length > DEPENDENCY_LIMITS.manifests)
    missing("manifest_limit", `共 ${candidates.length} 个锁文件，只检查前 ${DEPENDENCY_LIMITS.manifests} 个。`);
  let unresolved = 0;
  const failed: string[] = [];
  for (const path of candidates.slice(0, DEPENDENCY_LIMITS.manifests)) {
    signal.throwIfAborted();
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink() || info.size > DEPENDENCY_LIMITS.manifestBytes) {
        failed.push(path);
        continue;
      }
      const parsed = parseManifest(path, await readWorkspaceFile(root, path, signal))!;
      manifests.push({ path, ecosystem: parsed.ecosystem, dependencies: parsed.dependencies.length });
      dependencies.push(...parsed.dependencies);
      unresolved += parsed.unresolved;
    } catch {
      signal.throwIfAborted();
      failed.push(path);
    }
  }
  if (failed.length) missing("unreadable_manifest", `${failed.join("、")} 无法读取或解析，未检查漏洞。`);
  if (unresolved)
    missing("unresolved_version", `${unresolved} 个依赖没有写死版本（版本范围、由父项目管理或被替换），未检查漏洞。`);
  return { manifests, dependencies, missingData };
}

const SEVERITIES: Record<string, VulnerabilitySeverity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "medium",
  MEDIUM: "medium",
  LOW: "low",
};
const OSV_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/;

function sameName(ecosystem: DependencyEcosystem, a: string, b: string) {
  if (ecosystem !== "PyPI") return a === b;
  const normalize = (value: string) => value.toLowerCase().replace(/[._-]+/g, "-");
  return normalize(a) === normalize(b);
}

// 同一漏洞常按多个版本分支分别修复；只保留覆盖当前版本的那一段的修复版本。
function fixedVersionsFor(version: string, affected: any[]) {
  const all: string[] = [],
    matching: string[] = [];
  for (const entry of affected)
    for (const range of Array.isArray(entry?.ranges) ? entry.ranges : []) {
      let introduced: string | undefined;
      for (const event of Array.isArray(range?.events) ? range.events : []) {
        if (typeof event?.introduced === "string") introduced = event.introduced;
        if (typeof event?.fixed !== "string" || event.fixed.length > 100) continue;
        all.push(event.fixed);
        if (
          (!introduced || introduced === "0" || compareVersions(introduced, version) <= 0) &&
          compareVersions(version, event.fixed) < 0
        )
          matching.push(event.fixed);
        introduced = undefined;
      }
    }
  return [...new Set(matching.length ? matching : all)].slice(0, 10);
}

export class OsvClient {
  // 单 Worker 串行执行，每个请求都要有上限，避免挡住后面的任务。
  constructor(
    private baseUrl = "https://api.osv.dev",
    private requestTimeoutMs = 30_000,
  ) {}

  private async request<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) throw new Error(`OSV 请求失败：${path}`);
    return (await response.json()) as T;
  }

  async audit(dependencies: Dependency[], signal: AbortSignal) {
    const missingData: HealthMissingData[] = [];
    const missing = (reason: string, detail: string) => {
      if (!missingData.some((item) => item.reason === reason))
        missingData.push({ source: "vulnerabilities", reason, detail });
    };
    const keyOf = (item: Dependency) => `${item.ecosystem}\0${item.name}\0${item.version}`;
    const queries = [...new Map(dependencies.map((item) => [keyOf(item), item])).values()];
    if (queries.length > DEPENDENCY_LIMITS.queries)
      missing("query_limit", `共 ${queries.length} 个依赖版本，只查询前 ${DEPENDENCY_LIMITS.queries} 个。`);
    const queried = queries.slice(0, DEPENDENCY_LIMITS.queries);
    const idsByKey = new Map<string, string[]>();
    try {
      for (let start = 0; start < queried.length; start += 1000) {
        const chunk = queried.slice(start, start + 1000);
        const body = await this.request<{
          results?: Array<{ vulns?: Array<{ id?: unknown }>; next_page_token?: unknown }>;
        }>(
          "/v1/querybatch",
          {
            method: "POST",
            body: JSON.stringify({
              queries: chunk.map((item) => ({
                package: { ecosystem: item.ecosystem, name: item.name },
                version: item.version,
              })),
            }),
          },
          signal,
        );
        if (!Array.isArray(body.results) || body.results.length !== chunk.length)
          throw new Error("OSV 批量查询响应结构无效");
        for (const [index, result] of body.results.entries()) {
          if (result?.next_page_token) missing("truncated", "部分依赖的漏洞记录超过一页，只取第一页。");
          const ids = (result?.vulns ?? [])
            .map((vuln) => vuln?.id)
            .filter((id): id is string => typeof id === "string" && OSV_ID.test(id));
          if (ids.length) idsByKey.set(keyOf(chunk[index]!), ids);
        }
      }
    } catch {
      signal.throwIfAborted();
      missing("fetch_failed", "无法访问 OSV 漏洞库，未完成依赖漏洞检查。");
      // 一个都没查成，queried 记 0，页面据此说"没有查成"而不是"没有发现"。
      return { queried: 0, vulnerabilities: [], missingData };
    }
    const ids = [...new Set([...idsByKey.values()].flat())];
    if (ids.length > DEPENDENCY_LIMITS.details)
      missing("detail_limit", `共 ${ids.length} 条漏洞，只取前 ${DEPENDENCY_LIMITS.details} 条的详情。`);
    const details = new Map<string, any>();
    const pending = ids.slice(0, DEPENDENCY_LIMITS.details);
    await Promise.all(
      Array.from({ length: Math.min(DEPENDENCY_LIMITS.concurrency, pending.length) }, async () => {
        for (let id = pending.shift(); id; id = pending.shift()) {
          try {
            details.set(id, await this.request(`/v1/vulns/${encodeURIComponent(id)}`, {}, signal));
          } catch {
            signal.throwIfAborted();
            missing("detail_failed", "部分漏洞详情获取失败，等级和修复版本未知。");
          }
        }
      }),
    );
    const vulnerabilities: VulnerabilityRecord[] = [],
      recorded = new Set<string>();
    for (const dependency of dependencies) {
      const candidates = (idsByKey.get(keyOf(dependency)) ?? []).map((id) => {
        const detail = details.get(id) ?? {};
        const affected = (Array.isArray(detail.affected) ? detail.affected : []).filter(
          (entry: any) =>
            entry?.package?.ecosystem === dependency.ecosystem &&
            typeof entry.package.name === "string" &&
            sameName(dependency.ecosystem, entry.package.name, dependency.name),
        );
        const fixedVersions = fixedVersionsFor(dependency.version, affected);
        const summary =
          typeof detail.summary === "string"
            ? detail.summary
            : typeof detail.details === "string"
              ? detail.details
              : "";
        return {
          id,
          aliases: (Array.isArray(detail.aliases) ? detail.aliases : [])
            .filter((alias: unknown): alias is string => typeof alias === "string" && OSV_ID.test(alias))
            .slice(0, 10),
          summary: summary.replace(/\s+/g, " ").trim().slice(0, 300),
          severity: SEVERITIES[String(detail.database_specific?.severity ?? "").toUpperCase()] ?? "unknown",
          ecosystem: dependency.ecosystem,
          package: dependency.name,
          version: dependency.version,
          manifestPath: dependency.manifestPath,
          ...(dependency.line ? { line: dependency.line } : {}),
          dev: dependency.dev,
          fixedVersions,
          url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
        } satisfies VulnerabilityRecord;
      });
      // 同一个漏洞常在 GHSA、PYSEC、GO 等库里各有一条且互为别名；优先保留带等级的 GHSA。
      const seen = new Set<string>();
      for (const record of candidates.toSorted(
        (a, b) =>
          Number(b.severity !== "unknown") - Number(a.severity !== "unknown") ||
          Number(b.id.startsWith("GHSA-")) - Number(a.id.startsWith("GHSA-")),
      )) {
        if ([record.id, ...record.aliases].some((id) => seen.has(id))) continue;
        for (const id of [record.id, ...record.aliases]) seen.add(id);
        // npm 锁文件里同一版本可能在多处嵌套出现，同一锁文件只记一次。
        const key = [record.id, record.manifestPath, record.package, record.version].join("\0");
        if (recorded.has(key)) continue;
        recorded.add(key);
        vulnerabilities.push(record);
      }
    }
    return { queried: queried.length, vulnerabilities: sortVulnerabilities(vulnerabilities), missingData };
  }
}
