ALTER TABLE memories ALTER COLUMN confidence DROP NOT NULL;

CREATE TABLE memory_import_previews (
  id uuid PRIMARY KEY,
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  actor_id bigint NOT NULL,
  source_repository_id bigint REFERENCES repositories(id) ON DELETE CASCADE,
  rules jsonb NOT NULL,
  result jsonb,
  selection jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE INDEX memory_import_previews_expiry ON memory_import_previews(expires_at);
