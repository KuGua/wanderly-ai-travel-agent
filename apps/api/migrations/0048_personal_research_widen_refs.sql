-- 0047b — DRAFT Personal Research: widen refs CHECK + add owner-only partial unique.
--
-- Runs after 0047a so the new `PERSONAL_RESEARCH` enum value is visible to all
-- objects below. Idempotent: each ALTER uses IF EXISTS / IF NOT EXISTS
-- guards and the constraint drops are scoped by name.
--
-- PERSONAL_RESEARCH semantics (docs/draft-personal-research-implementation.md §3.2):
--   * `trip_id IS NOT NULL` — every Personal Session is bound to a Trip.
--   * `thread_id IS NOT NULL` — Personal Session = chat_threads row.
--   * `snapshot_id IS NULL` — Personal Research never touches Shared snapshot.
--   * `user_message_id IS NULL` — confirm is not a chat turn; we don't write
--     a USER chat_messages row (avoids polluting the private thread).
--   * `created_by_user_id` IS the owner (owner-only invariant); the new
--     partial unique uses it as the idempotency key.

-- ─── Widen operation_refs_check to admit PERSONAL_RESEARCH ────────────────
ALTER TABLE agent_task_runs
  DROP CONSTRAINT IF EXISTS agent_task_runs_operation_refs_check;

ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_operation_refs_check CHECK (
    (operation = 'CONVERSATION' AND thread_id IS NOT NULL AND user_message_id IS NOT NULL
      AND trip_id IS NOT NULL AND snapshot_id IS NULL)
    OR
    (operation IN ('PLAN', 'REPLAN', 'RESEARCH') AND trip_id IS NOT NULL AND snapshot_id IS NOT NULL
      AND thread_id IS NULL AND user_message_id IS NULL)
    OR
    (operation = 'PERSONAL_RESEARCH' AND trip_id IS NOT NULL AND thread_id IS NOT NULL
      AND snapshot_id IS NULL AND user_message_id IS NULL)
  );

-- ─── Partial unique for owner idempotency on PERSONAL_RESEARCH ────────────
-- Owner-only — key by created_by_user_id (the creator == the owner for this
-- operation; enforced at the handler boundary and asserted again at
-- `requireRunAccess`). Distinct from the `(tripId, requestId)` index used by
-- PLAN/REPLAN/RESEARCH because the same owner may have multiple concurrent
-- drafts, but the same `(owner, requestId)` pair may NOT both confirm.
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_runs_personal_research_owner_request_unique
  ON agent_task_runs (created_by_user_id, request_id)
  WHERE operation = 'PERSONAL_RESEARCH';