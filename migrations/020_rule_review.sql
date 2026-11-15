ALTER TABLE review_findings
  ADD COLUMN inferred_fixed_at timestamptz,
  ADD COLUMN inferred_fixed_sha text;

CREATE TABLE rule_review_dismissals (
  memory_id uuid NOT NULL,
  reason text NOT NULL,
  note text NOT NULL,
  dismissed_by text NOT NULL,
  dismissed_at timestamptz NOT NULL,
  PRIMARY KEY (memory_id, reason)
);

CREATE TABLE repository_trees (
  repository_id bigint PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  sha text NOT NULL,
  paths text[] NOT NULL,
  truncated boolean NOT NULL,
  fetched_at timestamptz NOT NULL
);
