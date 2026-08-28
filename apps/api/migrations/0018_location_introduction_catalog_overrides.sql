-- S4 operator registration: lets an authenticated admin register a new
-- stable `sourceId` at runtime. The DB row is the authoritative source
-- for the lookup; the catalog.json file is rewritten so deploy-time
-- cold-starts see the same entries without a separate migration.
--
-- This is the only path that adds a new entry to the catalog after the
-- initial deploy. The cache itself is unaffected — the existing
-- `location_introduction_cache` table continues to store per-locale
-- READY/GENERATING rows keyed by `sha256(contentVersion + canonicalPlaceId + locale)`.

CREATE TABLE IF NOT EXISTS location_introduction_catalog_overrides (
  source_id              varchar(128) PRIMARY KEY,
  canonical_place_id     varchar(128) NOT NULL,
  name                   varchar(256) NOT NULL,
  country                varchar(128) NOT NULL,
  country_code           varchar(8)   NOT NULL,
  admin1                 varchar(128) NOT NULL,
  admin1_code            varchar(64)  NOT NULL,
  nearest_city           varchar(128) NOT NULL,
  nearest_city_longitude double precision NOT NULL,
  nearest_city_latitude  double precision NOT NULL,
  dataset_version        varchar(64)  NOT NULL,
  created_by_user_id     uuid         NOT NULL REFERENCES users(id),
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now()
);

-- Defense-in-depth: keep `sourceId` shape consistent with the file-side
-- catalog (`[A-Za-z0-9_-]{1,128}`) and `countryCode` length 1..8 so an
-- admin cannot smuggle arbitrary text into the catalog index.
DO $$ BEGIN
  ALTER TABLE location_introduction_catalog_overrides
    DROP CONSTRAINT IF EXISTS location_introduction_overrides_source_id_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE location_introduction_catalog_overrides
  ADD CONSTRAINT location_introduction_overrides_source_id_check
  CHECK (source_id ~ '^[A-Za-z0-9_-]{1,128}$');

DO $$ BEGIN
  ALTER TABLE location_introduction_catalog_overrides
    DROP CONSTRAINT IF EXISTS location_introduction_overrides_country_code_length_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE location_introduction_catalog_overrides
  ADD CONSTRAINT location_introduction_overrides_country_code_length_check
  CHECK (char_length(country_code) BETWEEN 1 AND 8);