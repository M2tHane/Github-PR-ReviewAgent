-- 每个 PR 最近一次已处理的 pull_request 事件时间（取事件快照里的 pull_request.updated_at）。
-- 补投或人工重投的旧事件比它更早时不再处理，不会顶掉新 head 的 Review，也不会取消已重新打开的 PR。
CREATE TABLE pull_request_events (
  repository_id bigint NOT NULL,
  pr_number integer NOT NULL,
  last_event_at timestamptz NOT NULL,
  PRIMARY KEY (repository_id, pr_number)
);
