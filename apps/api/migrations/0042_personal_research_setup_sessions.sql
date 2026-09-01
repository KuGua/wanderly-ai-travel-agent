-- 0042 — Personal Research Setup Sessions
--
-- Bounded, owner-scoped, per-intent-run scratchpad that lets the Personal
-- Agent walk the owner through the missing setup fields (dates, stay prefs,
-- flight prefs, departure city) instead of dropping them at a dead-end
-- "go to settings" card.
--
-- Design contract (docs/personal-research-intent-routing-implementation.md §9):
--   * PK = intent_run_id (1:1 with the originating CONVERSATION run).
--   * Trip-level slots are first-class columns (departure_city, travel dates).
--   * Each capability owns one nullable JSON slot (stay_prefs, flight_prefs).
--   * `missing[]` is server-recomputed on every write — the client never
--     authors it.
--   * Status enum drives lifecycle; only OPEN rows are visible to the owner.
--   * CHECK constraints cover pair/scope invariants only — shape of JSON
--     slots is enforced by Zod at the service boundary.
--   * No raw chat text, place names, identity, or extraction provenance is
--     ever stored in this table.

-- ─── Enum: setup session status ────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'personal_research_setup_status'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE format(
      'CREATE TYPE %I.personal_research_setup_status AS ENUM (
        ''OPEN'',
        ''CONFIRMED'',
        ''CANCELLED'',
        ''EXPIRED'',
        ''SUPERSEDED''
      )',
      current_schema()
    );
  END IF;
END
$$;

-- ─── Audit actions (added in this migration) ───────────────────────────────
--
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- Postgres < 12 and has caveats in 12+. The migration runner applies each
-- .sql file via client.begin() but no explicit BEGIN/COMMIT is wrapped
-- around individual statements, matching the 0035 pattern.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_OPENED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_UPDATED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_CONFIRMED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_CANCELLED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_EXPIRED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_FOLLOWUP_GENERATED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_SETUP_FOLLOWUP_FELLBACK';

-- ─── Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS personal_research_setup_sessions (
  intent_run_id UUID PRIMARY KEY
    REFERENCES agent_task_runs(id) ON DELETE CASCADE,

  trip_id UUID NOT NULL
    REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,

  -- Trip-level slots (NULL until owner fills them).
  departure_city VARCHAR(64),
  travel_date_start DATE,
  travel_date_end DATE,

  -- Capability slots. Each is NULL or fully-validated JSON.
  -- $type<{ roomCount, adultsPerRoom, currency }> for stay_preferences.
  -- $type<FlightSearchPreferencesRequest> for flight_preferences.
  stay_preferences JSONB,
  flight_preferences JSONB,

  -- Server-recomputed: the structured-codes still missing for this owner/trip.
  missing JSONB NOT NULL DEFAULT '[]'::jsonb,

  version INTEGER NOT NULL DEFAULT 1,

  status personal_research_setup_status NOT NULL DEFAULT 'OPEN',
  expires_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS personal_research_setup_sessions_trip_owner_idx
  ON personal_research_setup_sessions(trip_id, owner_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS personal_research_setup_sessions_one_open_per_trip_owner
  ON personal_research_setup_sessions(trip_id, owner_user_id)
  WHERE status = 'OPEN';

-- ─── CHECK constraints (idempotent) ────────────────────────────────────────
--
-- An OPEN session intentionally starts incomplete. The service validates
-- completeness before confirmation; the database only enforces that a saved
-- date pair is complete and ordered.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'personal_research_setup_sessions_dates_pair_chk'
  ) THEN
    ALTER TABLE personal_research_setup_sessions
      ADD CONSTRAINT personal_research_setup_sessions_dates_pair_chk CHECK (
        (travel_date_start IS NULL AND travel_date_end IS NULL)
        OR (travel_date_start IS NOT NULL
            AND travel_date_end IS NOT NULL
            AND travel_date_end > travel_date_start)
      );
  END IF;
END
$$;
