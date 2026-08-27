-- Trip-scoped private conversation threads.
--
-- Post-implementation invariants enforced here:
--   * chat_threads.scope has only one legal value ('TRIP'); non-Trip
--     threads do not exist.  Adding new scopes later requires a schema
--     change; do not pre-extend.
--   * chat_threads.trip_id is NOT NULL — every active thread belongs to
--     exactly one shared trip.
--   * chat_threads.is_default + the partial unique index guarantee that
--     each (owner_user_id, trip_id) pair has at most one active default
--     thread, used as the per-member scratchpad.
--   * chat_threads.is_default true is set ONLY by invitation acceptance
--     provisioning (or by the idempotent get-or-create route); the
--     regular create route always writes false.
--   * trip_invitations.token_hash stores SHA-256 only; the raw token is
--     returned exactly once at creation.

DO $$ BEGIN
  CREATE TYPE chat_thread_scope AS ENUM ('TRIP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_invitation_status AS ENUM (
    'PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── chat_threads: enforce Trip-only ownership ─────────────────────────────

ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS scope chat_thread_scope NOT NULL DEFAULT 'TRIP';

ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- Fail-fast: legacy rows without a trip binding cannot be silently
-- backfilled.  Operators must run a documented data migration first.
DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT count(*) INTO orphan_count FROM chat_threads WHERE trip_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'chat_threads migration aborted: % rows still have NULL trip_id. '
      'Archive or assign them to a real trip before re-running.', orphan_count;
  END IF;
END $$;

ALTER TABLE chat_threads
  ALTER COLUMN trip_id SET NOT NULL;

-- One active default thread per (owner, trip).  Archived rows are
-- excluded so a future re-creation (after archive) is permitted.
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_one_active_default_per_member_trip
  ON chat_threads (owner_user_id, trip_id)
  WHERE is_default = true AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_threads_trip_owner_active_idx
  ON chat_threads (trip_id, owner_user_id, created_at DESC)
  WHERE archived_at IS NULL;

-- ─── trip_invitations ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trip_invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id             uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  invited_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status              trip_invitation_status NOT NULL DEFAULT 'PENDING',
  token_hash          varchar(128) NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_invitation_status_timestamps CHECK (
    (status = 'ACCEPTED') = (accepted_at IS NOT NULL)
  )
);

-- One open invitation per (trip, invitee) at any time.
CREATE UNIQUE INDEX IF NOT EXISTS trip_invitations_one_pending_invitee
  ON trip_invitations (trip_id, invited_user_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS trip_invitations_accept_lookup_idx
  ON trip_invitations (token_hash, status, expires_at);

-- ─── Audit enum gap fill ───────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_INVITATION_CREATE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_INVITATION_ACCEPT';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_INVITATION_REVOKE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_DEFAULT_THREAD_PROVISION';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ─── Tighten agent_task_runs operation refs ───────────────────────────────
--
-- Post-migration, CONVERSATION tasks always carry the thread's trip_id
-- so downstream layers (audit summary, observability) can correlate the
-- run with a Trip without joining chat_threads.  PLAN / REPLAN still bind
-- only to a trip + snapshot.  Drop + recreate the existing check.
ALTER TABLE agent_task_runs DROP CONSTRAINT IF EXISTS agent_task_runs_operation_refs_check;

ALTER TABLE agent_task_runs ADD CONSTRAINT agent_task_runs_operation_refs_check CHECK (
  (operation = 'CONVERSATION' AND thread_id IS NOT NULL AND user_message_id IS NOT NULL
    AND trip_id IS NOT NULL AND snapshot_id IS NULL)
  OR
  (operation IN ('PLAN', 'REPLAN') AND trip_id IS NOT NULL AND snapshot_id IS NOT NULL
    AND thread_id IS NULL AND user_message_id IS NULL)
);

