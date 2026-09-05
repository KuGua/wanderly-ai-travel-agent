-- Flight / Hotel Offer Cue state machine. Personal-only; never touches
-- shared_trips.constraint_snapshot, never triggers Shared agent replan,
-- never grants booking authority. Phase 1 strictly DRAFT Trip creator's
-- private thread.

DO $$ BEGIN CREATE TYPE offer_cue_batch_status AS ENUM ('OPEN','RESOLVED','SUPERSEDED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE offer_cue_candidate_status AS ENUM ('PENDING','ACCEPTED','DISMISSED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE offer_cue_candidate_intent AS ENUM ('EXPLICIT_SELECT','STRONG_PREFERENCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE personal_offer_selection_status AS ENUM ('ACTIVE','SUPERSEDED','EXPIRED','REMOVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS offer_cue_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid NOT NULL UNIQUE REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability offer_cue_capability NOT NULL,
  source_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  offer_set_id uuid NOT NULL,
  model_version varchar(128) NOT NULL,
  prompt_version varchar(64) NOT NULL,
  status offer_cue_batch_status NOT NULL DEFAULT 'OPEN',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One OPEN batch per (thread, capability) so Flight and Hotel can both be
-- OPEN simultaneously but never two of the same capability on one thread.
CREATE UNIQUE INDEX IF NOT EXISTS offer_cue_batches_one_open_per_thread_cap
  ON offer_cue_batches(thread_id, capability) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS offer_cue_batches_owner_thread_idx
  ON offer_cue_batches(owner_user_id, thread_id, capability, created_at DESC);

CREATE TABLE IF NOT EXISTS offer_cue_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES offer_cue_batches(id) ON DELETE CASCADE,
  personal_offer_candidate_id uuid NOT NULL REFERENCES personal_research_offer_candidates(id) ON DELETE CASCADE,
  intent offer_cue_candidate_intent NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 5),
  status offer_cue_candidate_status NOT NULL DEFAULT 'PENDING',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, ordinal),
  UNIQUE(batch_id, personal_offer_candidate_id)
);
CREATE INDEX IF NOT EXISTS offer_cue_candidates_batch_status_idx
  ON offer_cue_candidates(batch_id, status, ordinal);

CREATE TABLE IF NOT EXISTS offer_cue_prompt_policies (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  capability offer_cue_capability NOT NULL,
  cooldown_until timestamptz,
  dismissal_day varchar(10),
  daily_dismissal_count integer NOT NULL DEFAULT 0 CHECK (daily_dismissal_count >= 0),
  muted_until timestamptz,
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id, trip_id, capability)
);
CREATE INDEX IF NOT EXISTS offer_cue_prompt_policies_trip_idx
  ON offer_cue_prompt_policies(trip_id, owner_user_id, capability);

CREATE TABLE IF NOT EXISTS personal_offer_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  capability offer_cue_capability NOT NULL,
  personal_offer_candidate_id uuid NOT NULL REFERENCES personal_research_offer_candidates(id) ON DELETE CASCADE,
  scope_key varchar(64) NOT NULL,
  status personal_offer_selection_status NOT NULL DEFAULT 'ACTIVE',
  selected_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one ACTIVE selection per (trip, owner, capability, scope_key).
-- Prefer btree_gist-backed EXCLUDE constraint for a single round-trip
-- conflict check; fall back to a partial unique index where the extension
-- is not installed. Application code still locks the scope row FOR UPDATE
-- before insert/update to close the race window in the fallback path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    EXECUTE $e$
      ALTER TABLE personal_offer_selections
        ADD CONSTRAINT personal_offer_selections_scope_active_unique
        EXCLUDE (trip_id WITH =, owner_user_id WITH =, capability WITH =, scope_key WITH =)
        WHERE (status = 'ACTIVE')
    $e$;
  ELSE
    EXECUTE $e$
      CREATE UNIQUE INDEX IF NOT EXISTS personal_offer_selections_scope_active_unique
        ON personal_offer_selections(trip_id, owner_user_id, capability, scope_key)
        WHERE status = 'ACTIVE'
    $e$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS personal_offer_selections_trip_idx
  ON personal_offer_selections(trip_id, owner_user_id, capability, status);
CREATE INDEX IF NOT EXISTS personal_offer_selections_candidate_idx
  ON personal_offer_selections(personal_offer_candidate_id);
