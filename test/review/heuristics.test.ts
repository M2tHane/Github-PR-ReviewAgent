import assert from "node:assert/strict";
import test from "node:test";
import { matchWords, rankMemories, scopeMatches } from "../../src/memory/memory.service.js";
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
