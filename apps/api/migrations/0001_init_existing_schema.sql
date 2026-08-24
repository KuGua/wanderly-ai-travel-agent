-- 0001_init_existing_schema.sql
-- Baseline schema; idempotent. Equivalent to the previous imperative db/migrate.ts,
-- converted to a versioned, re-runnable file. Safe to apply on a database that
-- already has these tables.

DO $$ BEGIN
  CREATE TYPE trip_status AS ENUM ('PLANNING', 'CONFIRMED', 'BOOKED', 'CANCELLED', 'STALE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE plan_status AS ENUM ('DRAFT', 'ACTIVE', 'STALE', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE confirmation_status AS ENUM ('PENDING', 'CONFIRMED', 'NEEDS_CHANGES', 'STALE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE consent_scope AS ENUM ('PROFILE_BASIC', 'PROFILE_PREFERENCES', 'PROFILE_NATIONALITY', 'PROFILE_DOCUMENTS', 'PROFILE_BUDGET', 'PROFILE_RESTRICTIONS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DUPLICATE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE outbox_status AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM (
    'PROFILE_CREATE', 'PROFILE_UPDATE', 'PROFILE_DELETE',
    'TRIP_CREATE', 'TRIP_JOIN',
    'CONSENT_GRANT', 'CONSENT_REVOKE',
    'PLAN_CREATE', 'PLAN_STALE', 'PLAN_REPLAN',
    'CONFIRMATION_SET',
    'BOOKING_SUBMIT', 'BOOKING_RESULT',
    'CHANGE_EVENT',
    'SKILL_INVOKE', 'AGENT_RUN'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id VARCHAR(128) UNIQUE NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  nationality VARCHAR(64),
  passport_number VARCHAR(64),
  date_of_birth VARCHAR(10),
  interests JSONB,
  accommodation_style VARCHAR(32),
  budget_max_usd INTEGER,
  no_red_eye BOOLEAN DEFAULT FALSE,
  mobility_notes TEXT,
  available_departure_dates JSONB,
  departure_city VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS preference_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE NOT NULL,
  field_key VARCHAR(64) NOT NULL,
  field_value JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(256) NOT NULL,
  created_by UUID REFERENCES users(id) NOT NULL,
  status trip_status DEFAULT 'PLANNING' NOT NULL,
  departure_cities JSONB NOT NULL,
  destination_candidates JSONB NOT NULL,
  travel_date_start VARCHAR(10),
  travel_date_end VARCHAR(10),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(32) DEFAULT 'MEMBER' NOT NULL,
  is_required BOOLEAN DEFAULT TRUE NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  scope consent_scope NOT NULL,
  field_list JSONB,
  granted BOOLEAN DEFAULT TRUE NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS constraint_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE NOT NULL,
  version INTEGER NOT NULL,
  authorized_data JSONB NOT NULL,
  departure_cities JSONB NOT NULL,
  destination_candidates JSONB NOT NULL,
  travel_date_start VARCHAR(10),
  travel_date_end VARCHAR(10),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS destination_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE NOT NULL,
  city VARCHAR(128) NOT NULL,
  country VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS itinerary_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE NOT NULL,
  snapshot_id UUID REFERENCES constraint_snapshots(id) NOT NULL,
  version INTEGER DEFAULT 1 NOT NULL,
  status plan_status DEFAULT 'DRAFT' NOT NULL,
  plan_data JSONB NOT NULL,
  replaced_by_plan_id UUID,
  stale_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  superseded_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS member_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES itinerary_plans(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE NOT NULL,
  status confirmation_status DEFAULT 'PENDING' NOT NULL,
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS visa_readiness_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES itinerary_plans(id) ON DELETE CASCADE NOT NULL,
  snapshot_id UUID REFERENCES constraint_snapshots(id) NOT NULL,
  member_id UUID REFERENCES users(id) NOT NULL,
  destination_country VARCHAR(128) NOT NULL,
  nationality VARCHAR(64),
  status VARCHAR(32) NOT NULL,
  checklist JSONB,
  confidence_level VARCHAR(32),
  source VARCHAR(256),
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  disclaimer TEXT
);

CREATE TABLE IF NOT EXISTS source_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES itinerary_plans(id) ON DELETE CASCADE NOT NULL,
  category VARCHAR(32) NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  source VARCHAR(256) NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS provider_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID REFERENCES constraint_snapshots(id) NOT NULL,
  plan_id UUID REFERENCES itinerary_plans(id) ON DELETE CASCADE,
  category VARCHAR(32) NOT NULL,
  provider_name VARCHAR(128) NOT NULL,
  offer_data JSONB NOT NULL,
  is_demo BOOLEAN DEFAULT TRUE NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES itinerary_plans(id) NOT NULL,
  trip_id UUID REFERENCES shared_trips(id) NOT NULL,
  orchestration_request_id UUID NOT NULL,
  status booking_status DEFAULT 'PENDING' NOT NULL,
  sandbox_results JSONB,
  requested_by UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(256) UNIQUE NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id UUID,
  result_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id UUID NOT NULL,
  action audit_action NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  trip_id UUID REFERENCES shared_trips(id),
  plan_id UUID REFERENCES itinerary_plans(id),
  summary JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID UNIQUE NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status outbox_status DEFAULT 'PENDING' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  processed_at TIMESTAMPTZ
);