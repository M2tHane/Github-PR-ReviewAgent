-- 开发入口独立于企微；已有任务按接收时保存的消息类型回填来源。
ALTER TABLE development_tasks
  ADD COLUMN source text NOT NULL DEFAULT 'wecom'
    CHECK (source IN ('wecom','issue','pr_comment','admin','issue_label')),
  ADD COLUMN requester_login text,
  ALTER COLUMN bot_id DROP NOT NULL,
  ALTER COLUMN message_id DROP NOT NULL,
  ALTER COLUMN chat_id DROP NOT NULL,
  ALTER COLUMN requester DROP NOT NULL;
UPDATE development_tasks SET source=CASE
  WHEN message_id LIKE 'issue-comment:%' THEN 'issue'
  WHEN message_id LIKE 'pr-comment:%' OR message_id LIKE 'pr-review_comment:%' OR message_id LIKE 'pr-review:%'
    THEN 'pr_comment'
  ELSE 'wecom' END;
-- 历史评论未保存 GitHub 发起人，不能用当前成员关联猜测当时的登录名。
-- 无 Bot 的后续 issue/PR 评论仍按 GitHub 消息 ID 去重。
CREATE UNIQUE INDEX development_tasks_github_message ON development_tasks(message_id)
  WHERE bot_id IS NULL AND message_id IS NOT NULL;
ALTER TABLE development_settings ALTER COLUMN chat_id DROP NOT NULL;
