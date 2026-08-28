-- Controlled airport/candidate IDs identify a persisted flight research cell.
ALTER TABLE provider_search_runs ADD COLUMN IF NOT EXISTS origin_id VARCHAR(16);
ALTER TABLE provider_search_runs ADD COLUMN IF NOT EXISTS destination_id VARCHAR(16);
CREATE INDEX IF NOT EXISTS provider_search_runs_matrix_idx
  ON provider_search_runs(snapshot_id, agent_task_run_id, origin_id, destination_id);
