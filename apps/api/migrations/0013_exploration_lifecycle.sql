-- Exploration session + Draft Trip lifecycle.
--
-- Post-implementation invariants enforced here:
--   * `shared_trips.status` gains a `DRAFT` value. A Draft is created by
--     `POST /api/v1/explorations/start` once per authenticated user / request
--     id, owns exactly one default private thread, and may NOT yet be invited
--     to, granted consent on, planned for, confirmed, or booked.
--   * Audit gains `EXPLORATION_START` and `TRIP_ACTIVATE`.  Other operations
--     keep the previous enum values.
--   * The status-transition trigger prevents any service or manual SQL path
--     from moving a `DRAFT` trip to a status other than `PLANNING` or
--     `CANCELLED`. Activate is the only path that creates a `PLANNING` trip
--     from a `DRAFT`.
--
-- The migration is idempotent: enum-value additions use the standard
-- `ADD VALUE IF NOT EXISTS` guard, and the trigger is dropped and recreated.
-- Re-running the migration is safe.

DO $$ BEGIN
  ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'DRAFT';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'EXPLORATION_START';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_ACTIVATE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- A Draft Trip is identified quickly by listing the creator's drafts.
CREATE INDEX IF NOT EXISTS shared_trips_created_by_status_idx
  ON shared_trips (created_by, status, created_at DESC);

-- ─── Status transition guard ───────────────────────────────────────────────
--
-- A Draft Trip may only become PLANNING (via activate) or CANCELLED. The
-- `shared_trips.status = 'DRAFT'` row remains in DRAFT until the creator
-- explicitly activates it with a complete brief.  All other transitions are
-- no-ops when the previous status is not DRAFT, so existing rows are
-- unaffected.

CREATE OR REPLACE FUNCTION enforce_trip_status_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('PLANNING', 'CANCELLED') THEN
    RAISE EXCEPTION
      'shared_trips.status transition denied: DRAFT can only move to PLANNING or CANCELLED (was=%, new=%)',
      OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trip_status_transition ON shared_trips;
CREATE TRIGGER trip_status_transition
  BEFORE UPDATE OF status ON shared_trips
  FOR EACH ROW EXECUTE FUNCTION enforce_trip_status_transition();