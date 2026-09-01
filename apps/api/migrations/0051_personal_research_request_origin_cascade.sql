ALTER TABLE personal_research_requests
  DROP CONSTRAINT IF EXISTS personal_research_requests_originating_intent_run_id_fkey;

ALTER TABLE personal_research_requests
  ADD CONSTRAINT personal_research_requests_originating_intent_run_id_fkey
  FOREIGN KEY (originating_intent_run_id)
  REFERENCES agent_task_runs(id) ON DELETE CASCADE;
