-- Phase 1 flight-search foundation.  Only normalized evidence is stored.

CREATE TABLE IF NOT EXISTS trip_search_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  trip_type VARCHAR(16) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  adults INTEGER NOT NULL,
  cabin VARCHAR(32) NOT NULL,
  offer_freshness_minutes INTEGER NOT NULL,
  confirmed_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_search_preferences_trip_version_unique UNIQUE (trip_id, version),
  CONSTRAINT trip_search_preferences_adults_check CHECK (adults BETWEEN 1 AND 9),
  CONSTRAINT trip_search_preferences_freshness_check CHECK (offer_freshness_minutes BETWEEN 1 AND 1440)
);
CREATE INDEX IF NOT EXISTS trip_search_preferences_trip_id_idx ON trip_search_preferences(trip_id);

CREATE TABLE IF NOT EXISTS provider_search_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES constraint_snapshots(id),
  agent_task_run_id UUID REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'flight',
  provider_name VARCHAR(128) NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  error_code VARCHAR(64),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS provider_search_runs_snapshot_id_idx ON provider_search_runs(snapshot_id);
CREATE INDEX IF NOT EXISTS provider_search_runs_agent_task_run_id_idx ON provider_search_runs(agent_task_run_id);

ALTER TABLE provider_offers ADD COLUMN IF NOT EXISTS search_run_id UUID REFERENCES provider_search_runs(id);
ALTER TABLE provider_offers ADD COLUMN IF NOT EXISTS provider_offer_id VARCHAR(256);
ALTER TABLE provider_offers ADD COLUMN IF NOT EXISTS currency VARCHAR(3);
ALTER TABLE provider_offers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'FLIGHT_SEARCH_REQUESTED';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'FLIGHT_SEARCH_COMPLETED';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'FLIGHT_SEARCH_UNAVAILABLE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;
