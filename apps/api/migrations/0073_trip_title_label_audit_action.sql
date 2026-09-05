-- 0073 — Audit action for trip title destination-label writes.
-- Both sources (deterministic reference resolution and owner-explicit LLM
-- suggestion) share a single audit action. The summary's `source` field
-- distinguishes them. The summary intentionally never contains the label
-- text — destination labels are derived from private conversation
-- content (or closeable reference data, but always in response to the
-- owner's own turn) and must not land in the audit log.
--
-- Guarded and schema-scoped for the same reason 0070 is: `pg_type` spans
-- the whole database, so an unqualified name would match the identically
-- named type in a sibling schema and skip the ALTER, leaving the enum short.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY['TRIP_TITLE_LABEL_UPDATE']
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
