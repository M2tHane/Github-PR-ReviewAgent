import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanChangedFiles, uncoveredRuleFindings, type RuleHit } from "../../src/review/rule-check.js";
import { createReviewProcessor } from "../../src/review/review.processor.js";
import type { PublicationStore } from "../../src/review/review.publisher.js";
import { validateDisplay } from "../../src/review/presentation.js";
import { emptyUsage } from "../../src/review/agent.js";
import type { GitHubClient } from "../../src/github/client.js";
import type { Config } from "../../src/config/config.js";
import type { Finding } from "../../src/review/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const exec = promisify(execFile);
const semgrep = process.env.SEMGREP_PATH ?? resolve("work/semgrep-venv/bin/semgrep");
const noSemgrep = !existsSync(semgrep) && "未安装 Semgrep（设置 SEMGREP_PATH 或安装到 work/semgrep-venv）";
const hit = (line: number, severity: RuleHit["severity"] = "high"): RuleHit => ({
  rule: "sql-string-concat",
  label: "SQL 拼接",
  severity,
  path: "src/db.ts",
  line,
  message: "SQL 语句由字符串拼接生成，外部输入可能改变查询语义（SQL 注入）。改用参数化查询。",
});

test("模型已在命中位置写了安全意见就不补；没写或只写了别的类别时补一条需人工确认的意见", () => {
  const finding = (category: Finding["category"], line: number): Finding => ({
    category,
    severity: "high",
    evidenceLevel: "strong",
    path: "src/db.ts",
    line,
    side: "RIGHT",
    description: "d",
    evidence: "e",
    impact: "i",
  });
  const added = uncoveredRuleFindings(
    [hit(4), hit(8), hit(20, "low")],
    [finding("security", 5), finding("team_rule", 8)],
    [],
  );
  assert.deepEqual(
    added.map((item) => [item.line, item.severity, item.evidenceLevel]),
    [[8, "medium", "weak"]],
  );
  assert.match(added[0]!.display!.title, /需人工确认/);
  validateDisplay(added[0]!.display);
});

test("PR 规则扫描只保留新增行上的命中", { skip: noSemgrep }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-rules-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/db.ts"),
      'export const a = (db: any, id: string) => db.query("SELECT 1 WHERE id = " + id);\nexport const b = (db: any, id: string) => db.query("SELECT 2 WHERE id = " + id);\n',
    );
    const result = await scanChangedFiles(
      root,
      [
        {
          filename: "src/db.ts",
          status: "modified",
          patch: "@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;",
        },
      ],
      semgrep,
      AbortSignal.timeout(120_000),
    );
    assert.deepEqual(
      result.hits.map((item) => `${item.path}:${item.line}:${item.rule}`),
      ["src/db.ts:2:sql-string-concat"],
    );
    const none = await scanChangedFiles(
      root,
      [{ filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n+x" }],
      semgrep,
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(none, { hits: [], limitations: [] }, "没有改源码时不运行 Semgrep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PR 审查把规则命中交给模型；模型漏掉的高风险命中由服务端补上", { skip: noSemgrep }, async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-pr-rules-e2e-"));
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
  try {
    await git("init", "-q");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.invalid");
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src/db.ts"), "export {};\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const baseSha = await git("rev-parse", "HEAD");
    await writeFile(
      join(source, "src/db.ts"),
      'export {};\nexport const find = (db: any, id: string) => db.query("SELECT * FROM t WHERE id = " + id);\n',
    );
    await git("commit", "-qam", "head");
    const headSha = await git("rev-parse", "HEAD");
    const job = {
      id: "job-rules",
      deliveryId: "d-rules",
      repositoryId: 1,
      installationId: 1,
      repository: "owner/test",
      prNumber: 5,
      cloneUrl: source,
      baseSha,
      headSha,
      title: "",
      body: "",
      status: "running",
    } satisfies ReviewJob;
    let posted = "",
      seenHits: unknown;
    const github = {
      installationToken: async () => "t",
      getPullRequest: async () => ({ state: "open", draft: false, base: { sha: baseSha }, head: { sha: headSha } }),
      getFiles: async () => [
        {
          filename: "src/db.ts",
          status: "modified",
          patch: '@@ -1 +1,2 @@\n export {};\n+export const find = (db: any, id: string) => db.query("x" + id);',
        },
      ],
      isPrivateRepository: async () => true,
      createReview: async (_t: string, _j: ReviewJob, body: string) => {
        posted = body;
        return { id: 8, html_url: "u" };
      },
      getReviewCommentsForReview: async () => [],
    } as unknown as GitHubClient;
    const store = {
      beginPublication: async () => ({ status: "pending", inserted: true }),
      finishPublication: async () => {},
    };
    await createReviewProcessor(
      {
        appId: "1",
        privateKey: "",
        allowedRepositories: new Set(["owner/test"]),
        agentTimeoutMs: 120_000,
        modelName: "test",
        sastScan: true,
        semgrepPath: semgrep,
      } as Config,
      github,
      store as unknown as PublicationStore,
      undefined,
      async (input) => {
        seenHits = input.ruleHits;
        return {
          result: { summary: "", findings: [], coverage: [], limitations: [] },
          model: "test",
          durationMs: 1,
          usage: emptyUsage(),
        };
      },
    )({ ...job });
    assert.deepEqual(
      (seenHits as RuleHit[]).map((item) => `${item.path}:${item.line}:${item.label}`),
      ["src/db.ts:2:SQL 拼接"],
    );
    assert.match(posted, /疑似SQL 拼接，需人工确认/);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
