import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { addUsage, emptyUsage, type AgentUsage } from "../../review/agent.js";

export class AgentRunRepository {
  constructor(readonly pool: Pool) {}

  // 这个任务所有尝试累计用掉的 Token（含未回报的预留）。重试时从预算里扣掉，避免每次重试都拿到一份完整预算。
  async jobUsage(jobId: string): Promise<AgentUsage> {
    const rows = (await this.pool.query("SELECT usage FROM agent_runs WHERE job_id=$1", [jobId])).rows;
    const usage = emptyUsage();
    for (const row of rows) addUsage(usage, row.usage);
    return usage;
  }
  async checkpointAgentUsage(id: string, usage: AgentUsage) {
    await this.pool.query("UPDATE agent_runs SET usage=$2,usage_input_tokens=$3,usage_output_tokens=$4 WHERE id=$1", [
      id,
      usage,
      usage.input,
      usage.output,
    ]);
  }

  async startAgentRun(jobId: string, role: string, budget: number, timeoutMs: number, parentRunId?: string) {
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO agent_runs(id,job_id,parent_run_id,role,status,input_budget_tokens,timeout_ms) VALUES($1,$2,$3,$4,'running',$5,$6)",
      [id, jobId, parentRunId ?? null, role, budget, timeoutMs],
    );
    return id;
  }

  async finishAgentRun(
    id: string,
    value: {
      status: "succeeded" | "partial" | "failed" | "timeout" | "cancelled";
      model?: string;
      usage?: Partial<AgentUsage>;
      coverage?: string[];
      limitations?: string[];
      error?: string;
      orchestration?: import("../../review/types.js").OrchestrationSummary;
    },
  ) {
    await this.pool.query(
      "UPDATE agent_runs SET status=$2,model=$3,usage_input_tokens=$4,usage_output_tokens=$5,coverage=$6,limitations=$7,error_summary=$8,usage=$9,orchestration=$10,finished_at=now(),duration_ms=GREATEST(0,round(extract(epoch from (now()-started_at))*1000)::integer) WHERE id=$1",
      [
        id,
        value.status,
        value.model ?? null,
        Number(value.usage?.input ?? 0),
        Number(value.usage?.output ?? 0),
        JSON.stringify(value.coverage ?? []),
        JSON.stringify(value.limitations ?? []),
        value.error ?? null,
        value.usage ?? {},
        value.orchestration ?? null,
      ],
    );
  }
}
