import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SYSTEM_PROMPT, parseDecisionProposals } from "../dist/src/memory/decision.processor.js";
import { runAgentSession, emptyUsage, addUsage } from "../dist/src/review/agent.js";
import { redactSecrets } from "../dist/src/health/secrets.js";
import { extractionScore, ratio } from "./metrics.mjs";
import { loadCases, metadata, option, positiveInteger, saveReport } from "./support.mjs";

for (const name of ["MODEL_PROVIDER", "MODEL_NAME", "MODEL_API_KEY"])
  if (!process.env[name]) throw new Error(`缺少 ${name}，提取评测必须使用真实模型`);
const runs = positiveInteger("runs", 1);
const timeoutMs = positiveInteger("timeout-ms", 180_000);
const budgetTokens = positiveInteger("budget-tokens", 160_000);
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const cases = await loadCases(new URL("./extraction/cases/", import.meta.url), requested);
const exec = promisify(execFile);
const workspaceParent = resolve("work/extraction-workspaces");
await mkdir(workspaceParent, { recursive: true });
const output = option("output", "work/extraction-evaluation.json");
const report = {
  ...metadata(cases),
  provider: process.env.MODEL_PROVIDER,
  model: process.env.MODEL_NAME,
  api: process.env.MODEL_API ?? "openai-completions",
  thinking: process.env.MODEL_THINKING,
  systemPromptSha256: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
  runs,
  timeoutMs,
  budgetTokens,
  note: "6 个合成样例的提取器评测；不是 30 个真实合并 PR 的阶段验收，不写数据库或 GitHub。所有样例都调用模型，包括生产会提前跳过的无人类讨论样例。",
  cases: [],
};

function summarize() {
  const results = report.cases.flatMap((entry) => entry.runs);
  const sum = (field) => results.reduce((total, run) => total + run.score[field], 0);
  const usage = emptyUsage();
  for (const run of results) if (run.usage) addUsage(usage, run.usage);
  return {
    runs: results.length,
    errors: results.filter((run) => run.error).length,
    exactRuns: results.filter((run) => !run.error && run.score.exact).length,
    tp: sum("tp"),
    fp: sum("fp"),
    fn: sum("fn"),
    precision: ratio(sum("tp"), sum("tp") + sum("fp")),
    recall: ratio(sum("tp"), sum("tp") + sum("fn")),
    discarded: results.reduce((total, run) => total + (run.discarded?.length ?? 0), 0),
    durationMs: results.reduce((total, run) => total + run.durationMs, 0),
    usage,
    usageMissingRuns: results.filter((run) => !run.usage).length,
  };
}

for (const sample of cases) {
  const root = await mkdtemp(`${workspaceParent}/snapshot-`);
  const git = async (...args) =>
    (
      await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
      })
    ).stdout.trim();
  try {
    for (const file of sample.changedFiles) {
      const target = resolve(root, file.filename);
      const rel = relative(root, target);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
        throw new Error(`样例文件越出临时工作区：${file.filename}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await git("init", "-q", "--initial-branch=main");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Eval",
      "-c",
      "user.email=eval@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-qm",
      "Merged fixture snapshot",
    );
    const mergedSnapshot = await git("rev-parse", "HEAD");
    const entry = { id: sample.id, mergedSnapshot, expected: sample.expected, runs: [] };
    report.cases.push(entry);
    // 显式挑选生产输入字段；expected、description 和 fixture content 不发给模型。
    const prompt = {
      task: "从已合并 PR 提取可复用工程决定。decisionClues 仅是待核实索引，不能替代人类评论与最终代码双证据",
      repository: "eval/synthetic-extraction",
      pullRequestNumber: sample.pullRequestNumber,
      mergedSnapshot,
      title: sample.title,
      body: sample.body,
      changedFiles: sample.changedFiles.map(({ filename, status, patch }) => ({ filename, status, patch })),
      discussions: sample.discussions,
      decisionClues: [],
      existingRules: sample.existingRules,
    };
    for (let attempt = 1; attempt <= runs; attempt++) {
      console.log(JSON.stringify({ started: sample.id, attempt }));
      const started = Date.now();
      let modelRun;
      let result;
      try {
        modelRun = await runAgentSession({
          root,
          provider: report.provider,
          modelName: report.model,
          apiKey: process.env.MODEL_API_KEY,
          endpoint: { baseUrl: process.env.MODEL_BASE_URL, api: report.api, thinkingLevel: report.thinking },
          timeoutMs,
          budgetTokens,
          systemPrompt: SYSTEM_PROMPT,
          prompt,
        });
        const parsed = parseDecisionProposals(
          modelRun.text,
          { prNumber: sample.pullRequestNumber, headSha: mergedSnapshot },
          new Set(sample.existingRules.map((rule) => rule.id)),
          new Set(sample.discussions.filter((entry) => entry.human).map((entry) => entry.id)),
          new Set(sample.changedFiles.map((file) => file.filename)),
        );
        result = { attempt, ...modelRun, ...parsed, score: extractionScore(parsed.proposals, sample.expected) };
      } catch (error) {
        // Provider/超时/解析失败也保存为失败运行，不把负样例的异常计成正确的空结果。
        result = {
          attempt,
          model: modelRun?.model ?? error.model,
          durationMs: modelRun?.durationMs ?? error.durationMs ?? Date.now() - started,
          usage: modelRun?.usage ?? error.usage,
          error: redactSecrets(error.message),
          text: modelRun?.text,
          score: { ...extractionScore([], sample.expected), exact: false },
        };
        process.exitCode = 1;
      }
      entry.runs.push(result);
      report.summary = summarize();
      await saveReport(output, report);
      const { text, proposals, discarded, ...summary } = result;
      console.log(
        JSON.stringify({ id: sample.id, ...summary, candidates: proposals?.length, discarded: discarded?.length }),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ summary: report.summary, output: resolve(output) }));
