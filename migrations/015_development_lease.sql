ALTER TABLE development_tasks ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE development_tasks ADD COLUMN attempt integer NOT NULL DEFAULT 0;

-- 迁移前已经在运行的任务算首次执行；无租约会在新执行器第一次领取时恢复。
UPDATE development_tasks SET attempt=1 WHERE status IN ('running','publishing');
CREATE INDEX development_tasks_expired_lease ON development_tasks(lease_expires_at)
  WHERE status IN ('running','publishing');
CREATE INDEX development_tasks_queued ON development_tasks(created_at,id) WHERE status='queued';
CREATE INDEX development_tasks_executing ON development_tasks(repository_id,kind,pr_number,issue_number)
  WHERE status IN ('running','publishing');
