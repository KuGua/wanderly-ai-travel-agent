-- 0044 — Personal Research Intent Routing (Phase 2)
-- Add explicit `blockers` and `warnings` JSONB columns to `agent_task_runs`
-- so the two-tier readiness model can persist its split. Both arrays share
-- the same value set as `missing` (the `research_missing_code` enum). Old
-- rows from Phase 0/1 leave both columns NULL; the application layer
-- default-fills to `[]` on read.
--
-- All statements are idempotent so the migration can run repeatedly against
-- partially-upgraded dev DBs.
--
-- Source: docs/personal-research-intent-routing-implementation.md §5.2.

-- ─── Columns on agent_task_runs ─────────────────────────────────────────────
-- `blockers`: hard gaps the owner must resolve before research can start.
-- `warnings`: soft advisories — research can still start, but quality may
--   degrade. Both arrays share the value set with `missing`.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS research_intent_blockers JSONB;

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS research_intent_warnings JSONB;

-- ─── Shape CHECK (idempotent) ───────────────────────────────────────────────
-- Each populated column must be a JSON array. Element value-set is enforced
-- by the application layer (Zod `researchMissingCodeSchema`); a DB-level
-- CHECK on each element would require jsonb_array_elements_text per row
-- which is not worth the cost given the small data volume.
--
-- We intentionally do NOT add a pair CHECK between `research_intent_draft`,
-- `research_intent_blockers`, and `research_intent_warnings`: legacy rows
-- from Phase 0/1 carry a populated draft but null blockers/warnings, and
-- the application layer default-fills them to `[]` on read.

-- ─── Shape CHECK (idempotent) ───────────────────────────────────────────────
-- Each populated column must be a JSON array. Element value-set is enforced
-- by the application layer (Zod `researchMissingCodeSchema`); a DB-level
-- CHECK on each element would require jsonb_array_elements_text per row
-- which is not worth the cost given the small data volume.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_task_runs_research_intent_blockers_arr_chk'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_research_intent_blockers_arr_chk
      CHECK (
        research_intent_blockers IS NULL
        OR jsonb_typeof(research_intent_blockers) = 'array'
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_task_runs_research_intent_warnings_arr_chk'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_research_intent_warnings_arr_chk
      CHECK (
        research_intent_warnings IS NULL
        OR jsonb_typeof(research_intent_warnings) = 'array'
      );
  END IF;
END
$$;