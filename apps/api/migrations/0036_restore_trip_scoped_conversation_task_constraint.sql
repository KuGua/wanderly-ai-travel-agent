-- Restore the trip-scoped CONVERSATION task invariant.
--
-- Migration 0012 made every chat thread trip-bound, and conversation task
-- acceptance persists that server-derived trip_id.  Migration 0034 widened
-- this constraint for RESEARCH but accidentally restored the pre-0012
-- CONVERSATION branch, which required trip_id to be NULL.  That made every
-- new Personal Agent turn fail during task acceptance.  Keep the RESEARCH
-- branch while restoring the post-0012 contract.

ALTER TABLE agent_task_runs
  DROP CONSTRAINT IF EXISTS agent_task_runs_operation_refs_check;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_operation_refs_check CHECK (
    (operation = 'CONVERSATION' AND thread_id IS NOT NULL AND user_message_id IS NOT NULL
      AND trip_id IS NOT NULL AND snapshot_id IS NULL)
    OR
    (operation IN ('PLAN', 'REPLAN', 'RESEARCH') AND trip_id IS NOT NULL AND snapshot_id IS NOT NULL
      AND thread_id IS NULL AND user_message_id IS NULL)
  );
