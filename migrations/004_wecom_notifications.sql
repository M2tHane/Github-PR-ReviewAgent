CREATE TABLE review_notifications (
  job_id uuid PRIMARY KEY REFERENCES review_publications(job_id) ON DELETE CASCADE,
  channel text NOT NULL,
  partial boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','uncertain','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_notifications_pending ON review_notifications(channel,next_run_at,created_at)
  WHERE status='pending';
CREATE INDEX review_notifications_sending ON review_notifications(channel) WHERE status='sending';

-- 与任务清理分开，避免删除最近一次通知后丢掉群的限速状态。只保存 Webhook key 的哈希。
CREATE TABLE notification_channels (
  channel text PRIMARY KEY,
  last_attempt_at timestamptz
);

CREATE TABLE repository_notification_members (
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  github_login text NOT NULL CHECK (github_login=lower(github_login)),
  wecom_userid text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id,github_login)
);
