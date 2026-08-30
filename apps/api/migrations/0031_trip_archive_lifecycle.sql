-- Separate archive visibility from the operational Trip status. Existing
-- exploratory drafts become active planning workspaces under the new model.
ALTER TABLE shared_trips
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(16);

ALTER TABLE shared_trips
  DROP CONSTRAINT IF EXISTS shared_trips_archive_reason_check;
ALTER TABLE shared_trips
  ADD CONSTRAINT shared_trips_archive_reason_check
  CHECK (
    (archived_at IS NULL AND archive_reason IS NULL)
    OR (archived_at IS NOT NULL AND archive_reason IN ('USER_ARCHIVED', 'DATE_ELAPSED'))
  );

UPDATE shared_trips SET status = 'PLANNING' WHERE status = 'DRAFT';
CREATE INDEX IF NOT EXISTS shared_trips_active_archive_idx
  ON shared_trips (archived_at, travel_date_end);
