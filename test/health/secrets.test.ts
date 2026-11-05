import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectSecrets, redactSecrets, scanSecrets } from "../../src/health/secrets.js";
import { parseHealthResult, scopedPaths } from "../../src/health/health.service.js";
import { checkAddedSecrets, redactFinding } from "../../src/review/secret-check.js";
import type { HealthJob } from "../../src/jobs/types.js";
import type { Finding } from "../../src/review/types.js";

const exec = promisify(execFile);
// 拼出来的假 Token，避免仓库里出现完整的密钥格式字符串。
export const FAKE_GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36);
const FAKE_KEY = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEAxyz", "-----END RSA PRIVATE KEY-----"].join("\n");

test("密钥扫描只记位置和类型；占位符和普通标识符不算", () => {
  const content = [
    `const token = "${FAKE_GITHUB_TOKEN}";`,
    'const password = "replace-me-with-a-real-password";',
    "const maxTokens = 12;",
    'api_key: "f8a9c2e7b1d34a6f9e0c5b8a7d2e1f43"',
    FAKE_KEY,
    `const aws = "AKIA${"Q".repeat(16)}";`,
  ].join("\n");
  const records = scanSecrets("src/config.ts", content);
  assert.deepEqual(
    records.map((record) => [record.rule, record.line]),
    [
      ["github-token", 1],
      ["generic-secret", 4],
      ["private-key", 5],
      ["aws-access-key", 8],
    ],
  );
  assert.doesNotMatch(JSON.stringify(records), /a1B2c3|f8a9c2|MIIEow|QQQQ/);
  const redacted = redactSecrets(content);
  assert.equal(redacted.split("\n").length, content.split("\n").length, "打码不改变行号");
  assert.doesNotMatch(redacted, /a1B2c3|f8a9c2|MIIEow/);
  assert.match(redacted, /\[已隐藏的GitHub Token\]/);
  assert.match(redacted, /replace-me-with-a-real-password/);
});

test("全仓扫描：遵守范围排除，超大文件写进缺失数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-secrets-"));
  try {
    await exec("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, "a.ts"), `x\nconst t = "${FAKE_GITHUB_TOKEN}";\n`);
    await writeFile(join(root, "big.txt"), "x".repeat(1_100_000));
    await writeFile(join(root, "vendor.ts"), `const t = "${FAKE_GITHUB_TOKEN}";\n`);
    await exec("git", ["-C", root, "add", "."]);
    const signal = AbortSignal.timeout(5000);
    const { paths } = await scopedPaths(
      root,
      { includePaths: [], excludePaths: ["vendor.ts"], outputLanguage: "zh-CN", budgetTokens: 1 },
      signal,
    );
    // 已读过的文件直接复用原文：这里给 a.ts 一份不同的内容，证明没有再读磁盘。
    const result = await collectSecrets(
      root,
      paths,
      signal,
      new Map([["a.ts", `const t = "${FAKE_GITHUB_TOKEN}";\n`]]),
    );
    assert.deepEqual(
      result.records.map((record) => `${record.path}:${record.line}:${record.label}`),
      ["a.ts:1:GitHub Token"],
    );
    assert.equal(result.missingData[0]?.reason, "scan_limit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模型只能引用服务端扫描出的密钥记录", () => {
  const record = { id: "secret_1", rule: "github-token", label: "GitHub Token", path: "a.ts", line: 2 };
  const raw = (id: string) =>
    JSON.stringify({
      summary: "s",
      findings: [
        {
          dimension: "security",
          severity: "critical",
          evidenceLevel: "strong",
          description: "a.ts 里提交了 GitHub Token",
          impact: "仓库读者可以冒用",
          suggestion: "作废并更换",
          references: [{ kind: "secret", id, detail: "扫描记录" }],
        },
      ],
      limitations: [],
    });
  const binding = {
    job: { id: "j", repositoryId: 1 } as HealthJob,
    files: new Map(),
    readLines: new Map(),
    sources: [],
    memories: [],
    secrets: [record],
  };
  assert.equal(parseHealthResult(raw("secret_1"), binding).findings[0]!.references[0]!.kind, "secret");
  assert.throws(() => parseHealthResult(raw("secret_forged"), binding), /未提供的来源/);
});

test("PR 只对新增行里的疑似密钥发提醒，模型意见里的密钥会被打码", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pr-secrets-"));
  try {
    await writeFile(join(root, "a.ts"), `const old = "${FAKE_GITHUB_TOKEN}";\nconst added = "${FAKE_GITHUB_TOKEN}";\n`);
    await writeFile(join(root, "big.ts"), "x".repeat(1_100_000));
    const { findings, limitations } = await checkAddedSecrets(
      root,
      [
        { filename: "a.ts", status: "modified", patch: `@@ -1 +1,2 @@\n const old = "x";\n+const added = "y";` },
        { filename: "big.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x" },
        { filename: "gone.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+x" },
      ],
      [],
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(limitations, ["2 个改动文件过大或无法读取，没有检查新增密钥：big.ts、gone.ts。"]);
    assert.deepEqual(
      findings.map((finding) => [finding.path, finding.line, finding.severity]),
      [["a.ts", 2, "critical"]],
    );
    assert.doesNotMatch(JSON.stringify(findings), /a1B2c3/);
    const leaked: Finding = {
      category: "security",
      severity: "high",
      evidenceLevel: "strong",
      description: `日志打印了 ${FAKE_GITHUB_TOKEN}`,
      evidence: FAKE_GITHUB_TOKEN,
      impact: "i",
      display: { title: "t", reason: `r ${FAKE_GITHUB_TOKEN}`, fix: "f" },
    };
    redactFinding(leaked);
    assert.doesNotMatch(JSON.stringify(leaked), /a1B2c3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
