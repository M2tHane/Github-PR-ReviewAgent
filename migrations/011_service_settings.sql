-- 管理端修改的服务设置。没有记录的项用 .env 或代码里的默认值；删除记录即恢复默认。
CREATE TABLE service_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 每次修改或恢复默认都留一条。值存成 {"v": 值}；old_value 为 NULL 表示原来是默认值，new_value 为 NULL 表示恢复默认。
CREATE TABLE service_setting_audits (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_setting_audits_created_at ON service_setting_audits (created_at DESC);
