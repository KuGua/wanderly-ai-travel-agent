-- Repair the member-conversation handoff batch invariants.
-- `candidate_version` is a batch-level optimistic-concurrency value: every
-- proposal in a batch therefore has the same version.  The prior unique
-- index accidentally made that impossible for a multi-candidate batch.

DROP INDEX IF EXISTS trip_constraint_proposals_batch_version_unique;

CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_proposals_batch_field_unique
  ON trip_constraint_proposals (trip_id, batch_id, field_key)
  WHERE batch_id IS NOT NULL AND source_kind = 'PERSONAL_AGENT';

-- A pending handoff must retain both provenance links for confirmation. Once
-- it is terminal the private thread may be deleted; both FK actions can then
-- redact the links without violating the row constraint.
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
        OR
        (status IN ('CONFIRMED', 'DISMISSED') AND (origin_thread_id IS NULL) = (origin_run_id IS NULL))
      )
    )
  );
