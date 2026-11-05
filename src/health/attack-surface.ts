// 攻击面地图：按行用规则找出入口（Source）和危险操作（Sink），交给安全审查 Agent 追链路。
// 纯函数，PR 审查判断是否触发 Security 专项时也用这套规则。只是线索，漏报和误报都由 Agent 读代码核对。
export type SurfaceKind =
  | "http_route"
  | "webhook"
  | "sql"
  | "command"
  | "file"
  | "network"
  | "data_access"
  | "deserialize"
  | "code_eval";
export interface SurfacePoint {
  id: string;
  role: "source" | "sink";
  kind: SurfaceKind;
  path: string;
  line: number;
  text: string;
}

const HTTP_ROUTE = [
  /\b(?:app|router|server|api|routes?|fastify|r)\.(?:get|post|put|patch|delete|all)\s*\(\s*["'`/]/,
  /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\b/,
  /@(?:app|router|bp|blueprint|api)\.(?:route|get|post|put|patch|delete)\s*\(/,
  /\bhttp\.HandleFunc\s*\(|\.(?:HandleFunc|Handle|GET|POST|PUT|DELETE)\s*\(\s*"\//,
  /\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b/,
  /\bcreateServer\s*\(/,
];
const SINKS: Array<[SurfaceKind, RegExp]> = [
  [
    "sql",
    /\.(?:query|execute|executemany|executeQuery|executeUpdate|prepareStatement|raw|\$queryRawUnsafe|\$executeRawUnsafe|createQuery|createNativeQuery|Query|QueryRow|Exec|QueryContext|ExecContext)\s*\(/,
  ],
  [
    "command",
    /(?:^|[^.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(|\b(?:child_process|childProcess|cp)\.\w+\s*\(|\bsubprocess\.\w+\s*\(|\bos\.(?:system|popen)\s*\(|Runtime\.getRuntime\(\)\.exec|\bProcessBuilder\s*\(|\bexec\.Command\s*\(/,
  ],
  [
    "file",
    /\b(?:fs|fsp|promises)\.(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|rm|appendFile)\w*\s*\(|(?:^|[^.\w])(?:readFile|writeFile|createReadStream|unlink)\s*\(|\.(?:sendFile|download)\s*\(|(?:^|[^.\w])open\s*\(|\bos\.(?:Open|OpenFile|Create|ReadFile|WriteFile|Remove)\s*\(|\bnew\s+File(?:Input|Output)Stream\s*\(|\bFiles\.(?:read|write|delete)\w*\s*\(/,
  ],
  [
    "network",
    /(?:^|[^.\w])fetch\s*\(|\baxios(?:\.\w+)?\s*\(|\brequests\.(?:get|post|put|delete|request)\s*\(|\bhttps?\.(?:get|request)\s*\(|\bhttp\.(?:Get|Post|NewRequest)\s*\(|\b(?:RestTemplate|WebClient|HttpClient)\b/,
  ],
  [
    "data_access",
    /\.(?:findById|findByPk|findUnique|findFirst|findOne|getById|deleteById|updateById|findByIdAndUpdate)\s*\(/,
  ],
  ["deserialize", /\bpickle\.loads?\s*\(|\byaml\.load\s*\(|\bObjectInputStream\b|\bunserialize\s*\(|\bMarshal\.load/],
  ["code_eval", /(?:^|[^.\w])eval\s*\(|\bnew\s+Function\s*\(/],
];
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*)/;
const TEST_PATH = /(^|\/)(?:test|tests|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[^/]+$/i;
export const SURFACE_LIMITS = { sources: 80, sinks: 150 };

// 一行代码命中的入口 / 危险操作类型。
export function surfaceKinds(line: string): Array<{ role: SurfacePoint["role"]; kind: SurfaceKind }> {
  if (COMMENT.test(line)) return [];
  const found: Array<{ role: SurfacePoint["role"]; kind: SurfaceKind }> = [];
  if (HTTP_ROUTE.some((pattern) => pattern.test(line)))
    found.push({ role: "source", kind: /webhook/i.test(line) ? "webhook" : "http_route" });
  for (const [kind, pattern] of SINKS) if (pattern.test(line)) found.push({ role: "sink", kind });
  return found;
}

export function attackSurface(files: Map<string, string>) {
  const sources: SurfacePoint[] = [],
    sinks: SurfacePoint[] = [];
  let truncated = false;
  for (const [path, content] of files) {
    if (TEST_PATH.test(path)) continue;
    for (const [index, text] of content.split(/\r?\n/).entries()) {
      if (text.length > 500) continue;
      for (const { role, kind } of surfaceKinds(text)) {
        const list = role === "source" ? sources : sinks;
        if (list.length >= (role === "source" ? SURFACE_LIMITS.sources : SURFACE_LIMITS.sinks)) {
          truncated = true;
          continue;
        }
        list.push({
          id: `${role === "source" ? "src" : "sink"}_${list.length + 1}`,
          role,
          kind,
          path,
          line: index + 1,
          text: text.trim().slice(0, 160),
        });
      }
    }
  }
  return { sources, sinks, truncated };
}
