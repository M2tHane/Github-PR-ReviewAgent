// 固定的订单样本；只分析代码，不执行样本脚本或发布 GitHub 评论。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Database } from "../dist/src/persistence/database.js";
import { MemoryService } from "../dist/src/memory/memory.service.js";
import { readBaseFile, withWorkspace } from "../dist/src/workspace/workspace.js";
import { runAgentReview } from "../dist/src/review/agent.js";
import { validateMemoryReferences } from "../dist/src/review/review.processor.js";
import { diffLines, normalizeFindingLocation } from "../dist/src/review/finding.js";
import { inlineBody, reviewBody, validateDisplay } from "../dist/src/review/presentation.js";

const exec = promisify(execFile),
  repository = "M2tHane/pi-review-test-repository",
  repositoryId = 1364052429;
const config = {
  modelProvider: process.env.MODEL_PROVIDER,
  modelName: process.env.MODEL_NAME,
  modelApiKey: process.env.MODEL_API_KEY,
  modelEndpoint: {
    baseUrl: process.env.MODEL_BASE_URL,
    api: process.env.MODEL_API ?? "openai-completions",
    thinkingLevel: process.env.MODEL_THINKING,
  },
  agentTimeoutMs: 3_600_000,
};
for (const key of ["MODEL_PROVIDER", "MODEL_NAME", "MODEL_API_KEY", "DATABASE_URL"])
  assert(process.env[key], `缺少 ${key}`);
const cases = [
  {
    name: "orders-single",
    prNumber: 8,
    clone: resolve("work/e2e-order-api"),
    base: "3e02a7c59b073547da3c466987d4d8570df31484",
    head: "0ebd1cc3ca2ac1e4b42bfe2cee9a66a89e8b2713",
  },
  {
    name: "rule-reference",
    prNumber: 9,
    clone: resolve("work/e2e-order-followup"),
    base: "f8d7f03ce2ec5c761b3416fd11992d259b96043b",
    head: "69e69bdf16dd59a6235307deb213e91a13477a08",
  },
];
// 新能力变体仅显式指定时运行，默认仍是原有两个 case。
const reference = cases.find((sample) => sample.name === "rule-reference");
cases.push(
  { ...reference, name: "rule-reference-must", variant: "must" },
  { ...reference, name: "rule-reference-index", variant: "index" },
);
const selected = cases.filter((sample) => (process.argv[2] ? sample.name === process.argv[2] : !sample.variant));
const report = {
  createdAt: new Date().toISOString(),
  repository,
  budgetTokens: 160_000,
  runtime: "pi-single-agent",
  note: "固定 SHA 的本地真实模型验证（单 Agent + Skills）。没有 Webhook 或 GitHub 发布。",
  cases: [],
};
const rule = JSON.parse(await readFile(new URL("./ux/rule-reference.json", import.meta.url), "utf8"));
const control = new Database(process.env.DATABASE_URL),
  schema = "ux_eval_" + randomUUID().replaceAll("-", ""),
  isolatedUrl = new URL(process.env.DATABASE_URL);
await control.pool.query(`CREATE SCHEMA "${schema}"`);
isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
const database = new Database(isolatedUrl.toString()),
  memories = new MemoryService(database);
await mkdir("work", { recursive: true });
try {
  await database.migrate();
  const seed = (item, fingerprint) =>
    database.pool.query(
      `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,status,source_fingerprint,level)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        item.id,
        item.version,
        repositoryId,
        160592861,
        item.type,
        item.title,
        item.content,
        item.rationale,
        item.scope,
        item.source,
        JSON.stringify(item.evidence),
        item.status,
        fingerprint,
        item.level,
      ],
    );
  await seed(
    { ...rule, level: process.argv[2] === "rule-reference-must" ? "must" : rule.level },
    "ux-reconstructed-rule-v2",
  );
  if (process.argv[2] === "rule-reference-index") {
    // 与订单无关、但匹配 backend 范围的合成构建约定。通用 Java 术语参与现有排序，
    // 足量正文挤占 30,000 字符预算；不修改生产排序、目标规则或预算。
    for (let index = 0; index < 40; index++) {
      await seed(
        {
          ...rule,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          version: 1,
          title: `构建诊断元数据规范 ${index + 1}`,
          content:
            `This convention applies only to Java build diagnostics and generated artifact metadata. A diagnostic record includes package, public class, private field, static final String label, import list, new file location and return type. It describes compiler output, not application data. ` +
            `Build diagnostic producers keep each generated file attributable to its compiler invocation. Metadata lists the source package and class, compiler options and artifact checksum. A diagnostic renderer must treat a null message as absent, preserve the original tool exit code and write labels as plain text. This rule applies when editing the build diagnostic producer or renderer. Application queries and domain collections do not implement build diagnostic metadata. `.repeat(
              2,
            ),
          rationale: "保证构建诊断可追溯到编译步骤；只适用于编译工具元数据。",
          scope: { paths: ["backend/**"] },
          source: { evaluation: "synthetic-build-diagnostics" },
          evidence: [],
        },
        `ux-index-filler-${index}`,
      );
    }
  }
  for (const sample of selected) {
    const entry = { name: sample.name, baseSha: sample.base, headSha: sample.head };
    report.cases.push(entry);
    try {
      await withWorkspace(sample.clone, "", sample.base, sample.head, async (root) => {
        const git = async (...args) =>
          (await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
        const files = await Promise.all(
          (await git("diff", "--name-only", sample.base, sample.head)).split("\n").map(async (filename) => ({
            filename,
            status: "modified",
            patch: await git("diff", "--no-ext-diff", "--no-textconv", sample.base, sample.head, "--", filename),
          })),
        );
        const contextInput = {
          paths: files.map((file) => file.filename),
          text: files.map((file) => file.patch).join(" "),
        };
        const selection =
          sample.prNumber === 8 ? { full: [], index: [] } : await memories.context(repositoryId, contextInput);
        const recalled = selection.full;
        const provided = new Map(recalled.map((memory) => [memory.id, memory]));
        entry.memoryReferences = recalled.map(({ id, version }) => ({ id, version }));
        entry.ruleIndex = selection.index;
        entry.readRules = [];
        entry.repairPrompts = [];
        if (sample.variant === "index") {
          assert(
            selection.index.some((item) => item.id === rule.id),
            "目标规则必须被挤进索引",
          );
          assert(!recalled.some((item) => item.id === rule.id), "目标规则不能预先提供全文");
          assert(!recalled.some((item) => item.level === "must"), "索引变体独立验证，不带 must");
        }
        const job = {
          id: randomUUID(),
          deliveryId: "local-ux-evaluation",
          jobType: "PR_REVIEW",
          repository,
          repositoryId,
          installationId: 160592861,
          prNumber: sample.prNumber,
          title: sample.prNumber === 8 ? "订单查询和排序导出" : "新增归档订单只读查询",
          body: "",
          baseSha: sample.base,
          headSha: sample.head,
          status: "running",
          cloneUrl: sample.clone,
        };
        entry.jobId = job.id;
        const run = await runAgentReview({
          root,
          provider: config.modelProvider,
          modelName: config.modelName,
          apiKey: config.modelApiKey,
          endpoint: config.modelEndpoint,
          timeoutMs: config.agentTimeoutMs,
          budgetTokens: report.budgetTokens,
          title: job.title,
          body: job.body,
          baseSha: sample.base,
          headSha: sample.head,
          changedFiles: files,
          memories: recalled,
          teamRuleIndex: selection.index,
          readTeamRule: async (id) => {
            const { full } = await memories.context(repositoryId, contextInput, Number.MAX_SAFE_INTEGER);
            const memory = full.find((item) => item.id === id);
            if (memory) {
              provided.set(id, memory);
              entry.readRules.push({ id: memory.id, version: memory.version });
            }
            return memory;
          },
          onSession: (session) => {
            const messages = session.content
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .filter((item) => item.type === "message")
              .map((item) => item.message);
            const text = (message) =>
              typeof message.content === "string"
                ? message.content
                : (message.content ?? [])
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n");
            entry.repairPrompts = messages
              .filter((message) => message.role === "user")
              .map(text)
              .filter((value) => value.startsWith("上一条输出没有通过服务校验"));
            entry.ruleToolCalls = messages
              .filter((message) => message.role === "assistant")
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
              .filter((block) => block.type === "toolCall" && block.name === "read_team_rule")
              .map(({ name, arguments: args }) => ({ name, arguments: args }));
          },
          repositoryInstructions: await readBaseFile(root, sample.base, "AGENTS.md"),
        });
        Object.assign(entry, run);
        validateMemoryReferences(run.result, [...provided.values()], repositoryId);
        const allowed = new Set(files.map((file) => file.filename)),
          lines = diffLines(files);
        for (const finding of run.result.findings) {
          validateDisplay(finding.display);
          for (const location of [finding, ...(finding.relatedLocations ?? []), ...(finding.candidates ?? [])]) {
            assert(!location.path || allowed.has(location.path));
            normalizeFindingLocation(location, lines);
          }
        }
        entry.reviewBody = reviewBody(job, run.result);
        entry.inlineBodies = run.result.findings.map((finding, index) =>
          inlineBody(job, { ...finding, id: `local-${index}` }),
        );
        if (sample.prNumber === 8) {
          assert.equal(run.result.findings.length, 1, "订单根因链应聚合成一个问题");
          const finding = run.result.findings[0];
          assert(
            [finding, ...(finding.relatedLocations ?? [])].some((item) => item.path?.endsWith("OrderExport.java")),
          );
          assert(
            [finding, ...(finding.relatedLocations ?? [])].some((item) => item.path?.endsWith("OrderCatalog.java")),
          );
          assert(finding.candidates?.length >= 2, "保留查询和导出的原始意见");
        } else {
          assert(
            run.result.findings.some(
              (finding) =>
                finding.memory?.id === "567f00c2-b758-4b2a-857b-ceb62d33e9a6" && finding.memory.version === 2,
            ),
            "规则意见必须绑定实际提供的规则版本",
          );
        }
        if (sample.variant === "must") {
          assert.deepEqual(run.result.uncheckedMustRules, []);
          assert.equal(run.result.ruleChecks.length, 1);
          assert.equal(run.result.ruleChecks[0].id, rule.id);
          assert.equal(run.result.ruleChecks[0].version, rule.version);
          assert.equal(run.result.ruleChecks[0].result, "violated");
        }
        if (sample.variant === "index") {
          assert(
            entry.ruleToolCalls.some((call) => call.arguments.id === rule.id),
            "模型必须调用工具读取目标规则",
          );
          assert(entry.readRules.some((item) => item.id === rule.id && item.version === rule.version));
        }
        entry.passed = true;
      });
    } catch (error) {
      entry.passed = false;
      entry.error = error.message;
      entry.usage ??= error.usage;
    }
    await writeFile(
      process.argv[2] ? `work/ux-model-${process.argv[2]}.json` : "work/ux-model-evaluation.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        sample: entry.name,
        passed: entry.passed,
        error: entry.error,
        jobId: entry.jobId,
        durationMs: entry.durationMs,
        usage: entry.usage,
        findings: entry.result?.findings.length,
      }),
    );
  }
} finally {
  await database.close();
  try {
    await control.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await control.close();
  }
}
process.exitCode = report.cases.every((entry) => entry.passed) ? 0 : 1;
