ALTER TABLE repositories
  ADD COLUMN allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN allowed_by text,
  ADD COLUMN allowed_at timestamptz;
