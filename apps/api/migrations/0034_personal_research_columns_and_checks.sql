-- 0033b — Personal Trip Orchestrator columns + constraint widening.
-- Runs after 0033a so the new `RESEARCH` enum value is visible to all
-- objects below. Idempotent: each ALTER uses IF EXISTS / IF NOT EXISTS
-- guards and the constraint drops are scoped by name.
-- Source: docs/personal-trip-orchestration-implementation.md §4.2, §4.3, §7.1.

-- ─── Columns on agent_task_runs ──────────────────────────────────────────────
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS research_mode varchar(16)
    CHECK (research_mode IS NULL OR research_mode IN ('RESEARCH_ONLY', 'PROPOSE_PLAN'));

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS requested_capabilities jsonb;

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS research_result_id uuid
    REFERENCES planning_research_results(id) ON DELETE SET NULL;

-- ─── Widen operation_refs_check to admit RESEARCH (trip-scoped, like PLAN) ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'agent_task_runs_operation_refs_check'
      AND table_name = 'agent_task_runs'
  ) THEN
    ALTER TABLE agent_task_runs DROP CONSTRAINT agent_task_runs_operation_refs_check;
  END IF;
END $$;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_operation_refs_check CHECK (
    (operation = 'CONVERSATION' AND thread_id IS NOT NULL AND user_message_id IS NOT NULL
      AND trip_id IS NULL AND snapshot_id IS NULL)
    OR
    (operation IN ('PLAN', 'REPLAN') AND trip_id IS NOT NULL AND snapshot_id IS NOT NULL
      AND thread_id IS NULL AND user_message_id IS NULL)
    OR
    (operation = 'RESEARCH' AND trip_id IS NOT NULL AND snapshot_id IS NOT NULL
      AND thread_id IS NULL AND user_message_id IS NULL)
  );

-- ─── Widen terminal_result_check so RESEARCH may carry result_plan_id and
-- terminate as COMPLETED_WITH_GAPS. Mirrors the 0024 pattern. ──────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'agent_task_runs_terminal_result_check'
      AND table_name = 'agent_task_runs'
  ) THEN
    ALTER TABLE agent_task_runs DROP CONSTRAINT agent_task_runs_terminal_result_check;
  END IF;
END $$;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_terminal_result_check CHECK (
    (assistant_message_id IS NULL
      OR (operation = 'CONVERSATION' AND status = 'COMPLETED'))
    AND
    (result_plan_id IS NULL
      OR (operation IN ('PLAN', 'REPLAN', 'RESEARCH')
          AND status IN ('COMPLETED', 'COMPLETED_WITH_GAPS')))
  );

-- ─── Widen the partial unique index so PLAN/REPLAN/RESEARCH share the same
-- "one active task per trip" slot. Mirrors the existing
-- `agent_task_runs_one_active_planning` index from 0009. ───────────────────
DROP INDEX IF EXISTS agent_task_runs_one_active_planning;

CREATE UNIQUE INDEX agent_task_runs_one_active_planning
  ON agent_task_runs (trip_id)
  WHERE trip_id IS NOT NULL
    AND status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
    AND operation IN ('PLAN', 'REPLAN', 'RESEARCH');