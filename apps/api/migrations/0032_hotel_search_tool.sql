-- Provider-neutral accommodation discovery and hotel.search with durable
-- confirmed stay preferences, plus a shared provider-search cache.
-- Supplier credentials, request URLs and raw provider payloads are never
-- stored by this schema.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'HOTEL_SEARCH_REQUESTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'HOTEL_SEARCH_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'HOTEL_SEARCH_UNAVAILABLE';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'STAY_SEARCH_PREFERENCES_CONFIRMED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ACCOMMODATION_DISCOVERY_REQUESTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ACCOMMODATION_DISCOVERY_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ACCOMMODATION_DISCOVERY_UNAVAILABLE';

CREATE TABLE IF NOT EXISTS trip_stay_search_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  room_count INTEGER NOT NULL CHECK (room_count BETWEEN 1 AND 8),
  adults_per_room JSONB NOT NULL,
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_display_mode VARCHAR(32) NOT NULL DEFAULT 'TOTAL_AND_PER_NIGHT'
    CHECK (price_display_mode = 'TOTAL_AND_PER_NIGHT'),
  tax_fee_disclosure VARCHAR(48) NOT NULL DEFAULT 'SHOW_POSSIBLY_EXTRA_WHEN_UNKNOWN'
    CHECK (tax_fee_disclosure = 'SHOW_POSSIBLY_EXTRA_WHEN_UNKNOWN'),
  confirmed_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trip_id, version)
);

CREATE INDEX IF NOT EXISTS trip_stay_search_preferences_trip_id_idx
  ON trip_stay_search_preferences(trip_id);

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS stay_search_preferences_version INTEGER;

-- Race-safe task-level dedupe. The application reserves a PENDING run before
-- contacting SerpApi, so concurrent duplicate Tool calls cannot both spend
-- provider quota.
CREATE UNIQUE INDEX IF NOT EXISTS provider_search_runs_hotel_task_destination_unique
  ON provider_search_runs(agent_task_run_id, snapshot_id, destination_id)
  WHERE agent_task_run_id IS NOT NULL
    AND destination_id IS NOT NULL
    AND category = 'hotel';

-- Cross-run read-through cache. Only a request fingerprint and a pointer to
-- normalized provider evidence are retained; no raw response, request URL,
-- API key or user identifier is stored here.
CREATE TABLE IF NOT EXISTS provider_search_cache (
  request_fingerprint VARCHAR(64) PRIMARY KEY,
  provider_name VARCHAR(128) NOT NULL,
  category VARCHAR(32) NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('PENDING', 'LIVE', 'UNAVAILABLE')),
  source_search_run_id UUID REFERENCES provider_search_runs(id) ON DELETE CASCADE,
  error_code VARCHAR(64),
  captured_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_search_cache_state_fields CHECK (
    (state = 'PENDING' AND source_search_run_id IS NULL AND error_code IS NULL AND lease_expires_at IS NOT NULL)
    OR (state = 'LIVE' AND source_search_run_id IS NOT NULL AND error_code IS NULL AND lease_expires_at IS NULL)
    OR (state = 'UNAVAILABLE' AND source_search_run_id IS NULL AND error_code IS NOT NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS provider_search_cache_expires_at_idx
  ON provider_search_cache(expires_at);

CREATE INDEX IF NOT EXISTS provider_search_cache_provider_category_idx
  ON provider_search_cache(provider_name, category);

CREATE UNIQUE INDEX IF NOT EXISTS provider_search_runs_task_category_fingerprint_unique
  ON provider_search_runs(agent_task_run_id, snapshot_id, category, request_fingerprint)
  WHERE agent_task_run_id IS NOT NULL;
