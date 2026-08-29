-- Reshapes memory_proposals into the evidence aggregate the Petrov hybrid
-- scorer needs, and adds trip-scoped memory.
-- See docs/long-term-memory-implementation.md sections 3.2, 3.5, 4.2, 4.3.
--
-- Replayable: every statement is guarded so re-running the file is a no-op.

-- ─── memory_proposals: evidence aggregate ───────────────────────────────────
ALTER TABLE memory_proposals
  ADD COLUMN IF NOT EXISTS proposed_value_hash TEXT,
  ADD COLUMN IF NOT EXISTS first_observed_on DATE,
  ADD COLUMN IF NOT EXISTS last_observed_on DATE,
  -- Bounded, UTC-day-coarsened observation window. Duplicates allowed: two
  -- distinct episodes may land on the same day.
  ADD COLUMN IF NOT EXISTS recent_observed_on DATE[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS distinct_episode_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS distinct_trip_count INTEGER NOT NULL DEFAULT 0,
  -- Internal only. Never returned to a client, a prompt, telemetry or audit;
  -- held solely so distinct-trip evidence can be counted correctly.
  ADD COLUMN IF NOT EXISTS contributing_trip_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scoring_version VARCHAR(32) NOT NULL DEFAULT 'petrov-hybrid-v1',
  -- Set when a proposal reaches a terminal state, to stop the same suggestion
  -- reappearing immediately.
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;

-- Backfill from the previous shape before the columns are made authoritative.
UPDATE memory_proposals
SET proposed_value_hash = md5(proposed_value::text)
WHERE proposed_value_hash IS NULL;

UPDATE memory_proposals
SET first_observed_on = COALESCE(first_observed_on, (created_at AT TIME ZONE 'UTC')::date),
    last_observed_on = COALESCE(last_observed_on, (updated_at AT TIME ZONE 'UTC')::date)
WHERE first_observed_on IS NULL OR last_observed_on IS NULL;

UPDATE memory_proposals
SET distinct_episode_count = GREATEST(distinct_episode_count, observation_count)
WHERE distinct_episode_count < observation_count;

ALTER TABLE memory_proposals
  ALTER COLUMN proposed_value_hash SET NOT NULL,
  ALTER COLUMN first_observed_on SET NOT NULL,
  ALTER COLUMN last_observed_on SET NOT NULL;

-- The recent window is capped in the database as well as the service, so a
-- service bug cannot grow it into a behavioural timeline.
DO $$ BEGIN
  ALTER TABLE memory_proposals
    ADD CONSTRAINT memory_proposals_recent_window_bounded
    CHECK (COALESCE(array_length(recent_observed_on, 1), 0) <= 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_proposals
    ADD CONSTRAINT memory_proposals_trip_ids_bounded
    CHECK (COALESCE(array_length(contributing_trip_ids, 1), 0) <= 8);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_proposals
    ADD CONSTRAINT memory_proposals_counts_non_negative
    CHECK (distinct_episode_count >= 0 AND distinct_trip_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_proposals
    ADD CONSTRAINT memory_proposals_evidence_span_ordered
    CHECK (first_observed_on <= last_observed_on);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Activation is a derived value and must never be persisted as authoritative
-- (section 3.5 constraint 5). `confidence` was the last remnant of that idea.
ALTER TABLE memory_proposals
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS last_observed_at;

-- Re-point the pending-uniqueness index at the stored hash.
DROP INDEX IF EXISTS memory_proposals_pending_unique;
CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_pending_unique
  ON memory_proposals (user_id, field_key, proposed_value_hash)
  WHERE status = 'PENDING';

-- Cooldown lookups run on every observation, so they get their own index.
CREATE INDEX IF NOT EXISTS memory_proposals_cooldown_idx
  ON memory_proposals (user_id, field_key, proposed_value_hash, cooldown_until)
  WHERE cooldown_until IS NOT NULL;
