import assert from "node:assert/strict";
import test from "node:test";
import { createRuleBook, type TeamRuleRow } from "../../src/development/rules.js";

let next = 0;
function rule(title: string, scope: TeamRuleRow["scope"], extra: Partial<TeamRuleRow> = {}): TeamRuleRow {
  return {
    id: `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    version: 1,
    type: "engineering_rule",
    title,
    content: `${title}的正文`,
    rationale: "团队约定",
    scope,
    source: { pullRequestNumber: 1 },
    evidence: [],
    exception_to: null,
    ...extra,
  };
}
const attached = (text: string | undefined) => JSON.parse(text!.slice(text!.indexOf("\n") + 1));

test("全局规则开头给全文，按路径规则只进目录；条件标签不算路径范围", () => {
  const global = rule("错误带上下文", {}),
    conditional = rule("仅计费任务", { conditions: ["billing"] }),
    billing = rule("金额用最小单位", { paths: ["service/billing/**"] }),
    golang = rule("Go 错误包装", { languages: ["go"] });
  const prompt = createRuleBook([global, conditional, billing, golang]).prompt();
  assert.match(prompt.teamRuleMarker, /^团队规则-[0-9a-f]{8}$/);
  assert.deepEqual(
    prompt.globalTeamRules.map((r) => [r.ref, r.title, r.content]),
    [
      ["R1", "错误带上下文", "错误带上下文的正文"],
      ["R2", "仅计费任务", "仅计费任务的正文"],
    ],
  );
  assert.deepEqual(prompt.teamRuleIndex, [
    { ref: "R3", type: "engineering_rule", title: "金额用最小单位", paths: ["service/billing/**"] },
    { ref: "R4", type: "engineering_rule", title: "Go 错误包装", languages: ["go"] },
  ]);
  assert.equal(JSON.stringify(prompt.teamRuleIndex).includes("正文"), false);
});

test("读到匹配文件才附规则全文，同一规则只给一次；语言按扩展名匹配，条件标签不阻止", () => {
  const billing = rule("金额用最小单位", { paths: ["service/billing/**"], conditions: ["billing"] }),
    golang = rule("Go 错误包装", { languages: ["go"] }),
    web = rule("前端文案走 i18n", { paths: ["web/src/**"] });
  const book = createRuleBook([billing, golang, web]);
  const marker = book.prompt().teamRuleMarker;
  assert.equal(book.forFile("README.md"), undefined);
  const first = book.forFile("service/billing/refund.go");
  assert.ok(first?.startsWith(`${marker}：以下团队规则适用于 service/billing/refund.go`));
  assert.deepEqual(
    attached(first).map((r: { ref: string; content: string }) => [r.ref, r.content]),
    [
      ["R1", "金额用最小单位的正文"],
      ["R2", "Go 错误包装的正文"],
    ],
  );
  assert.equal(book.forFile("service/billing/charge.go"), undefined);
  assert.equal(book.forFile("relay/openai.go"), undefined);
  assert.deepEqual(
    attached(book.forFile("web/src/App.tsx")).map((r: { ref: string }) => r.ref),
    ["R3"],
  );
  const delivered = book.snapshot().map((r) => [r.ref, r.delivered]);
  assert.deepEqual(delivered, [
    ["R1", { via: "read", path: "service/billing/refund.go" }],
    ["R2", { via: "read", path: "service/billing/refund.go" }],
    ["R3", { via: "read", path: "web/src/App.tsx" }],
  ]);
});

test("例外命中时一并附上尚未给出的原规则", () => {
  const original = rule("迁移只走显式入口", { paths: ["model/**"] });
  const exception = rule(
    "迁移工具可执行 DDL",
    { paths: ["cmd/db-migrate/**"] },
    {
      type: "exception",
      exception_to: original.id,
    },
  );
  const book = createRuleBook([original, exception]);
  const rules = attached(book.forFile("cmd/db-migrate/main.go"));
  assert.deepEqual(
    rules.map((r: { ref: string; exceptionTo?: string }) => [r.ref, r.exceptionTo]),
    [
      ["R2", "R1"],
      ["R1", undefined],
    ],
  );
  assert.equal(book.forFile("model/user.go"), undefined);
});

test("新建文件命中未给出的规则时补发一次，之后不再算遗漏；新的遗漏仍能查出", () => {
  const billing = rule("金额用最小单位", { paths: ["service/billing/**"] }),
    csv = rule("CSV 防公式注入", { paths: ["pkg/tasklogcsv/**"] }),
    docs = rule("文档带日期", { paths: ["docs/**"] });
  const book = createRuleBook([billing, csv, docs]);
  book.forFile("service/billing/refund.go");
  const paths = ["service/billing/refund.go", "pkg/tasklogcsv/refund_export.go"];
  assert.deepEqual(book.missing(paths), ["R2 CSV 防公式注入"]);
  const message = book.followUp(paths);
  assert.ok(message?.startsWith(`${book.prompt().teamRuleMarker}：你的改动涉及以下尚未提供的团队规则`));
  assert.deepEqual(
    attached(message).map((r: { ref: string }) => r.ref),
    ["R2"],
  );
  assert.equal(book.followUp(paths), undefined);
  assert.deepEqual(book.missing(paths), []);
  assert.deepEqual(book.missing([...paths, "docs/guide.md"]), ["R3 文档带日期"]);
  assert.deepEqual(book.snapshot()[1].delivered, { via: "follow_up", path: "pkg/tasklogcsv/refund_export.go" });
  assert.equal(book.snapshot()[2].delivered, null);
  assert.ok(book.forFile("docs/guide.md", "write"));
  assert.deepEqual(book.snapshot()[2].delivered, { via: "write", path: "docs/guide.md" });
});

test("每个任务的规则标记不同", () => {
  const rows = [rule("全局", {})];
  assert.notEqual(createRuleBook(rows).prompt().teamRuleMarker, createRuleBook(rows).prompt().teamRuleMarker);
});
