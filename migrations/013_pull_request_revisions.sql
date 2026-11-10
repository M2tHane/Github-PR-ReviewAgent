-- 开发 PR 下的评论：有仓库权限的人评论后，Agent 读评论，按需在同一分支上改代码、在 PR 里回复（kind=revise）。
-- revise 任务的 pr_number 在入队时就填好，branch 是原开发任务的分支。
ALTER TABLE development_tasks DROP CONSTRAINT development_tasks_kind_check;
ALTER TABLE development_tasks ADD CONSTRAINT development_tasks_kind_check
  CHECK (kind IN ('develop','discuss','notice','revise'));
CREATE INDEX development_tasks_pull_request ON development_tasks(repository_id,pr_number) WHERE pr_number IS NOT NULL;
-- 同一个开发分支会有多条 revise 任务；分支名只在开发任务之间唯一。
ALTER TABLE development_tasks DROP CONSTRAINT development_tasks_branch_key;
CREATE UNIQUE INDEX development_tasks_branch_key ON development_tasks(branch) WHERE kind<>'revise';
