-- 多实例运行：领取任务时写租约，Worker 定期续租；租约过期的任务由其他实例接手。
ALTER TABLE jobs
  ADD COLUMN lease_token uuid,
  ADD COLUMN locked_by text,
  ADD COLUMN lease_expires_at timestamptz,
  -- 别的实例收到"PR 关闭 / 有新提交"时写这里，正在执行的实例续租时看到就停下。
  ADD COLUMN cancel_requested text CHECK (cancel_requested IN ('cancelled', 'superseded'));
CREATE INDEX jobs_running_lease ON jobs (lease_expires_at) WHERE status = 'running';
-- 升级时旧版本进程可能还在跑任务：给它们 10 分钟跑完，之后才视为失联。
UPDATE jobs SET lease_expires_at = now() + interval '10 minutes' WHERE status = 'running';

-- 管理页登录会话和 OAuth state，多个实例共用。id 存哈希，value 加密（含维护者的 GitHub token）。
CREATE TABLE admin_sessions (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('session', 'oauth_state')),
  value text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_expires ON admin_sessions (kind, expires_at);
