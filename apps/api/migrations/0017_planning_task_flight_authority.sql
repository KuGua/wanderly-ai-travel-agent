-- Phase 2B: a durable planning task must retain the confirmed preference
-- version it was accepted with.  The Worker never substitutes a newer value.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS flight_search_preferences_version INTEGER;

-- Historical task rows can pre-date this column.  The acceptance service and
-- Worker enforce it for every new PLAN/REPLAN task and fail closed for a
-- legacy row with missing authority.
