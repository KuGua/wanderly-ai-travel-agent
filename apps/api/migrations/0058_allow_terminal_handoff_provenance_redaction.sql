-- Deleting chat_messages cascades the origin agent run before the thread.
-- PostgreSQL applies those FK actions one at a time, so a terminal proposal
-- can temporarily have exactly one redacted origin. Pending proposals remain
-- strict; they must always have both provenance links to be confirmable.

ALTER TABLE trip_constraint_proposals
  DROP CONSTRAINT IF EXISTS trip_constraint_proposals_origin_consistency;

ALTER TABLE trip_constraint_proposals
  ADD CONSTRAINT trip_constraint_proposals_origin_consistency
  CHECK (
    (source_kind = 'OWNER_FORM' AND origin_thread_id IS NULL AND origin_run_id IS NULL)
    OR
    (
      source_kind = 'PERSONAL_AGENT'
      AND (
        (status = 'PENDING' AND origin_thread_id IS NOT NULL AND origin_run_id IS NOT NULL)
        OR status IN ('CONFIRMED', 'DISMISSED')
      )
    )
  );
