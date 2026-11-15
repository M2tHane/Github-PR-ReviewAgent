-- 开发任务中断后接着做：副作用台账、工作区补丁快照和已解析的最终提案。
CREATE TABLE side_effects (
  key text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES development_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','done')),
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX side_effects_task ON side_effects(task_id);

CREATE TABLE development_snapshots (
  task_id uuid PRIMARY KEY REFERENCES development_tasks(id) ON DELETE CASCADE,
  base_sha text NOT NULL,
  changes bytea NOT NULL,
  files integer NOT NULL,
  bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE development_tasks ADD COLUMN proposal jsonb;
ALTER TABLE development_tasks ADD COLUMN last_revision_comment_at timestamptz;

-- 每次领取时冻结历史耗时，心跳/停止/租约到期按本次执行区间累计，排队时间不计。
ALTER TABLE development_tasks ADD COLUMN attempt_duration_base_ms integer NOT NULL DEFAULT 0;
