-- 0045 — Personal Research Quick Orchestration: Budget Hint + Pin Session
--
-- (a) `BUDGET_HINT_MISSING` is a warning-level gap code. It is NOT a Postgres
-- enum value: `research_missing_code` lives only as a Zod enum in the app
-- layer (see apps/api/src/types/schemas.ts:592). The DB stores these codes
-- as JSON strings; the application layer is the source of truth.
--
-- (b) Add three new audit-action enum entries used by the quick-orchestration
-- pipeline (proactive intro enqueue, budget hint save, pin session write).
--
-- (c) Add five nullable columns to `shared_trips`:
--   * `budget_hint_amount / currency / cadence` — owner-provided soft budget.
--   * `pinned_session_id / pinned_at` — server-managed pointer to the latest
--     terminal run (auto-pin feature).
-- All columns are nullable so legacy rows remain valid. Index only the
-- pinned_session_id (lookup "what is pinned for this trip" is a common read
-- pattern from the trip-detail projection).
--
-- Source: docs/personal-research-intent-routing-implementation.md §11 (to
-- be written) / C:\Users\dongc\.claude\plans\vectorized-scribbling-thimble.md.

-- ─── Audit actions (added in this migration) ───────────────────────────────

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_BUDGET_HINT_SAVED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_PROACTIVE_INTRO_ENQUEUED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_PIN_SESSION_WRITTEN';

-- ─── Columns on shared_trips ───────────────────────────────────────────────

ALTER TABLE shared_trips
  ADD COLUMN IF NOT EXISTS budget_hint_amount INTEGER,
  ADD COLUMN IF NOT EXISTS budget_hint_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS budget_hint_cadence VARCHAR(16),
  ADD COLUMN IF NOT EXISTS pinned_session_id UUID
    REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- ─── CHECK (idempotent) ─────────────────────────────────────────────────────
-- `budget_hint_cadence` is a closed enum; the application layer also enforces
-- this in the Zod schema. A row-level CHECK keeps the column self-defending.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shared_trips_budget_hint_cadence_chk'
  ) THEN
    ALTER TABLE shared_trips
      ADD CONSTRAINT shared_trips_budget_hint_cadence_chk CHECK (
        budget_hint_cadence IS NULL
        OR budget_hint_cadence IN ('TOTAL', 'PER_NIGHT', 'PER_PERSON')
      );
  END IF;
END
$$;

-- ─── Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS shared_trips_pinned_session_idx
  ON shared_trips(pinned_session_id);