-- 0070 — Audit action for private thread title writes.
-- All three sources (deterministic system generation, LLM-suggested, and
-- owner-typed manual rename) share a single audit action. The summary's
-- `source` field distinguishes them. The summary intentionally never
-- contains the title text — private thread titles are derived from private
-- conversation content and must not land in the audit log.
--
-- Guarded and schema-scoped for the same reason 0026 is: `pg_type` spans
-- the whole database, so an unqualified name would match the identically
-- named type in a sibling schema and skip the ALTER, leaving the enum short.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY['CHAT_THREAD_TITLE_UPDATE']
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
