-- Gives outbox events a retry budget and a backoff.
--
-- A failing memory observation was returned to PENDING immediately, so the
-- Worker claimed the same oldest event again on the very next pass. One event
-- that can never succeed — a value the catalog will always reject, a row whose
-- user was deleted — became a hot loop that blocked every later observation and
-- starved the maintenance sweep, which only runs when the queue is empty.
--
-- `attempt_count` bounds how many times an event is retried before it is parked
-- as FAILED, and `next_attempt_at` spaces the retries out. A parked event stays
-- readable: it is a dead letter to investigate, not a deletion.
--
-- Replayable: every statement is guarded so re-running the file is a no-op.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

-- Existing rows are due immediately, which is what they already were.
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Records why an event was parked. Bounded text, never the payload: a message
-- can quote the value that failed.
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS last_error VARCHAR(128);

-- The claim scans by type and status, oldest due first.
CREATE INDEX IF NOT EXISTS outbox_events_due_idx
  ON outbox_events (event_type, status, next_attempt_at);
