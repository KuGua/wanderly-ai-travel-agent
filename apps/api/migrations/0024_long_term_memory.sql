-- Long-term memory: preference fact versioning, behaviour proposals and
-- trip-scoped memory. See docs/long-term-memory-implementation.md §4.
--
-- Replayable: every statement is guarded so re-running the file is a no-op.

-- ─── Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE memory_field_category AS ENUM ('PREFERENCE', 'CONSTRAINT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE preference_fact_source AS ENUM ('PROFILE_FORM', 'PROPOSAL_CONFIRMATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE preference_fact_status AS ENUM ('ACTIVE', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE memory_proposal_source AS ENUM ('BEHAVIOR_AGGREGATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE memory_proposal_status AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_memory_kind AS ENUM ('PERSONAL_OVERRIDE', 'GROUP_DECISION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_memory_source AS ENUM ('OWNER_SAVE', 'GROUP_COMMAND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_memory_status AS ENUM ('ACTIVE', 'SUPERSEDED', 'DELETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New audit actions. ALTER TYPE ... ADD VALUE cannot run inside a transaction
-- block in older servers, so each is issued separately and guarded.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY[
    'MEMORY_PROPOSAL_CREATE', 'MEMORY_PROPOSAL_CONFIRM', 'MEMORY_PROPOSAL_DISMISS',
    'PREFERENCE_FACT_UPDATE', 'PREFERENCE_FACT_DELETE',
    'TRIP_MEMORY_UPDATE', 'TRIP_MEMORY_DELETE',
    'MEMORY_PROJECTION_CREATE', 'MEMORY_INVALIDATION'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'audit_action' AND e.enumlabel = action
    ) THEN
      EXECUTE format('ALTER TYPE audit_action ADD VALUE %L', action);
    END IF;
  END LOOP;
END $$;

-- ─── preference_facts: versioning and provenance ────────────────────────────
ALTER TABLE preference_facts
  ADD COLUMN IF NOT EXISTS category memory_field_category NOT NULL DEFAULT 'PREFERENCE',
  ADD COLUMN IF NOT EXISTS source preference_fact_source NOT NULL DEFAULT 'PROFILE_FORM',
  ADD COLUMN IF NOT EXISTS status preference_fact_status NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersedes_fact_id UUID;

DO $$ BEGIN
  ALTER TABLE preference_facts
    ADD CONSTRAINT preference_facts_supersedes_fk
    FOREIGN KEY (supersedes_fact_id) REFERENCES preference_facts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill runs before the unique index so pre-existing rows are classified
-- first. Existing rows are form-sourced and active by definition.
UPDATE preference_facts SET status = 'ACTIVE' WHERE status IS NULL;
UPDATE preference_facts SET source = 'PROFILE_FORM' WHERE source IS NULL;

-- Any historical duplicates are demoted to SUPERSEDED, keeping the newest row
-- active, so the partial unique index below can be created safely.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, field_key
    ORDER BY updated_at DESC, created_at DESC, id DESC
  ) AS rank
  FROM preference_facts
  WHERE status = 'ACTIVE'
)
UPDATE preference_facts
SET status = 'SUPERSEDED'
WHERE id IN (SELECT id FROM ranked WHERE rank > 1);

-- At most one ACTIVE fact per (user, field).
CREATE UNIQUE INDEX IF NOT EXISTS preference_facts_active_unique
  ON preference_facts (user_id, field_key)
  WHERE status = 'ACTIVE';

-- ─── memory_proposals ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  field_key VARCHAR(64) NOT NULL,
  proposed_value JSONB NOT NULL,
  source memory_proposal_source NOT NULL DEFAULT 'BEHAVIOR_AGGREGATION',
  observation_count INTEGER NOT NULL DEFAULT 1,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  status memory_proposal_status NOT NULL DEFAULT 'PENDING',
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_fact_id UUID REFERENCES preference_facts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memory_proposals_observation_count_positive CHECK (observation_count > 0),
  CONSTRAINT memory_proposals_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  -- Second line of defence behind the service allow-list: the sensitive,
  -- form-only fields can never be reached by behavioural inference.
  CONSTRAINT memory_proposals_field_not_sensitive
    CHECK (field_key NOT IN ('nationality', 'date_of_birth', 'mobility_notes', 'passport_number'))
);

CREATE INDEX IF NOT EXISTS memory_proposals_user_status_idx
  ON memory_proposals (user_id, status);

-- One pending proposal per (user, field, value): repeated aggregation runs
-- merge into the same row instead of piling up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_pending_unique
  ON memory_proposals (user_id, field_key, md5(proposed_value::text))
  WHERE status = 'PENDING';

-- ─── trip_memory_facts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind trip_memory_kind NOT NULL,
  field_key VARCHAR(64) NOT NULL,
  field_value JSONB,
  status trip_memory_status NOT NULL DEFAULT 'ACTIVE',
  source trip_memory_source NOT NULL,
  supersedes_fact_id UUID REFERENCES trip_memory_facts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_memory_facts_group_not_sensitive
    CHECK (kind <> 'GROUP_DECISION' OR field_key NOT IN ('nationality', 'date_of_birth', 'mobility_notes', 'passport_number'))
);

CREATE INDEX IF NOT EXISTS trip_memory_facts_trip_idx
  ON trip_memory_facts (trip_id, status);

-- A personal override is unique per member; a group decision is unique per trip.
CREATE UNIQUE INDEX IF NOT EXISTS trip_memory_facts_override_unique
  ON trip_memory_facts (trip_id, owner_user_id, field_key)
  WHERE status = 'ACTIVE' AND kind = 'PERSONAL_OVERRIDE';

CREATE UNIQUE INDEX IF NOT EXISTS trip_memory_facts_group_unique
  ON trip_memory_facts (trip_id, field_key)
  WHERE status = 'ACTIVE' AND kind = 'GROUP_DECISION';
