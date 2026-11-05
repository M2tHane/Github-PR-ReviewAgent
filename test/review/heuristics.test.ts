import assert from "node:assert/strict";
import test from "node:test";
import { touchesSecurity } from "../../src/review/orchestration.js";
import { scopeMatches } from "../../src/memory/memory.service.js";
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
