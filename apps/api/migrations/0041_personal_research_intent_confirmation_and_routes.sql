-- 0041 — bind confirmed Personal intents and their explicit route selections.
-- Keeps execution input server-authoritative: a RESEARCH run references its
-- originating draft, while a one-to-one selection records two active places
-- and the owner-selected transport mode.

-- `0040` predates schema-scoped migration execution and may have observed a
-- same-named enum in another schema. Re-establish the type in this migration's
-- active schema so a partially upgraded database can safely continue.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
    WHERE type_row.typname = 'research_intent_state'
      AND namespace_row.nspname = current_schema()
  ) THEN
    EXECUTE format(
      'CREATE TYPE %I.research_intent_state AS ENUM (''PROPOSED'', ''DISMISSED'', ''CONFIRMED'', ''SUPERSEDED'')',
      current_schema()
    );
  END IF;
END
$$;

-- Earlier local builds created a partial draft index while the column was a
-- varchar. Drop it before converting to enum: PostgreSQL would otherwise
-- preserve a varchar cast in the predicate, which is not immutable.
DROP INDEX IF EXISTS agent_task_runs_thread_draft_proposed_idx;

ALTER TABLE agent_task_runs
  ALTER COLUMN research_intent_state TYPE research_intent_state
  USING research_intent_state::research_intent_state;

CREATE INDEX IF NOT EXISTS agent_task_runs_thread_draft_proposed_idx
  ON agent_task_runs(thread_id);

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS originating_intent_run_id uuid
  REFERENCES agent_task_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_task_runs_originating_intent_run_idx
  ON agent_task_runs(originating_intent_run_id);

CREATE TABLE IF NOT EXISTS research_route_selections (
  intent_run_id uuid PRIMARY KEY REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_place_id uuid NOT NULL REFERENCES trip_places(id) ON DELETE RESTRICT,
  destination_place_id uuid NOT NULL REFERENCES trip_places(id) ON DELETE RESTRICT,
  mode navigation_route_mode NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_route_selections_distinct_places_chk
    CHECK (origin_place_id <> destination_place_id)
);

CREATE INDEX IF NOT EXISTS research_route_selections_trip_owner_idx
  ON research_route_selections(trip_id, owner_user_id);
