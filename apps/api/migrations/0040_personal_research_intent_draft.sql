-- 0040 — Personal Research Intent Routing (Phase 0)
-- Add non-executable persisted research-intent draft and explicit lifecycle
-- state to CONVERSATION runs. Drafts are stored as JSON with `schemaVersion: 1`
-- and contain only capability enums + readiness gaps; the spec forbids
-- coordinates, dates, party size, currency, provider, place IDs, identity,
-- and original question text. Source: docs/personal-research-intent-routing-implementation.md §4.1, §7 Phase 0.
--
-- All statements are idempotent so the migration can run repeatedly against
-- partially-upgraded dev DBs.

-- ─── Enum type for draft lifecycle ──────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'research_intent_state') THEN
    CREATE TYPE research_intent_state AS ENUM
      ('PROPOSED', 'DISMISSED', 'CONFIRMED', 'SUPERSEDED');
  END IF;
END
$$;

-- ─── Columns on agent_task_runs ─────────────────────────────────────────────
-- research_intent_draft: JSON envelope (validated by Zod on the way in).
-- research_intent_state: lifecycle state for the draft row, never bound to
--   execution authority. Always NULL on PLAN/REPLAN/RESEARCH rows.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS research_intent_draft JSONB;

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS research_intent_state VARCHAR(16);

-- ─── CHECK on the state column value set (idempotent) ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_task_runs_research_intent_state_chk'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_research_intent_state_chk
      CHECK (
        research_intent_state IS NULL
        OR research_intent_state IN ('PROPOSED', 'DISMISSED', 'CONFIRMED', 'SUPERSEDED')
      );
  END IF;
END
$$;

-- ─── Operation-scope CHECK ──────────────────────────────────────────────────
-- Drafts only live on CONVERSATION rows. PLAN/REPLAN/RESEARCH rows MUST keep
-- both columns NULL. This locks the spec invariant at the DB layer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_task_runs_research_intent_draft_scope_chk'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_research_intent_draft_scope_chk
      CHECK (
        operation = 'CONVERSATION'
        OR (research_intent_draft IS NULL AND research_intent_state IS NULL)
      );
  END IF;
END
$$;

-- ─── Pair CHECK ────────────────────────────────────────────────────────────
-- draft and state move together; a half-populated row is never valid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_task_runs_research_intent_pair_chk'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_research_intent_pair_chk
      CHECK (
        (research_intent_draft IS NULL AND research_intent_state IS NULL)
        OR (research_intent_draft IS NOT NULL AND research_intent_state IS NOT NULL)
      );
  END IF;
END
$$;

-- ─── Partial index for supersede-on-new-draft lookups ──────────────────────
-- Most threads carry at most one PROPOSED draft at a time. Indexing only the
-- PROPOSED rows keeps the index small and gives the supersede helper an O(1)
-- path inside the draft-insert transaction.
CREATE INDEX IF NOT EXISTS agent_task_runs_thread_draft_proposed_idx
  ON agent_task_runs (thread_id);
