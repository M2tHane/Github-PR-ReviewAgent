import assert from "node:assert/strict";
import test from "node:test";
import { parseRuleMarkdown, RULE_IMPORT_EXAMPLE, validateImportPaths } from "../../src/memory/import-format.js";
import { parseImportInput } from "../../src/admin/rule-import.routes.js";
import { memorySourceLabel } from "../../src/memory/types.js";
import { inlineBody } from "../../src/review/presentation.js";
import type { ReviewJob } from "../../src/jobs/types.js";

test("Markdown 示例可导入，保留条件和依据，不误设召回条件", () => {
  const rules = parseRuleMarkdown("\uFEFF" + RULE_IMPORT_EXAMPLE.replaceAll("\n", "\r\n"));
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0]!.scope, { paths: ["model/**", "migrations/**"] });
  assert.match(rules[0]!.content, /SQLite/);
  assert.match(rules[0]!.content, /历史提交/);
  assert.equal(rules[0]!.key, "TEAM-001");
});

test("Markdown 拒绝缺字段、重复编号、未知栏目和说明文本，不静默丢弃", () => {
  for (const [input, reason] of [
    [RULE_IMPORT_EXAMPLE.replace("类型：工程规范", "类型：猜测"), /第 .* 行.*类型/],
    [RULE_IMPORT_EXAMPLE.replace("类型：工程规范", "类型：constructor"), /类型/],
    [RULE_IMPORT_EXAMPLE.replace("TEAM-002", "TEAM-001"), /编号.*重复/],
    [RULE_IMPORT_EXAMPLE.replace("### 制定原因", "### 其他原因"), /不支持的栏目/],
    [RULE_IMPORT_EXAMPLE.replace("类型：工程规范", "优先级：高"), /无法识别的字段/],
    ["说明文字\n" + RULE_IMPORT_EXAMPLE, /第 1 行/],
    [RULE_IMPORT_EXAMPLE.replace("### 制定原因", "### 规则内容"), /重复栏目/],
    ["# 团队规则", /没有规则/],
    [RULE_IMPORT_EXAMPLE.replace("适用路径：`model/**`、`migrations/**`", ""), /缺少适用路径/],
    [RULE_IMPORT_EXAMPLE.replace("### 规则内容", "类型：工程规范\n### 规则内容"), /重复字段/],
  ] as const)
    assert.throws(() => parseRuleMarkdown(input), reason);
});

test("围栏内的规则标题是内容，未闭合围栏报错", () => {
  const text = RULE_IMPORT_EXAMPLE.replace(
    "生产数据库使用 MySQL。",
    "```md\n## INNER｜标题\n### 自定义栏目\n```\n生产数据库使用 MySQL。",
  );
  assert.equal(parseRuleMarkdown(text).length, 2);
  assert.match(parseRuleMarkdown(text)[0]!.content, /## INNER/);
  assert.throws(() => parseRuleMarkdown(text.replace("```\n生产", "生产")), /围栏未关闭/);
});

test("导入边界限制文件体积、数量、路径和跨项目输入", () => {
  assert.throws(() => parseRuleMarkdown("字".repeat(200_000)), /512 KiB/);
  const rule = RULE_IMPORT_EXAMPLE.split("## TEAM-002")[0]!.replace("# 团队规则\n", "");
  assert.throws(
    () =>
      parseRuleMarkdown(
        "# 团队规则\n" + Array.from({ length: 101 }, (_, i) => rule.replace("TEAM-001", `TEAM-${i}`)).join("\n"),
      ),
    /100 条/,
  );
  for (const path of ["../a", " /a", " ../a", "/a", "a/../b", "C:/a", "a\\b", "a\n"])
    assert.throws(() => validateImportPaths([path]), /相对路径/);
  assert.deepEqual(validateImportPaths(["src/**", "src/**"]), ["src/**"]);
  assert.throws(
    () => parseImportInput({ kind: "project", sourceRepositoryId: 1, rules: [{ id: "bad", paths: [] }] }),
    /编号/,
  );
  assert.throws(
    () => parseImportInput({ kind: "markdown", documentName: "a.txt", markdown: RULE_IMPORT_EXAMPLE }),
    /md 文件/,
  );
});

test("例外明确关联原规则且必须限定路径", () => {
  const text = RULE_IMPORT_EXAMPLE.replace(
    "## TEAM-002｜金额使用最小货币单位\n\n类型：工程规范",
    "## TEAM-002｜金额使用最小货币单位\n\n类型：例外规则\n例外关联：TEAM-001",
  );
  assert.equal(parseRuleMarkdown(text)[1]!.exceptionKey, "TEAM-001");
  assert.throws(() => parseRuleMarkdown(text.replace("例外关联：TEAM-001", "例外关联：UNKNOWN")), /不在文档中/);
  assert.throws(() => parseRuleMarkdown(text.replace("`service/billing/**`", "整个仓库")), /例外规则必须/);
});

test("导入规则引用展示真实来源，不拼接目标项目 PR 链接", () => {
  const source = {
    kind: "project_import" as const,
    importedBy: 7,
    importedByLogin: "maintainer",
    importedAt: "2026-11-05",
    repositoryName: "source/repo",
    memoryVersion: 3,
  };
  assert.match(memorySourceLabel(source), /source\/repo.*v3/);
  const text = inlineBody({ repository: "target/repo" } as ReviewJob, {
    id: "test",
    category: "team_rule",
    severity: "medium",
    evidenceLevel: "strong",
    description: "规则问题",
    evidence: "证据",
    impact: "影响",
    memory: { id: "memory", version: 1, source },
  });
  assert.match(text, /项目导入/);
  assert.doesNotMatch(text, /\/pull\//);
});
