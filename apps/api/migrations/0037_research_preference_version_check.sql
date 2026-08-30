-- Widen agent_task_runs_planning_preference_version_check to admit RESEARCH.
--
-- This constraint predates the RESEARCH operation (0033a/0033b) and only
-- has branches for CONVERSATION (must be NULL) and PLAN/REPLAN (must be
-- NOT NULL). A RESEARCH row satisfies neither branch, so every RESEARCH
-- insert fails regardless of the column's value. Unlike PLAN/REPLAN,
-- acceptResearchTask's flightSearchPreferencesVersion is optional (a
-- research run may omit the "flight" capability entirely), so RESEARCH
-- gets its own permissive branch rather than joining the PLAN/REPLAN one.

ALTER TABLE agent_task_runs
  DROP CONSTRAINT IF EXISTS agent_task_runs_planning_preference_version_check;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_planning_preference_version_check CHECK (
    (operation = 'CONVERSATION' AND flight_search_preferences_version IS NULL)
    OR (operation IN ('PLAN', 'REPLAN') AND flight_search_preferences_version IS NOT NULL)
    OR (operation = 'RESEARCH')
  );
