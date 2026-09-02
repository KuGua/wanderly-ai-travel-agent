-- Deleting a trip is now a real delete, not the archive added in 0061, so it
-- needs its own audit action. The row it writes carries no `trip_id` — that
-- column is about to reference nothing — and names the trip in its summary
-- instead, which is also why the surviving audit rows for a deleted trip keep
-- their history and lose only the reference.
--
-- Guarded and schema-scoped for the same reason 0026 is: `pg_type` spans the
-- whole database, so an unqualified name would match the identically named
-- type in a sibling schema and skip the ALTER, leaving the enum short.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY['TRIP_DELETE']
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
