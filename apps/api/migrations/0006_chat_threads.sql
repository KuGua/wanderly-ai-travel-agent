-- Owner-only private conversation threads. Each thread belongs to exactly
-- one user; tripId is optional and does NOT grant trip-mate access. A
-- single user may own multiple threads per trip (scratchpad vs planning
-- draft) so the (owner_user_id, trip_id) pair intentionally has no
-- UNIQUE constraint.

CREATE TABLE IF NOT EXISTS chat_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id         uuid REFERENCES shared_trips(id) ON DELETE SET NULL,
  title           varchar(256) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

CREATE INDEX IF NOT EXISTS chat_threads_owner_user_id_idx
  ON chat_threads(owner_user_id);
CREATE INDEX IF NOT EXISTS chat_threads_trip_id_idx
  ON chat_threads(trip_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id              uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                   varchar(16) NOT NULL,
  body                   text NOT NULL,                  -- owner-only; never logged/audited/shared
  redacted_summary       text,                           -- server-derived summary safe to share
  marked_shared_by_owner boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_thread_id_idx
  ON chat_messages(thread_id);

-- Audit enum gap fill: thread lifecycle actions. Same idiom as
-- 0004_skill_invoke_audit.sql and 0005_hardening_constraints.sql
-- (DO $$ ... EXCEPTION WHEN OTHERS THEN NULL END $$;): each ADD VALUE
-- runs in its own implicit single-statement transaction.
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'CHAT_THREAD_CREATE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'CHAT_THREAD_DELETE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'CHAT_MESSAGE_APPEND';
EXCEPTION WHEN OTHERS THEN NULL; END $$;
