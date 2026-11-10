-- 每次 Agent 运行的 Pi 会话记录：已去掉模型思考过程、截断过长内容并打码。运行中定时更新，管理页按步骤展示，也可下载。
-- events 是服务自己的步骤（准备工作区、创建提交和 PR 等）；running 超过 2 分钟没更新按已中断展示。
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  development_task_id uuid REFERENCES development_tasks(id) ON DELETE CASCADE,
  role text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','timeout','cancelled')),
  error text,
  started_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  steps integer NOT NULL,
  bytes integer NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  timings jsonb NOT NULL DEFAULT '{}',
  events jsonb NOT NULL DEFAULT '{}',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (job_id IS NOT NULL OR development_task_id IS NOT NULL)
);
CREATE INDEX agent_sessions_job ON agent_sessions(job_id,started_at) WHERE job_id IS NOT NULL;
CREATE INDEX agent_sessions_task ON agent_sessions(development_task_id,started_at) WHERE development_task_id IS NOT NULL;
