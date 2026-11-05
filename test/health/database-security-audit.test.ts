import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { createHealthProcessor } from "../../src/health/health.processor.js";
import { SECURITY_AUDIT_PROMPT } from "../../src/health/security-audit.js";
import { emptyUsage } from "../../src/review/agent.js";
import type { Config } from "../../src/config/config.js";
import type { HealthJob } from "../../src/jobs/types.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();

test("安全审查 Agent 给出入口到危险操作的完整链路记为 strong；引用没读过的行时结果被拒绝", {
  skip: !fixture.url,
}, async () => {
  const database = new Database(fixture.url!);
  await mkdir(resolve("work"), { recursive: true });
  const root = await mkdtemp(resolve("work/security-audit-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  try {
    git("init", "--quiet");
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/routes.ts"),
      [
        'import { db } from "./db";',
        "export function register(app: any) {",
        '  app.get("/api/orders/:id", async (req: any, res: any) => {',
        "    const order = await db.orders.findById(req.params.id);",
        "    res.json(order);",
        "  });",
        "}",
      ].join("\n") + "\n",
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "snapshot");
    const sha = git("rev-parse", "HEAD"),
      repositoryId = 9_000_000_031;
    await database.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name,budget_tokens) VALUES($1,1,'owner/security-audit',10000)",
      [repositoryId],
    );
    const config = {
      allowedRepositories: new Set(["owner/security-audit"]),
      modelProvider: "test",
      modelName: "model",
      modelApiKey: "test",
      agentTimeoutMs: 5000,
    } as Config;
    const github = {
      installationToken: async () => "test",
      repositorySnapshot: async () => ({ defaultBranch: "main", headSha: sha }),
      healthChecks: async () => ({ total_count: 0, check_runs: [] }),
      healthWorkflows: async () => ({ total_count: 0, workflow_runs: [] }),
    };
    let mode: "strong" | "weak" | "unread" = "strong";
    const seen: Array<{ role: string; budget: number; surface?: any }> = [];
    const execute = async (input: any) => {
      const security = input.systemPrompt === SECURITY_AUDIT_PROMPT;
      seen.push({
        role: security ? "security" : "health",
        budget: input.budgetTokens,
        surface: input.prompt.attackSurface,
      });
      const read = input.tools.find((tool: any) => tool.name === "read_file");
      const usage = { ...emptyUsage(), input: 100, output: 20, totalTokens: security ? 300 : 120 };
      await input.onUsage(usage);
      if (!security) {
        await read.execute("r", { path: "src/routes.ts" });
        return {
          text: JSON.stringify({ summary: "无其他问题", findings: [], limitations: [] }),
          usage,
          model: "model",
          durationMs: 1,
        };
      }
      // unread：只读了前 3 行，却引用第 4 行。
      await read.execute(
        "r",
        mode === "unread" ? { path: "src/routes.ts", startLine: 1, endLine: 3 } : { path: "src/routes.ts" },
      );
      const finding = {
        severity: "high",
        title: "订单接口没有检查订单归属",
        description: "任何登录用户都能用别人的订单 ID 取到订单详情（越权 / IDOR）。",
        impact: "泄露其他用户的订单与地址。",
        suggestion: "查询时同时按当前用户过滤，或查出后核对 order.userId。",
        missingControl: "缺少订单归属校验",
        source: mode === "weak" ? null : { path: "src/routes.ts", line: 3, detail: "GET /api/orders/:id 路由" },
        steps: [],
        sink: { path: "src/routes.ts", line: 4, detail: "按请求里的 id 直接查订单" },
      };
      return {
        text: JSON.stringify({ summary: "发现 1 条越权链路", findings: [finding], limitations: [] }),
        usage,
        model: "model",
        durationMs: 1,
      };
    };
    const processHealth = createHealthProcessor(
      config,
      database,
      new MemoryService(database),
      github as any,
      execute as any,
    );
    const run = async () => {
      const queued = await database.enqueueHealth(repositoryId, { defaultBranch: "main", headSha: sha }, "manual");
      await database.pool.query("UPDATE jobs SET status='running' WHERE id=$1", [queued.job!.id]);
      const job = { ...(queued.job as HealthJob), cloneUrl: root, status: "running" as const };
      await processHealth(job);
      return { id: job.id, report: (await database.getHealthReport(job.id))! };
    };

    const strong = await run();
    const surface = seen.find((item) => item.role === "security")!.surface;
    assert.deepEqual(
      surface.sources.map((point: any) => `${point.kind}:${point.line}`),
      ["http_route:3"],
    );
    assert.deepEqual(
      surface.sinks.map((point: any) => `${point.kind}:${point.line}`),
      ["data_access:4"],
    );
    assert.deepEqual(seen.map((item) => [item.role, item.budget]).sort(), [
      ["health", 6500],
      ["security", 3500],
    ]);
    const chain = strong.report.result.findings.find((finding) => finding.chain)!;
    assert.equal(chain.evidenceLevel, "strong");
    assert.equal(chain.chain!.source!.line, 3);
    assert.equal(chain.chain!.sink!.line, 4);
    assert.equal(strong.report.securityAudit?.status, "complete");
    assert.equal(strong.report.usage.totalTokens, 420, "两个 Agent 的用量都计入报告");
    const runs = (
      await database.pool.query("SELECT role,status FROM agent_runs WHERE job_id=$1 ORDER BY role", [strong.id])
    ).rows;
    assert.deepEqual(
      runs.map((row) => `${row.role}:${row.status}`),
      ["health_auditor:partial", "security_auditor:succeeded"],
      "主流程状态跟报告一致（没有 CI 记录所以是 partial）",
    );
    assert.equal((await database.healthUsage(strong.id)).totalTokens, 420, "重试时两个 Agent 的消耗都要扣");

    mode = "weak";
    const weak = await run();
    assert.equal(weak.report.result.findings.find((finding) => finding.chain)!.evidenceLevel, "weak");

    mode = "unread";
    const rejected = await run();
    assert.equal(rejected.report.status, "partial");
    assert.ok(!rejected.report.result.findings.some((finding) => finding.chain), "整份安全链路结果被丢弃");
    assert.match(
      rejected.report.missingData.find((item) => item.source === "security_audit")!.detail,
      /没有读过的代码行：src\/routes\.ts:4/,
    );
    assert.equal(rejected.report.securityAudit?.status, "failed");
    const failed = (
      await database.pool.query("SELECT status FROM agent_runs WHERE job_id=$1 AND role='security_auditor'", [
        rejected.id,
      ])
    ).rows[0];
    assert.equal(failed.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await database.close();
  }
});
