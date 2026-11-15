ALTER TABLE repositories
  ADD COLUMN rules_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN rules_sync_at timestamptz,
  ADD COLUMN rules_sync_status text CHECK (rules_sync_status IN ('pr','unchanged','failed')),
  ADD COLUMN rules_sync_pr_url text,
  ADD COLUMN rules_sync_error text;
ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN ('PR_REVIEW','DECISION_EXTRACT','REPLY_HANDLE','HEALTH_AUDIT','RULES_SYNC'));
ALTER TABLE jobs DROP CONSTRAINT jobs_subject_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_subject_check CHECK (
  (job_type IN ('HEALTH_AUDIT','RULES_SYNC') AND pr_number IS NULL AND base_sha IS NULL AND delivery_id IS NULL)
  OR (job_type NOT IN ('HEALTH_AUDIT','RULES_SYNC') AND pr_number IS NOT NULL AND base_sha IS NOT NULL)
);
CREATE UNIQUE INDEX jobs_rules_sync_pending ON jobs(repository_id) WHERE job_type='RULES_SYNC' AND status='queued';

-- 规则变更与入队原子提交；同仓库的并发触发共用事务锁。运行中的任务允许再排一次，避免遗漏执行期间的变更。
CREATE FUNCTION enqueue_rules_sync(repo_id bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE repo repositories; pending uuid;
BEGIN
  SELECT * INTO repo FROM repositories WHERE id=repo_id AND rules_sync_enabled AND enabled AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rules-sync:' || repo_id, 0));
  SELECT id INTO pending FROM jobs WHERE repository_id=repo_id AND job_type='RULES_SYNC' AND status='queued' ORDER BY created_at LIMIT 1;
  IF pending IS NOT NULL THEN RETURN pending; END IF;
  pending := gen_random_uuid();
  INSERT INTO jobs(id,job_type,repository_id,installation_id,repository,target_sha,payload,status)
    VALUES(pending,'RULES_SYNC',repo.id,repo.installation_id,repo.full_name,'','{"title":"同步仓库规则"}','queued');
  RETURN pending;
END;
$$;
CREATE FUNCTION rules_sync_memory_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.status<>'ACTIVE' THEN RETURN NULL; END IF;
  ELSIF OLD.status<>'ACTIVE' AND NEW.status<>'ACTIVE' THEN RETURN NULL;
  END IF;
  FOR item IN
    SELECT id FROM repositories WHERE id=COALESCE(NEW.repository_id,OLD.repository_id)
    UNION SELECT repository_id FROM team_repositories WHERE team_id=COALESCE(NEW.team_id,OLD.team_id)
    ORDER BY id
  LOOP PERFORM enqueue_rules_sync(item.id); END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER rules_sync_memories AFTER INSERT OR UPDATE OR DELETE ON memories
  FOR EACH ROW EXECUTE FUNCTION rules_sync_memory_changed();
CREATE FUNCTION rules_sync_repository_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_rules_sync(COALESCE(NEW.repository_id,OLD.repository_id));
  RETURN NULL;
END;
$$;
CREATE TRIGGER rules_sync_overrides AFTER INSERT OR UPDATE OR DELETE ON rule_overrides
  FOR EACH ROW EXECUTE FUNCTION rules_sync_repository_changed();
CREATE TRIGGER rules_sync_membership AFTER INSERT OR DELETE ON team_repositories
  FOR EACH ROW EXECUTE FUNCTION rules_sync_repository_changed();
CREATE FUNCTION rules_sync_enabled_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rules_sync_enabled AND NEW.enabled AND
    (NOT OLD.rules_sync_enabled OR NOT OLD.enabled OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) THEN
    PERFORM enqueue_rules_sync(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER rules_sync_enabled AFTER UPDATE OF rules_sync_enabled,enabled,revoked_at ON repositories
  FOR EACH ROW EXECUTE FUNCTION rules_sync_enabled_changed();

-- 重试/部署恢复保留原任务 ID（分支名由它决定），吸收执行期间排队的后继请求。
-- 恢复后会重新编译最新规则，不会丢掉后继请求对应的变更。
CREATE FUNCTION rules_sync_requeue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_type='RULES_SYNC' AND NEW.status='queued' AND OLD.status='running' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rules-sync:' || NEW.repository_id, 0));
    UPDATE jobs SET status='superseded',finished_at=now(),updated_at=now(),last_error='由恢复中的规则同步任务合并处理'
      WHERE job_type='RULES_SYNC' AND repository_id=NEW.repository_id AND status='queued' AND id<>NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rules_sync_retry BEFORE UPDATE OF status ON jobs FOR EACH ROW EXECUTE FUNCTION rules_sync_requeue();
