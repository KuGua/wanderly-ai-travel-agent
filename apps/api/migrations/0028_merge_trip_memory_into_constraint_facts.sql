-- Merges trip_memory_facts into trip_constraint_facts so trip-scoped memory
-- has one table and one snapshot projection.
--
-- Two models met on the same concept: the team-orchestration constraints
-- (visibility + strength, unique per trip/owner/field) and the long-term memory
-- overrides and group decisions (docs/long-term-memory-implementation.md §4.3,
-- where a group decision is unique per trip/field regardless of who saved it).
--
-- A `kind` discriminator lets both uniqueness rules hold in one table. Existing
-- rows keep the constraint behaviour they already had.
--
-- Replayable: every statement is guarded so re-running the file is a no-op.

DO $$ BEGIN
  CREATE TYPE trip_constraint_kind AS ENUM (
    'MEMBER_CONSTRAINT',   -- team-orchestration constraint (pre-existing rows)
    'PERSONAL_OVERRIDE',   -- this-trip preference, owner-private until consent
    'GROUP_DECISION'       -- whole-group decision, one per trip/field
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE trip_constraint_facts
  ADD COLUMN IF NOT EXISTS kind trip_constraint_kind NOT NULL DEFAULT 'MEMBER_CONSTRAINT';

-- Active uniqueness is now per kind. The original index spanned every row, so
-- once the table holds more than one kind it over-constrains: a member could
-- not hold both an orchestration constraint and a personal override on the same
-- field. Each kind keeps exactly the rule it had on its own table.
DROP INDEX IF EXISTS trip_constraint_facts_active_unique;

CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_facts_member_active_unique
  ON trip_constraint_facts (trip_id, owner_user_id, field_key)
  WHERE status = 'ACTIVE' AND kind = 'MEMBER_CONSTRAINT';

CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_facts_override_active_unique
  ON trip_constraint_facts (trip_id, owner_user_id, field_key)
  WHERE status = 'ACTIVE' AND kind = 'PERSONAL_OVERRIDE';

-- A group decision belongs to the trip, not to whoever recorded it.
CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_facts_group_decision_unique
  ON trip_constraint_facts (trip_id, field_key)
  WHERE status = 'ACTIVE' AND kind = 'GROUP_DECISION';

-- Sensitive form-only fields can never be a whole-group decision.
DO $$ BEGIN
  ALTER TABLE trip_constraint_facts
    ADD CONSTRAINT trip_constraint_facts_group_not_sensitive
    CHECK (
      kind <> 'GROUP_DECISION'
      OR field_key NOT IN ('nationality', 'date_of_birth', 'mobility_notes', 'passport_number')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Carry over anything already written to the short-lived memory table. Values
-- are wrapped because trip_constraint_facts.value_json is an object while
-- memory values may be scalars or arrays.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'trip_memory_facts') THEN
    INSERT INTO trip_constraint_facts (
      trip_id, owner_user_id, field_key, value_json, value_hash,
      strength, visibility, revision, status, kind, created_at
    )
    SELECT
      m.trip_id,
      m.owner_user_id,
      m.field_key,
      jsonb_build_object('value', m.field_value),
      encode(sha256(jsonb_build_object('value', m.field_value)::text::bytea), 'hex'),
      'SOFT',
      CASE WHEN m.kind = 'GROUP_DECISION' THEN 'TEAM_VISIBLE' ELSE 'ORCHESTRATOR_CONFIDENTIAL' END::constraint_visibility,
      1,
      m.status::text,
      m.kind::text::trip_constraint_kind,
      m.created_at
    FROM trip_memory_facts m
    WHERE m.status = 'ACTIVE'
    ON CONFLICT DO NOTHING;

    DROP TABLE trip_memory_facts;
  END IF;
END $$;

DROP TYPE IF EXISTS trip_memory_kind;
DROP TYPE IF EXISTS trip_memory_source;
DROP TYPE IF EXISTS trip_memory_status;
