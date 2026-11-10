import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { redactSecrets } from "../../health/secrets.js";
import { log } from "../../logging.js";
import type { RecordedSession, ServiceEvent, SessionStatus } from "../../pi/session-record.js";

export interface AgentSessionOwner {
  // 不传时用会话记录自带的 id；开发任务在运行 Agent 前就要建记录，自己传 id。
  id?: string;
  jobId?: string;
  agentRunId?: string;
  developmentTaskId?: string;
  role: string;
  attempt?: number;
}

// 运行中至少每 30 秒更新一次；超过 2 分钟没更新，说明执行它的服务已经停了，按"已中断"展示。
const STATUS = (alias: string) =>
  `CASE WHEN ${alias}.status='running' AND ${alias}.updated_at < now() - interval '2 minutes' THEN 'interrupted' ELSE ${alias}.status END`;

// 列表里只带摘要，不带会话内容；内容按需单独读取。
export const SESSION_SUMMARY = (alias: string) =>
  `jsonb_build_object('id',${alias}.id,'agent_run_id',${alias}.agent_run_id,'role',${alias}.role,'attempt',${alias}.attempt,'status',${STATUS(alias)},'error',${alias}.error,'started_at',${alias}.started_at,'duration_ms',${alias}.duration_ms,'steps',${alias}.steps,'bytes',${alias}.bytes,'truncated',${alias}.truncated)`;

export class AgentSessionRepository {
  constructor(readonly pool: Pool) {}

  // 同一个 id 重复保存时更新内容和状态，保留第一次的开始时间；耗时只增不减。
  async saveAgentSession(owner: AgentSessionOwner, session: RecordedSession) {
    const id = owner.id ?? session.id;
    await this.pool.query(
      `INSERT INTO agent_sessions(id,job_id,agent_run_id,development_task_id,role,attempt,status,error,started_at,duration_ms,steps,bytes,truncated,timings,content,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,error=EXCLUDED.error,
         duration_ms=GREATEST(agent_sessions.duration_ms,EXCLUDED.duration_ms),steps=EXCLUDED.steps,bytes=EXCLUDED.bytes,
         truncated=EXCLUDED.truncated,timings=EXCLUDED.timings,content=EXCLUDED.content,updated_at=now()`,
      [
        id,
        owner.jobId ?? null,
        owner.agentRunId ?? null,
        owner.developmentTaskId ?? null,
        owner.role,
        owner.attempt ?? 1,
        session.status,
        session.error ?? null,
        session.startedAt,
        Math.round(session.durationMs),
        session.steps,
        session.bytes,
        session.truncated,
        session.timings,
        session.content,
      ],
    );
    return id;
  }

  async startAgentSession(owner: AgentSessionOwner & { id: string }, startedAt: Date) {
    await this.pool.query(
      `INSERT INTO agent_sessions(id,job_id,agent_run_id,development_task_id,role,attempt,status,started_at,duration_ms,steps,bytes,content,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'running',$7,0,0,0,'',now()) ON CONFLICT (id) DO NOTHING`,
      [
        owner.id,
        owner.jobId ?? null,
        owner.agentRunId ?? null,
        owner.developmentTaskId ?? null,
        owner.role,
        owner.attempt ?? 1,
        startedAt,
      ],
    );
  }

  // 服务步骤按 key 合并：开始时写一次，结束时带上耗时和结果再写一次。
  async agentSessionEvent(id: string, key: string, event: ServiceEvent, durationMs: number) {
    await this.pool.query(
      "UPDATE agent_sessions SET events=events || jsonb_build_object($2::text,$3::jsonb),duration_ms=GREATEST(duration_ms,$4),updated_at=now() WHERE id=$1",
      [id, key, JSON.stringify(event), Math.round(durationMs)],
    );
  }

  async touchAgentSession(id: string, durationMs: number) {
    await this.pool.query(
      "UPDATE agent_sessions SET duration_ms=GREATEST(duration_ms,$2),updated_at=now() WHERE id=$1",
      [id, Math.round(durationMs)],
    );
  }

  async finishAgentSession(
    id: string,
    status: Exclude<SessionStatus, "running">,
    error: string | undefined,
    durationMs: number,
  ) {
    await this.pool.query(
      "UPDATE agent_sessions SET status=$2,error=$3,duration_ms=GREATEST(duration_ms,$4),updated_at=now() WHERE id=$1",
      [id, status, error ?? null, Math.round(durationMs)],
    );
  }

  // 会话所属仓库：权限按仓库判断。开发任务的会话同时返回 development=true，按开发任务的权限检查。
  async getAgentSession(id: string) {
    return (
      await this.pool.query(
        `SELECT s.*, ${STATUS("s")} status, COALESCE(j.repository_id, d.repository_id) repository_id,
           s.development_task_id IS NOT NULL development
         FROM agent_sessions s
         LEFT JOIN jobs j ON j.id=s.job_id
         LEFT JOIN development_tasks d ON d.id=s.development_task_id
         WHERE s.id=$1`,
        [id],
      )
    ).rows[0] as
      | (Record<string, any> & {
          repository_id: string;
          development: boolean;
          content: string;
          timings: any;
          events: Record<string, ServiceEvent>;
        })
      | undefined;
  }
}

// 开发任务一次尝试的执行记录：先建记录，再按步骤写入服务步骤和 Agent 会话，最后由任务决定结果。
// 写入失败只记日志，不影响任务。
export class AgentSessionRecorder {
  readonly id = randomUUID();
  private readonly startedAt = Date.now();
  private queue: Promise<unknown> = Promise.resolve();
  private heartbeat?: ReturnType<typeof setInterval>;
  private finished = false;
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly owner: AgentSessionOwner,
  ) {}
  private elapsed() {
    return Date.now() - this.startedAt;
  }
  private write(operation: () => Promise<unknown>) {
    this.queue = this.queue.then(operation).catch((error) => log("error", "agent_session_record_failed", {}, error));
    return this.queue;
  }
  start() {
    // 长时间没有新步骤时（克隆大仓库、等待命令）也要更新，避免被当成服务已停止。
    this.heartbeat = setInterval(
      () => void this.write(() => this.repository.touchAgentSession(this.id, this.elapsed())),
      30_000,
    );
    this.heartbeat.unref?.();
    return this.write(() =>
      this.repository.startAgentSession({ ...this.owner, id: this.id }, new Date(this.startedAt)),
    );
  }
  // Agent 会话结束不等于这次尝试结束：之后还有收集改动、创建 PR，状态保持进行中。
  readonly agent = (session: RecordedSession) =>
    this.write(() =>
      this.repository.saveAgentSession(
        { ...this.owner, id: this.id },
        { ...session, status: "running", error: undefined, durationMs: this.elapsed() },
      ),
    );
  // 开始一个服务步骤；done / fail 只有第一次生效。
  begin(key: string, name: string) {
    const startedAt = Date.now();
    let ended = false;
    void this.write(() => this.repository.agentSessionEvent(this.id, key, { name, startedAt }, this.elapsed()));
    const end = (ok: boolean, error?: unknown) => {
      if (ended) return;
      ended = true;
      const detail =
        error === undefined ? undefined : redactSecrets(error instanceof Error ? error.message : String(error));
      const event = { name, startedAt, durationMs: Date.now() - startedAt, ok, detail: detail?.slice(0, 500) };
      void this.write(() => this.repository.agentSessionEvent(this.id, key, event, this.elapsed()));
    };
    return { done: () => end(true), fail: (error: unknown) => end(false, error) };
  }
  async step<T>(key: string, name: string, work: () => Promise<T> | T) {
    const step = this.begin(key, name);
    try {
      const value = await work();
      step.done();
      return value;
    } catch (error) {
      step.fail(error);
      throw error;
    }
  }
  finish(status: Exclude<SessionStatus, "running">, error?: string) {
    if (this.finished) return this.queue;
    this.finished = true;
    clearInterval(this.heartbeat);
    const detail = error === undefined ? undefined : redactSecrets(error).slice(0, 500);
    return this.write(() => this.repository.finishAgentSession(this.id, status, detail, this.elapsed()));
  }
}
