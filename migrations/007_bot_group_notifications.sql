ALTER TABLE development_tasks ADD COLUMN reply_req_id text;
ALTER TABLE development_tasks ADD COLUMN reply_expires_at timestamptz;
ALTER TABLE development_tasks ADD COLUMN notification_error text;

ALTER TABLE review_notifications ADD COLUMN chat_id text;
ALTER TABLE review_notifications ADD COLUMN binding_version integer;

-- 旧 Message Push 队列不能转发到新绑定群；已开始发送的仍保留不确定状态。
UPDATE review_notifications SET status='cancelled',last_error='legacy_channel_retired',updated_at=now()
WHERE chat_id IS NULL AND status='pending';
UPDATE review_notifications SET status='uncertain',last_error='delivery_interrupted',updated_at=now()
WHERE chat_id IS NULL AND status='sending';
