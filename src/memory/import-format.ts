import type { DecisionProposal, ImportedMemorySource, MemoryRecord } from "./types.js";

export const RULE_IMPORT_EXAMPLE = `# 团队规则

## TEAM-001｜生产数据库使用 MySQL

类型：工程规范
适用路径：\`model/**\`、\`migrations/**\`

### 规则内容
生产数据库使用 MySQL。
新增数据库迁移需要考虑 MySQL 5.7 和 8 的兼容性。

### 制定原因
保持生产环境一致，避免引入未经验证的数据库兼容分支。

### 适用条件与例外
涉及生产查询、表结构和迁移时适用。
内存 SQLite 单元测试可以保留。

### 参考依据
团队数据库规范，以及相关历史提交。

## TEAM-002｜金额使用最小货币单位

类型：工程规范
适用路径：\`service/billing/**\`

### 规则内容
金额使用整数形式的最小货币单位，避免浮点误差。

### 制定原因
保证计费和退款计算一致。
`;

export const IMPORT_TYPES: Record<string, DecisionProposal["type"]> = {
  架构决策: "architecture_decision",
  工程规范: "engineering_rule",
  安全规则: "security_rule",
  编码约定: "coding_convention",
  例外规则: "exception",
  废弃模式: "deprecated_pattern",
};
export const MAX_IMPORT_RULES = 100;
export const MAX_MARKDOWN_BYTES = 512 * 1024;
export class RuleImportError extends Error {}
export interface ImportRule {
  key: string;
  type: DecisionProposal["type"];
  title: string;
  content: string;
  rationale: string;
  scope: DecisionProposal["scope"];
  evidence: DecisionProposal["evidence"];
  uncertainties: string[];
  exceptionKey?: string;
}
export interface PreviewRule extends ImportRule {
  source: ImportedMemorySource;
  sourceSnapshot?: MemoryRecord;
  duplicateId?: string;
  sameTitleIds: string[];
}
export interface ImportPreview {
  id: string;
  rules: PreviewRule[];
  expiresAt: string;
}
export interface ImportResult {
  imported: string[];
  skipped: string[];
}
export type ImportInput =
  | { kind: "markdown"; documentName: string; markdown: string }
  | { kind: "project"; sourceRepositoryId: number; rules: Array<{ id: string; paths: string[] }> };

export function validateImportPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new RuleImportError("适用路径必须为数组，最多 50 项");
  return [
    ...new Set(
      value.map((path) => {
        if (
          typeof path !== "string" ||
          !path.trim() ||
          path.length > 300 ||
          /[\\\x00-\x1f]/.test(path) ||
          path.trim().startsWith("/") ||
          /^[A-Za-z]:/.test(path.trim()) ||
          path
            .trim()
            .split("/")
            .some((part) => part === ".." || part === ".")
        )
          throw new RuleImportError("适用路径必须是仓库内相对路径或 glob，不能包含 ..、反斜杠或绝对路径");
        return path.trim();
      }),
    ),
  ];
}

export function parseRuleMarkdown(markdown: string): ImportRule[] {
  if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES)
    throw new RuleImportError("Markdown 超过 512 KiB");
  const lines = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const rules: ImportRule[] = [];
  const ids = new Set<string>();
  let current:
    | { key: string; title: string; line: number; meta: Map<string, string>; sections: Map<string, string[]> }
    | undefined;
  let section: string | undefined;
  let fence: { char: string; length: number } | undefined;
  let documentHeading = false;
  const fail = (line: number, reason: string): never => {
    throw new RuleImportError(`第 ${line} 行${current ? `（${current.key}）` : ""}：${reason}`);
  };
  function finish() {
    if (!current) return;
    const typeName = current.meta.get("类型") ?? "";
    const type = Object.hasOwn(IMPORT_TYPES, typeName) ? IMPORT_TYPES[typeName] : undefined;
    if (!type) fail(current.line, "缺少类型或类型不支持");
    const pathsText = current.meta.get("适用路径");
    if (!pathsText) fail(current.line, "缺少适用路径；全局规则请明确填写「整个仓库」");
    let paths: string[];
    if (pathsText === "整个仓库") paths = [];
    else {
      if (!/^`[^`]+`(?:\s*、\s*`[^`]+`)*$/.test(pathsText!)) fail(current.line, "路径需使用反引号包裹，以顿号分隔");
      try {
        paths = validateImportPaths([...pathsText!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
      } catch (error) {
        fail(current.line, (error as Error).message);
      }
    }
    const content = current.sections.get("规则内容")?.join("\n").trim();
    const rationale = current.sections.get("制定原因")?.join("\n").trim();
    if (!content || !rationale) fail(current.line, "规则内容和制定原因均为必填");
    for (const [name, text] of current.sections) if (!text.join("\n").trim()) fail(current.line, `${name}不能为空`);
    const exceptionKey = current.meta.get("例外关联");
    if (type === "exception" && (!exceptionKey || !paths!.length))
      fail(current.line, "例外规则必须限定路径并通过「例外关联：文档内规则编号」关联原规则");
    if (type !== "exception" && exceptionKey) fail(current.line, "只有例外规则可以填写例外关联");
    const extra = ["适用条件与例外", "参考依据"].flatMap((name) => {
      const text = current!.sections.get(name)?.join("\n").trim();
      return text ? [`### ${name}\n${text}`] : [];
    });
    rules.push({
      key: current.key,
      type: type!,
      title: current.title,
      content: [content!, ...extra].join("\n\n"),
      rationale: rationale!,
      scope: { paths: paths! },
      evidence: [],
      uncertainties: [],
      ...(exceptionKey ? { exceptionKey } : {}),
    });
  }
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (fence) {
      current!.sections.get(section!)!.push(line);
      if (new RegExp(`^\\s{0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening && current && section) {
      fence = { char: opening[1]![0]!, length: opening[1]!.length };
      current.sections.get(section)!.push(line);
      continue;
    }
    if (line.trim() === "# 团队规则" && !documentHeading && !current) {
      documentHeading = true;
      continue;
    }
    const heading = line.match(/^## ([A-Za-z0-9][A-Za-z0-9_-]{0,63})[｜|](.+)$/);
    if (heading) {
      if (!documentHeading) fail(number, "文档必须以 # 团队规则 开始");
      finish();
      if (ids.has(heading[1]!)) fail(number, `编号 ${heading[1]} 重复`);
      if (!heading[2]!.trim() || heading[2]!.trim().length > 200) fail(number, "规则名称需为 1–200 字");
      ids.add(heading[1]!);
      if (ids.size > MAX_IMPORT_RULES) fail(number, "每次最多导入 100 条规则");
      current = { key: heading[1]!, title: heading[2]!.trim(), line: number, meta: new Map(), sections: new Map() };
      section = undefined;
      continue;
    }
    if (/^#{1,2}(?:\s|$)/.test(line)) fail(number, "标题格式应为 ## 编号｜名称");
    if (!current) {
      if (line.trim()) fail(number, "文档开头只允许 # 团队规则 和空行");
      continue;
    }
    const sub = line.match(/^### (.+)$/);
    if (sub) {
      const name = sub[1]!.trim();
      if (!["规则内容", "制定原因", "适用条件与例外", "参考依据"].includes(name)) fail(number, `不支持的栏目：${name}`);
      if (current.sections.has(name)) fail(number, `重复栏目：${name}`);
      section = name;
      current.sections.set(name, []);
      continue;
    }
    if (section) {
      current.sections.get(section)!.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const meta = line.match(/^(类型|适用路径|例外关联)[：:]\s*(.+)$/);
    if (!meta) fail(number, "无法识别的字段；请按示例填写类型、适用路径和正文栏目");
    if (current.meta.has(meta![1]!)) fail(number, `重复字段：${meta![1]}`);
    current.meta.set(meta![1]!, meta![2]!.trim());
  }
  if (fence) fail(lines.length, "代码围栏未关闭");
  finish();
  if (!rules.length) fail(1, "文档中没有规则");
  for (const rule of rules)
    if (rule.exceptionKey && !ids.has(rule.exceptionKey))
      throw new RuleImportError(`${rule.key} 的例外关联 ${rule.exceptionKey} 不在文档中`);
  return rules;
}
