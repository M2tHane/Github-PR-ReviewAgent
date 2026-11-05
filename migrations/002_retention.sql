-- 数据保留：撤销授权的时间（暂停安装不算），以及删除任务时一并删除它的附属记录。
ALTER TABLE repositories ADD COLUMN revoked_at timestamptz;

ALTER TABLE review_publications
  DROP CONSTRAINT review_publications_job_id_fkey,
  ADD CONSTRAINT review_publications_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE review_findings
  DROP CONSTRAINT review_findings_job_id_fkey,
  ADD CONSTRAINT review_findings_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE reply_publications
  DROP CONSTRAINT reply_publications_job_id_fkey,
  ADD CONSTRAINT reply_publications_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  DROP CONSTRAINT reply_publications_finding_id_fkey,
  ADD CONSTRAINT reply_publications_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES review_findings(id) ON DELETE CASCADE;
ALTER TABLE decision_clues
  DROP CONSTRAINT decision_clues_finding_id_fkey,
  ADD CONSTRAINT decision_clues_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES review_findings(id) ON DELETE CASCADE;
ALTER TABLE agent_runs
  DROP CONSTRAINT agent_runs_job_id_fkey,
  ADD CONSTRAINT agent_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  DROP CONSTRAINT agent_runs_parent_run_id_fkey,
  ADD CONSTRAINT agent_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;

-- 清理时按 PR 分组找"最近有没有活动"。
CREATE INDEX jobs_subject ON jobs (repository_id, pr_number, updated_at);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);
