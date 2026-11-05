import assert from "node:assert/strict";
import test from "node:test";
import { touchesSecurity } from "../../src/review/orchestration.js";
import { matchWords, rankMemories, scopeMatches } from "../../src/memory/memory.service.js";
import { languageOf } from "../../src/config/languages.js";
import type { MemoryRecord } from "../../src/memory/types.js";

const patch = (...added: string[]) => "@@ -1 +1,2 @@\n-const removed = secret;\n" + added.map((line) => "+" + line).join("\n");

test("Security 专项只由路径和新增行里的敏感词触发", () => {
  assert.equal(touchesSecurity({ filename: "src/review/agent.ts", patch: patch("const maxTokens = budgetTokens - usage.totalTokens;") }), false);
  assert.equal(touchesSecurity({ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-const password = x;\n+const value = x;" }), false, "删除行不算");
  assert.equal(touchesSecurity({ filename: "src/a.ts", patch: patch("const keyboard = tokenizer.next();") }), false);
  for (const line of ["const token = getAccessToken();", "headers.Authorization = `Bearer ${bearerToken}`;", "if (user.password === input) {}", "const API_KEY = env.API_KEY;", "const privateKey = load();", "jwt.verify(raw)"]) {
    assert.equal(touchesSecurity({ filename: "src/a.ts", patch: patch(line) }), true, line);
  }
  assert.equal(touchesSecurity({ filename: "backend/auth/Session.java" }), true);
  assert.equal(touchesSecurity({ filename: "backend/api/AuthController.java" }), true);
  assert.equal(touchesSecurity({ filename: "backend/api/AuthorController.java" }), false);
});

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
  const csv = { ...base, id: "csv", title: "CSV export safety", content: "Escape exported cells that start with =", scope: {} } as unknown as MemoryRecord;
  const port = { ...base, id: "port", title: "Port numbers", content: "Never hardcode a port", scope: {} } as unknown as MemoryRecord;
  const dto = { ...base, id: "dto", title: "DTO fields", content: "No Optional fields", scope: { paths: ["backend/**/dto/**"] } } as unknown as MemoryRecord;
  const zh = { ...base, id: "zh", title: "金额计算", content: "金额必须使用定点小数", scope: {} } as unknown as MemoryRecord;
  const ids = (text: string, paths = ["backend/report/Report.java"]) => rankMemories([csv, port, dto, zh], { paths, text }).map((memory) => memory.id);

  assert.deepEqual(ids("+ String report = exportCsv(rows); // csv export"), ["csv"], "report 不再子串命中 port");
  assert.deepEqual(ids("+ int value = 1;", ["backend/user/dto/UserDto.java"]), ["dto"], "命中路径的规则即使零分也召回");
  assert.deepEqual(ids("+ // 金额计算改为定点"), ["zh"], "中文按相邻两字匹配");
  assert.deepEqual(rankMemories([csv, port], { paths: [], text: "", minGlobalScore: 0 }).map((memory) => memory.id), ["csv", "port"]);
  assert(matchWords("getAccessToken").has("access") && matchWords("getAccessToken").has("getaccesstoken"));
});
