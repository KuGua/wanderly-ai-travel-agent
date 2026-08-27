-- Deterministic trip titles use only the explicit brief and never chat text.
-- Existing names are preserved as manual titles for backwards compatibility.

ALTER TABLE shared_trips
  ADD COLUMN IF NOT EXISTS name_source VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS title_locale VARCHAR(8);

ALTER TABLE shared_trips
  DROP CONSTRAINT IF EXISTS shared_trips_name_source_check;
ALTER TABLE shared_trips
  ADD CONSTRAINT shared_trips_name_source_check
  CHECK (name_source IN ('AUTO', 'MANUAL'));

ALTER TABLE shared_trips
  DROP CONSTRAINT IF EXISTS shared_trips_title_locale_check;
ALTER TABLE shared_trips
  ADD CONSTRAINT shared_trips_title_locale_check
  CHECK (title_locale IS NULL OR title_locale IN ('en', 'zh'));

-- Drafts created by the exploration lifecycle used a known generated
-- placeholder. Mark only those rows AUTO; preserve every historic custom name.
UPDATE shared_trips
SET name_source = 'AUTO', title_locale = 'en'
WHERE name = 'Untitled exploration' AND status = 'DRAFT';

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_TITLE_UPDATE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;
