-- 0033a — Phase 1 of Personal Trip Orchestrator
-- Add the `RESEARCH` value to the `agent_task_operation` enum.
-- Must run in its own migration: per Postgres semantics (and the runner's
-- per-file transaction wrapper), the new value cannot be referenced in any
-- same-transaction object. The companion migration 0033b adds the columns,
-- widens the operation_refs_check / terminal_result_check constraints, and
-- widens the partial unique index `agent_task_runs_one_active_planning`
-- to include RESEARCH.
-- See docs/personal-trip-orchestration-implementation.md §1, §4.3.

ALTER TYPE agent_task_operation ADD VALUE IF NOT EXISTS 'RESEARCH';