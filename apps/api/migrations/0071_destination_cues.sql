-- Owner-only, model-assisted destination confirmation cues.
-- Candidate text is canonicalized before persistence; no private message,
-- prompt, assistant reply, coordinates or free-form model rationale is stored.

DO $$ BEGIN
  CREATE TYPE destination_cue_batch_status AS ENUM
    ('OPEN', 'RESOLVED', 'SUPERSEDED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE destination_cue_candidate_status AS ENUM
    ('PENDING', 'ACCEPTED', 'DISMISSED', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'DESTINATION_CUE_ACCEPT';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'DESTINATION_CUE_DISMISS';

CREATE TABLE IF NOT EXISTS destination_cue_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid NOT NULL UNIQUE REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status destination_cue_batch_status NOT NULL DEFAULT 'OPEN',
  model_version varchar(128) NOT NULL,
  prompt_version varchar(64) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS destination_cue_batches_one_open_per_thread
  ON destination_cue_batches(thread_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS destination_cue_batches_owner_thread_idx
  ON destination_cue_batches(owner_user_id, thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS destination_cue_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES destination_cue_batches(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 5),
  canonical_city_name varchar(128) NOT NULL,
  country_code varchar(2) NOT NULL,
  candidate_key_hash varchar(64) NOT NULL CHECK (candidate_key_hash ~ '^[0-9a-f]{64}$'),
  status destination_cue_candidate_status NOT NULL DEFAULT 'PENDING',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, ordinal),
  UNIQUE(batch_id, candidate_key_hash)
);

CREATE INDEX IF NOT EXISTS destination_cue_candidates_batch_status_idx
  ON destination_cue_candidates(batch_id, status, ordinal);

CREATE TABLE IF NOT EXISTS destination_cue_suppressions (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  candidate_key_hash varchar(64) NOT NULL CHECK (candidate_key_hash ~ '^[0-9a-f]{64}$'),
  dismissed_at timestamptz NOT NULL,
  last_qualified_mention_at timestamptz NOT NULL,
  qualified_mention_count integer NOT NULL DEFAULT 0 CHECK (qualified_mention_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id, trip_id, candidate_key_hash)
);
