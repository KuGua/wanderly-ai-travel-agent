-- 0056 — One evidence row per search, not per run
--
-- 0049 gave this table two unique indexes. Both were aimed at something real
-- and both were too strong once a conversation turn became a run.
--
-- `(run_id, owner_user_id)` was never meant to limit how many rows a run may
-- have; its comment says it exists so every row's owner matches the run's
-- creator. Uniqueness does enforce that — by allowing exactly one row per run.
-- The invariant it protects is already enforced at the executor boundary in
-- `personal-research-service.ts`, which is where that comment says it lives, so
-- the index only costs correctness and is dropped.
--
-- `(run_id, capability)` was for retry idempotency: a durable research task
-- that runs twice should not write two rows. A conversation turn is also one
-- run, and in a turn a traveller can ask two things at once — "附近有什么餐厅
-- 吗？有什么好玩的景点吗" is two `places.search` calls. The second one ran,
-- spent supplier quota, then failed to insert; the dispatcher reported that as
-- UPSTREAM_FAILURE and the assistant told the traveller the supplier was down.
--
-- Identity is the search, not the run: same run, same capability, same query
-- is a retry and still collapses. `request_fingerprint` is a hash of the
-- canonicalised draft, written by the service. Existing rows take '' — they
-- predate the column and each is already the only row on its run.

ALTER TABLE personal_research_evidence
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS personal_research_evidence_run_owner_unique;

ALTER TABLE personal_research_evidence
  DROP CONSTRAINT IF EXISTS personal_research_evidence_run_capability_unique;
DROP INDEX IF EXISTS personal_research_evidence_run_capability_unique;

CREATE UNIQUE INDEX IF NOT EXISTS personal_research_evidence_run_search_unique
  ON personal_research_evidence (run_id, capability, request_fingerprint);
