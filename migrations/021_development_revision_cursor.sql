-- GitHub 评论时间为秒精度；同秒后到的评论依靠种类 + ID 区分。
ALTER TABLE development_tasks ADD COLUMN last_revision_comment_ids text[] NOT NULL DEFAULT '{}';
