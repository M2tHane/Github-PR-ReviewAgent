-- 需求不清楚时开 issue 讨论；提需求的人在 issue 里回复“开始”后再开发。
-- 讨论回复（discuss）和固定提示（notice）也走开发任务队列，用 kind 区分；它们不在群里回复。
ALTER TABLE development_tasks ADD COLUMN kind text NOT NULL DEFAULT 'develop' CHECK (kind IN ('develop','discuss','notice'));
ALTER TABLE development_tasks ADD COLUMN issue_number integer;
ALTER TABLE development_tasks DROP CONSTRAINT development_tasks_status_check;
ALTER TABLE development_tasks ADD CONSTRAINT development_tasks_status_check
  CHECK (status IN ('queued','running','publishing','succeeded','refused','failed','cancelled','uncertain','discussing'));
ALTER TABLE development_tasks DROP CONSTRAINT development_tasks_notification_status_check;
ALTER TABLE development_tasks ADD CONSTRAINT development_tasks_notification_status_check
  CHECK (notification_status IN ('pending','sending','sent','failed','uncertain','skipped'));
CREATE TABLE development_issues (
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  issue_number integer NOT NULL,
  origin_task_id uuid NOT NULL REFERENCES development_tasks(id) ON DELETE CASCADE,
  -- discussing：讨论中；developing：已说“开始”，开发中；done：PR 已建好。
  status text NOT NULL CHECK (status IN ('discussing','developing','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, issue_number)
);
CREATE INDEX development_tasks_issue ON development_tasks(repository_id,issue_number) WHERE issue_number IS NOT NULL;
