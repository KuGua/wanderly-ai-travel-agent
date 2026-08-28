-- S4 / docs/location-introduction-cache-implementation.md §4.
--
-- Shared, non-personalized cache for short destination introductions
-- served by `POST /api/v1/explore/location-introductions`. The table is
-- authoritative across instances; no Redis, no per-user rows. Rows are
-- anonymous (no user/Trip/thread identifiers) and exist solely to
-- amortise one LLM call across many viewers inside the TTL window.
--
-- Schema notes:
--   * `cache_key` is derived only from `contentVersion`, `canonicalPlaceId`
--     and `locale` (see `LocationIntroductionCacheService`); it is the
--     PK so retries and lease-takeovers are idempotent without ON CONFLICT.
--   * `status` is a 2-value enum. Failed generations, schema-invalid
--     outputs, and safe-refusals are NEVER persisted (see service §5.6).
--   * The CHECK constraints encode the doc §4 invariants. They use DO $$
--     blocks so this migration is re-runnable against a partially-migrated
--     database and a partially-dropped constraint set.

-- Idempotent enum creation. CREATE TYPE cannot run inside a transaction
-- when paired with later ADD VALUE; we declare it up-front with IF NOT
-- EXISTS to keep the script re-runnable.
DO $$ BEGIN
  CREATE TYPE location_introduction_status AS ENUM ('GENERATING', 'READY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The table itself. Every column is nullable by design so we can migrate
-- to the new status `GENERATING` without backfill: an old row absent of
-- the new enum simply doesn't exist yet.
CREATE TABLE IF NOT EXISTS location_introduction_cache (
  cache_key                   varchar(64)  PRIMARY KEY,
  canonical_place_id          varchar(128) NOT NULL,
  locale                      varchar(16)  NOT NULL,
  content_version             varchar(64)  NOT NULL,
  status                      location_introduction_status NOT NULL,
  content                     text         NULL,
  generated_at                timestamptz  NULL,
  expires_at                  timestamptz  NULL,
  generation_lease_token      uuid         NULL,
  generation_lease_expires_at timestamptz  NULL,
  model_name                  varchar(128) NULL,
  prompt_version              varchar(64)  NULL,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  updated_at                  timestamptz  NOT NULL DEFAULT now()
);

-- Idempotent CHECK constraints. We DROP+ADD rather than `ADD CONSTRAINT
-- IF NOT EXISTS` because Postgres does not support that syntax.
DO $$ BEGIN
  ALTER TABLE location_introduction_cache
    DROP CONSTRAINT IF EXISTS location_introduction_cache_locale_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE location_introduction_cache
  ADD CONSTRAINT location_introduction_cache_locale_check
  CHECK (locale IN ('en', 'zh'));

DO $$ BEGIN
  ALTER TABLE location_introduction_cache
    DROP CONSTRAINT IF EXISTS location_introduction_cache_canonical_id_length_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE location_introduction_cache
  ADD CONSTRAINT location_introduction_cache_canonical_id_length_check
  CHECK (char_length(canonical_place_id) BETWEEN 1 AND 128);

DO $$ BEGIN
  ALTER TABLE location_introduction_cache
    DROP CONSTRAINT IF EXISTS location_introduction_cache_ready_invariants;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE location_introduction_cache
  ADD CONSTRAINT location_introduction_cache_ready_invariants
  CHECK (
    status <> 'READY' OR (
      content IS NOT NULL
      AND char_length(content) BETWEEN 60 AND 720
      AND generated_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > generated_at
    )
  );

DO $$ BEGIN
  ALTER TABLE location_introduction_cache
    DROP CONSTRAINT IF EXISTS location_introduction_cache_generating_invariants;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE location_introduction_cache
  ADD CONSTRAINT location_introduction_cache_generating_invariants
  CHECK (
    status <> 'GENERATING' OR (
      generation_lease_token IS NOT NULL
      AND generation_lease_expires_at IS NOT NULL
      AND content IS NULL
      AND generated_at IS NULL
      AND expires_at IS NULL
    )
  );

-- Idempotent indexes.
CREATE UNIQUE INDEX IF NOT EXISTS location_introduction_cache_triplet_uidx
  ON location_introduction_cache (canonical_place_id, locale, content_version);
CREATE INDEX IF NOT EXISTS location_introduction_cache_status_expiry_idx
  ON location_introduction_cache (status, expires_at);