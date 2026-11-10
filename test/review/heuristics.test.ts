import assert from "node:assert/strict";
import test from "node:test";
import { matchWords, rankMemories, scopeMatches, selectReviewMemories } from "../../src/memory/memory.service.js";
import { languageOf } from "../../src/config/languages.js";
import type { MemoryRecord } from "../../src/memory/types.js";

test("语言识别与规则 Scope 共用一份映射，覆盖常见扩展名和写法", () => {
  assert.equal(languageOf("web/App.tsx"), "typescript");
  assert.equal(languageOf("svc/main.go"), "go");
  assert.equal(languageOf("README"), undefined);
  const rule = (languages: string[]) => ({ scope: { languages } }) as unknown as MemoryRecord;
  assert.equal(scopeMatches(rule(["TypeScript"]), ["web/App.tsx"], []), true);
  assert.equal(scopeMatches(rule(["kotlin"]), ["app/Main.kt"], []), true);
  assert.equal(scopeMatches(rule(["C#"]), ["src/Program.cs"], []), true);
  assert.equal(scopeMatches(rule(["java"]), ["app/Main.kt"], []), false);
});

test("规则召回按整词打分，全局规则要有足够重合，限定 Scope 的规则不受最低分限制", () => {
  const base = { status: "ACTIVE", rationale: "", repositoryId: 1, version: 1 };
  const csv = {
    ...base,
    id: "csv",
    title: "CSV export safety",
    content: "Escape exported cells that start with =",
    scope: {},
  } as unknown as MemoryRecord;
  const port = {
    ...base,
    id: "port",
    title: "Port numbers",
    content: "Never hardcode a port",
    scope: {},
  } as unknown as MemoryRecord;
  const dto = {
    ...base,
    id: "dto",
    title: "DTO fields",
    content: "No Optional fields",
    scope: { paths: ["backend/**/dto/**"] },
  } as unknown as MemoryRecord;
  const zh = {
    ...base,
    id: "zh",
    title: "金额计算",
    content: "金额必须使用定点小数",
    scope: {},
  } as unknown as MemoryRecord;
  const ids = (text: string, paths = ["backend/report/Report.java"]) =>
    rankMemories([csv, port, dto, zh], { paths, text }).map((memory) => memory.id);

  assert.deepEqual(ids("+ String report = exportCsv(rows); // csv export"), ["csv"], "report 不再子串命中 port");
  assert.deepEqual(ids("+ int value = 1;", ["backend/user/dto/UserDto.java"]), ["dto"], "命中路径的规则即使零分也召回");
  assert.deepEqual(ids("+ // 金额计算改为定点"), ["zh"], "中文按相邻两字匹配");
  assert.deepEqual(
    rankMemories([csv, port], { paths: [], text: "", minGlobalScore: 0 }).map((memory) => memory.id),
    ["csv", "port"],
  );
  assert(matchWords("getAccessToken").has("access") && matchWords("getAccessToken").has("getaccesstoken"));
});

test("Review 带上所有范围命中的规则：不截断、全局规则不要求最低分，例外带出原规则", () => {
  const rule = (id: string, scope: MemoryRecord["scope"], extra: Partial<MemoryRecord> = {}) =>
    ({
      id,
      version: 1,
      status: "ACTIVE",
      repositoryId: 1,
      title: `规则 ${id}`,
      content: "订单金额必须使用定点小数",
      rationale: "",
      scope,
      ...extra,
    }) as MemoryRecord;
  const scoped = Array.from({ length: 15 }, (_, index) =>
    rule(`s${String(index).padStart(2, "0")}`, { paths: ["src/**"] }),
  );
  const global = rule("g", {}, { title: "金额计算", content: "金额必须使用定点小数" });
  const elsewhere = rule("x", { paths: ["docs/**"] });
  const kotlin = rule("k", { languages: ["kotlin"] });
  const original = rule("o", { paths: ["legacy/**"] });
  const exception = rule("e", { paths: ["src/report/**"] }, { type: "exception", exceptionTo: "o" });
  const input = { paths: ["src/report/Export.java"], text: "+ String csv = export(rows);" };
  const { memories, total } = selectReviewMemories([...scoped, global, elsewhere, kotlin, original, exception], input);
  const ids = memories.map((memory) => memory.id);
  assert.equal(total, memories.length, "没超上限时全部带上");
  for (const memory of scoped) assert(ids.includes(memory.id), `${memory.id} 范围命中`);
  assert(ids.includes("g"), "和改动文本零重叠的中文全局规则也带上");
  assert(!ids.includes("x") && !ids.includes("k"), "范围不命中的不带");
  assert(ids.includes("e") && ids.includes("o"), "例外带出原规则");
  assert.equal(memories.length, 18);
});

test("Review 规则超过字符上限时，限定范围的在前、全局在后，各自按词重叠分数和 ID 截断", () => {
  const rule = (id: string, scope: MemoryRecord["scope"], content: string) =>
    ({ id, version: 1, status: "ACTIVE", repositoryId: 1, title: "", content, rationale: "", scope }) as MemoryRecord;
  const memories = [
    rule("global-hit", {}, "csv export cells"),
    rule("scoped-b", { paths: ["src/**"] }, "unrelated words here"),
    rule("scoped-a", { paths: ["src/**"] }, "unrelated words again"),
    rule("scoped-hit", { paths: ["src/**"] }, "csv export rows here"),
  ];
  const input = { paths: ["src/a.ts"], text: "+ csv export rows" };
  const ids = (maxChars: number) => {
    const selected = selectReviewMemories(memories, input, maxChars);
    return [selected.memories.map((memory) => memory.id), selected.total];
  };
  assert.deepEqual(ids(1_000), [["global-hit", "scoped-b", "scoped-a", "scoped-hit"], 4]);
  assert.deepEqual(ids(63), [["scoped-hit", "scoped-a", "scoped-b"], 4]);
  assert.deepEqual(ids(42), [["scoped-hit", "scoped-a"], 4]);
  assert.deepEqual(ids(10), [[], 4]);
});
