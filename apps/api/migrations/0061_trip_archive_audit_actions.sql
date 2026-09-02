-- `shared_trips.archived_at` / `archive_reason` have existed since
-- 0031_trip_archive_lifecycle.sql, and the trips list already reads them, but
-- nothing could ever write them: there was no route to archive a trip. Adding
-- one needs its own audit actions so an archive (and a restore) is as
-- traceable as every other trip lifecycle change.
--
-- Guarded and schema-scoped for the same reason 0026 is: `pg_type` spans the
-- whole database, so an unqualified name would match the identically named
-- type in a sibling schema and skip the ALTER, leaving the enum short.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY['TRIP_ARCHIVE', 'TRIP_UNARCHIVE']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'audit_action'
        AND t.typnamespace = current_schema()::regnamespace
        AND e.enumlabel = action
    ) THEN
      EXECUTE format('ALTER TYPE audit_action ADD VALUE %L', action);
    END IF;
  END LOOP;
END $$;
