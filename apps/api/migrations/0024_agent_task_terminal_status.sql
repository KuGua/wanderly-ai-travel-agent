-- 0024_agent_task_terminal_status.sql
-- Phase 4 — agent_task_runs may terminate as COMPLETED_WITH_GAPS (see
-- docs/ground-mobility-implementation.md §4.3). The existing
-- `agent_task_runs_terminal_result_check` constraint only accepts
-- `COMPLETED` for PLAN/REPLAN rows with a result_plan_id, so we relax it to
-- also accept `COMPLETED_WITH_GAPS`.
--
-- IF NOT EXISTS / DO $$ ensures idempotency; the constraint can be dropped
-- and re-added safely.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'agent_task_runs_terminal_result_check'
      AND table_name = 'agent_task_runs'
  ) THEN
    ALTER TABLE agent_task_runs DROP CONSTRAINT agent_task_runs_terminal_result_check;
  END IF;
END $$;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_terminal_result_check CHECK (
    (assistant_message_id IS NULL OR (operation = 'CONVERSATION' AND status = 'COMPLETED'))
    AND
    (result_plan_id IS NULL
     OR (operation IN ('PLAN', 'REPLAN')
         AND status IN ('COMPLETED', 'COMPLETED_WITH_GAPS')))
  );