-- 0049_drop_personal_research_setup.sql rebuilt `audit_action` from a
-- hardcoded enum list to drop the setup-pipeline values, but the list it
-- wrote omitted 'TRIP_MEMORY_UPDATE' and 'TRIP_MEMORY_DELETE' — values that
-- were never part of the setup pipeline and that trip-memory writes
-- (personal overrides, group decisions) still rely on. Every environment
-- that has run 0049 has been missing them since, silently failing any
-- audit_events insert for those two actions with "invalid input value for
-- enum audit_action". Restore them the same schema-scoped, idempotent way
-- 0026 does, so a schema partway through this history and a fresh one both
-- converge on the same enum.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY['TRIP_MEMORY_UPDATE', 'TRIP_MEMORY_DELETE']
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
