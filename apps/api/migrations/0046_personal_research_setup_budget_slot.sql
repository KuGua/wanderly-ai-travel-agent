-- 0046 — Personal Research Setup: Budget Hint Slot
--
-- Add a nullable JSONB `budget_hint` column to
-- `personal_research_setup_sessions` so the conversational setup card can
-- capture a soft budget hint before the owner confirms a research request.
-- Shape is enforced at the service boundary by Zod (see
-- apps/api/src/types/schemas.ts:personalResearchSetupSessionResponseSchema).
--
-- `setup_sessions.budget_hint` mirrors `shared_trips.budget_hint_amount/
-- currency/cadence` on confirm — the trip-level columns are the
-- authoritative projection (see confirmAndSearch tx).
--
-- Source: C:\Users\dongc\.claude\plans\vectorized-scribbling-thimble.md.

ALTER TABLE personal_research_setup_sessions
  ADD COLUMN IF NOT EXISTS budget_hint JSONB;

-- The shape `{ amount: int, currency: "USD"|..., cadence: "TOTAL"|... }` is
-- enforced by the Zod schema at the service boundary; a jsonb_typeof CHECK
-- keeps the column self-defending.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'personal_research_setup_sessions_budget_hint_obj_chk'
  ) THEN
    ALTER TABLE personal_research_setup_sessions
      ADD CONSTRAINT personal_research_setup_sessions_budget_hint_obj_chk
      CHECK (
        budget_hint IS NULL
        OR jsonb_typeof(budget_hint) = 'object'
      );
  END IF;
END
$$;