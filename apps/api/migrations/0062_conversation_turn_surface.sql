-- 0062_conversation_turn_surface.sql
-- Records which surface a conversation turn was typed on.
--
-- Every chat thread belongs to a trip (`chat_threads.scope` is a single-value
-- enum), and a trip created from the globe appears in the trip list
-- immediately, so no property of the trip distinguishes "the traveller is
-- browsing the globe" from "the traveller is planning this trip". Only the
-- turn knows. Long-term memory extraction reads this to stay out of
-- exploration.
--
-- Nullable on purpose: rows written before this column existed, and any client
-- that does not send it, read as unknown. The extraction gate treats unknown
-- as exploration — the failure direction is remembering nothing, never
-- remembering something the traveller did not mean.

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS conversation_surface VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_task_runs_conversation_surface_check'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_conversation_surface_check
      CHECK (conversation_surface IS NULL OR conversation_surface IN ('EXPLORE', 'TRIP_WORKSPACE'));
  END IF;
END $$;
