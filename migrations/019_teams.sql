CREATE TABLE teams (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  github_login text NOT NULL CHECK (github_login = lower(github_login)),
  role text NOT NULL CHECK (role IN ('admin','member')),
  PRIMARY KEY (team_id, github_login)
);
CREATE TABLE team_repositories (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, repository_id)
);
CREATE INDEX team_repositories_repository ON team_repositories(repository_id);
ALTER TABLE memories
  ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  ADD COLUMN level text NOT NULL DEFAULT 'should' CHECK (level IN ('must','should','info')),
  ALTER COLUMN repository_id DROP NOT NULL,
  ALTER COLUMN installation_id DROP NOT NULL,
  ADD CONSTRAINT memories_owner CHECK (num_nonnulls(repository_id,team_id) = 1),
  ADD UNIQUE (team_id,source_fingerprint);

CREATE TABLE rule_overrides (
  repository_id bigint NOT NULL,
  memory_id uuid NOT NULL,
  -- Membership FK removes overrides when a repository leaves a team, including team deletion.
  team_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('disable','level')),
  level text CHECK (level IN ('must','should','info')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id,memory_id),
  FOREIGN KEY (team_id,repository_id) REFERENCES team_repositories(team_id,repository_id) ON DELETE CASCADE,
  CHECK ((action='disable' AND level IS NULL) OR (action='level' AND level IS NOT NULL))
);
CREATE FUNCTION check_rule_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memories WHERE id=NEW.memory_id AND team_id=NEW.team_id) THEN
    RAISE EXCEPTION 'Override must refer to a rule owned by the repository team';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rule_override_owner BEFORE INSERT OR UPDATE ON rule_overrides
  FOR EACH ROW EXECUTE FUNCTION check_rule_override();

ALTER TABLE memory_import_previews
  ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  ALTER COLUMN repository_id DROP NOT NULL,
  ADD CONSTRAINT memory_import_preview_owner CHECK (num_nonnulls(repository_id,team_id) = 1);
