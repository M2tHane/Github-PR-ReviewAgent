CREATE TABLE development_settings (
  repository_id bigint PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  chat_id text NOT NULL UNIQUE,
  target_branch text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  members jsonb NOT NULL,
  protections jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE development_settings_audits (
  id bigserial PRIMARY KEY,
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  actor text NOT NULL,
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE development_tasks (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL,
  message_id text NOT NULL,
  chat_id text NOT NULL,
  requester text NOT NULL,
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  target_branch text NOT NULL,
  branch text NOT NULL UNIQUE,
  settings_version integer NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','developer')),
  prompt text NOT NULL,
  images jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('queued','running','publishing','succeeded','refused','failed','cancelled','uncertain')),
  owner_token uuid,
  started_at timestamptz,
  base_sha text,
  head_sha text,
  pr_number integer,
  title text,
  result text,
  rule_snapshot jsonb NOT NULL DEFAULT '[]',
  model text,
  usage jsonb,
  duration_ms integer,
  notification_status text NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending','sending','sent','failed','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bot_id,message_id)
);
CREATE INDEX development_tasks_pending ON development_tasks(bot_id,created_at) WHERE status='queued';
CREATE INDEX development_tasks_active ON development_tasks(bot_id) WHERE status IN ('queued','running','publishing');
CREATE INDEX development_tasks_notifications ON development_tasks(bot_id,created_at)
  WHERE notification_status='pending' AND status NOT IN ('queued','running','publishing');
CREATE INDEX development_tasks_recent ON development_tasks(repository_id,created_at DESC);
CREATE INDEX development_tasks_pr ON development_tasks(repository_id,pr_number);
-- 免审查归属不能随普通任务历史清理而丢失；当前随仓库生命周期保留。
