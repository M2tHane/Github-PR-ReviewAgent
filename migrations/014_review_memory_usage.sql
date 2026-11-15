CREATE TABLE review_memory_usage (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL,
  memory_id uuid NOT NULL,
  memory_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, memory_id)
);

CREATE INDEX review_memory_usage_repository_memory ON review_memory_usage(repository_id, memory_id);
