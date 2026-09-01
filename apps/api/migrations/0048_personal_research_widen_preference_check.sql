-- 0048_personal_research_widen_preference_check.sql
--
-- Widen `agent_task_runs_planning_preference_version_check` to admit the new
-- `PERSONAL_RESEARCH` operation. PERSONAL_RESEARCH is owner-only DRAFT-trip
-- research and never carries a Shared snapshot, so both
-- `flight_search_preferences_version` and `stay_search_preferences_version`
-- are NULL — the same as the legacy RESEARCH branch. Mirrors 0037
-- (which widened the same constraint to admit RESEARCH).
--
-- Run after 0047b so the new `PERSONAL_RESEARCH` enum value is visible.
-- Source: docs/draft-personal-research-implementation.md §3.2.

ALTER TABLE agent_task_runs
  DROP CONSTRAINT IF EXISTS agent_task_runs_planning_preference_version_check;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_planning_preference_version_check CHECK (
    (operation = 'CONVERSATION' AND flight_search_preferences_version IS NULL)
    OR (operation IN ('PLAN', 'REPLAN') AND flight_search_preferences_version IS NOT NULL)
    OR (operation IN ('RESEARCH', 'PERSONAL_RESEARCH'))
  );