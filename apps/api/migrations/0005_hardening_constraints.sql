-- Migration: hardening unique constraints + audit correlation lookup.
-- Idempotent: every index is created with IF NOT EXISTS so the migration
-- runner (db/migrate.ts) can replay this file safely. On populated dev
-- databases run the pre-flight dedup documented in
-- docs/mvp-readiness-review.md before applying; production deployments
-- must follow a hand-curated data migration.

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_user_id_unique
  ON user_profiles(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS trip_members_trip_user_unique
  ON trip_members(trip_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS constraint_snapshots_trip_version_unique
  ON constraint_snapshots(trip_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS itinerary_plans_trip_version_unique
  ON itinerary_plans(trip_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS member_confirmations_plan_user_unique
  ON member_confirmations(plan_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS booking_executions_orchestration_request_id_unique
  ON booking_executions(orchestration_request_id);

CREATE INDEX IF NOT EXISTS audit_events_correlation_id_idx
  ON audit_events(correlation_id);

-- Enum gap fix: schema.ts declares VISA_CHECK and PLAN_RESTART, but the
-- runtime Postgres enum (created in 0001) does not include them. ALTER
-- TYPE ADD VALUE cannot run inside a transaction, so wrap each in
-- DO $$ ... EXCEPTION WHEN OTHERS THEN NULL (same idiom as
-- 0004_skill_invoke_audit.sql). Idempotent on replay.
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'VISA_CHECK';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_RESTART';
EXCEPTION WHEN OTHERS THEN NULL; END $$;
