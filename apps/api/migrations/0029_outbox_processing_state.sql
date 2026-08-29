-- Adds a PROCESSING state to the outbox so a claimed event is never lost.
--
-- Claiming used to mark a row PROCESSED up front, because PENDING/PROCESSED/
-- FAILED left nowhere to record "someone is working on this". A crash between
-- the claim and the handler therefore dropped the event silently.
--
-- With PROCESSING the claim is recoverable: a row whose claim is older than the
-- lease is picked up again. Redelivery is safe because every handler is keyed
-- by an idempotent id — a memory observation replays into DUPLICATE_EPISODE
-- rather than counting twice.
--
-- Replayable: every statement is guarded so re-running the file is a no-op.
--
-- The new value is only added here, never used. PostgreSQL allows ALTER TYPE
-- ADD VALUE inside a transaction (12+) but forbids using the value in that same
-- transaction, which is why the index below is not filtered on it.

ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'PROCESSING';

-- Supports the claim scan: oldest pending or lease-expired event of one type.
CREATE INDEX IF NOT EXISTS outbox_events_claim_idx
  ON outbox_events (event_type, status, created_at);
