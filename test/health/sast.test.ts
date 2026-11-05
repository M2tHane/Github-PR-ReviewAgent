import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSemgrep } from "../../src/health/sast.js";
import { parseHealthResult } from "../../src/health/health.service.js";
import type { HealthJob } from "../../src/jobs/types.js";

const exec = promisify(execFile);
const scope = { includePaths: [], excludePaths: [], outputLanguage: "zh-CN", budgetTokens: 1 };
const semgrep = process.env.SEMGREP_PATH ?? resolve("work/semgrep-venv/bin/semgrep");

test("Semgrep 用本地规则发现 SQL 拼接和命令注入；不安装依赖、不运行仓库脚本、不读仓库里的规则", {
  skip: !existsSync(semgrep) && "未安装 Semgrep（设置 SEMGREP_PATH 或安装到 work/semgrep-venv）",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sast-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/app.ts"),
      [
        'import { exec, execFile } from "node:child_process";',
        "export function route(req: any, db: any) {",
        '  db.query("SELECT * FROM users WHERE id = " + req.query.id);',
        '  db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);',
        "  exec(`git log ${req.query.ref}`);",
        '  execFile("git", ["log", req.query.ref]);',
        "}",
      ].join("\n"),
    );
    await writeFile(join(root, "--config=evil.js"), "eval(process.argv[2]);\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { postinstall: "touch pwned", prepare: "touch pwned" } }),
    );
    await writeFile(
      join(root, ".semgrep.yml"),
      "rules:\n  - id: repo-rule\n    languages: [typescript]\n    severity: ERROR\n    message: repo\n    pattern: $X\n",
    );
    await exec("git", ["-C", root, "init", "-q"]);
    await exec("git", ["-C", root, "add", "."]);
    const { scan, missingData } = await runSemgrep(root, scope, semgrep, AbortSignal.timeout(120_000));
    assert.deepEqual(missingData, []);
    assert.equal(scan.status, "complete");
    assert.deepEqual(
      scan.records.map((record) => `${record.path}:${record.line}:${record.rule}`),
      ["--config=evil.js:1:code-injection", "src/app.ts:3:sql-string-concat", "src/app.ts:5:command-injection"],
    );
    assert.equal(scan.records[1]!.label, "SQL 拼接");
    assert.equal(scan.records[1]!.severity, "high");
    assert.ok(!scan.records.some((record) => record.rule === "repo-rule"), "不使用仓库里的 Semgrep 规则");
    await assert.rejects(access(join(root, "pwned")), "没有运行仓库脚本");
    await assert.rejects(access(join(root, "node_modules")), "没有安装依赖");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("没装 Semgrep 时写进缺失数据，任务照常完成", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sast-missing-"));
  try {
    await writeFile(join(root, "a.py"), "print(1)\n");
    await exec("git", ["-C", root, "init", "-q"]);
    await exec("git", ["-C", root, "add", "."]);
    const result = await runSemgrep(root, scope, join(root, "no-such-semgrep"), AbortSignal.timeout(5000));
    assert.equal(result.scan.status, "incomplete");
    assert.deepEqual(
      result.missingData.map((item) => [item.source, item.reason]),
      [["sast", "not_installed"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模型只能引用服务端提供的规则扫描记录", () => {
  const record = {
    id: "sast_1",
    rule: "sql-string-concat",
    label: "SQL 拼接",
    severity: "high" as const,
    path: "src/app.ts",
    line: 3,
    message: "m",
  };
  const raw = (id: string) =>
    JSON.stringify({
      summary: "s",
      findings: [
        {
          dimension: "security",
          severity: "high",
          evidenceLevel: "strong",
          description: "查询参数直接拼进 SQL",
          impact: "可读取任意用户数据",
          suggestion: "改用参数化查询",
          references: [
            { kind: "sast", id, detail: "规则命中" },
            { kind: "code", path: "src/app.ts", line: 3, detail: "拼接位置" },
          ],
        },
      ],
      limitations: [],
    });
  const binding = {
    job: { id: "j", repositoryId: 1 } as HealthJob,
    files: new Map([["src/app.ts", "a\nb\nc"]]),
    readLines: new Map([["src/app.ts", new Set([3])]]),
    sources: [],
    memories: [],
    sast: [record],
  };
  assert.equal(parseHealthResult(raw("sast_1"), binding).findings[0]!.references[0]!.kind, "sast");
  assert.throws(() => parseHealthResult(raw("sast_forged"), binding), /未提供的来源/);
});
