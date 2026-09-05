ALTER TABLE destination_cue_candidates
  ADD COLUMN IF NOT EXISTS candidate_intent varchar(48) NOT NULL DEFAULT 'DESTINATION_INTEREST',
  ADD COLUMN IF NOT EXISTS trigger_context varchar(48) NOT NULL DEFAULT 'CITY_EXPLORATION';

ALTER TABLE destination_cue_candidates
  DROP CONSTRAINT IF EXISTS destination_cue_candidates_candidate_intent_check,
  ADD CONSTRAINT destination_cue_candidates_candidate_intent_check
    CHECK (candidate_intent IN ('DESTINATION_INTEREST', 'EXPLICIT_SET_DESTINATION'));

ALTER TABLE destination_cue_candidates
  DROP CONSTRAINT IF EXISTS destination_cue_candidates_trigger_context_check,
  ADD CONSTRAINT destination_cue_candidates_trigger_context_check
    CHECK (trigger_context IN (
      'BARE_CITY',
      'CITY_EXPLORATION',
      'FLIGHT_DESTINATION',
      'HOTEL_DESTINATION',
      'EXPLICIT_DESTINATION_COMMAND'
    ));

CREATE TABLE IF NOT EXISTS destination_cue_prompt_policies (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  cooldown_until timestamptz,
  dismissal_day varchar(10),
  daily_dismissal_count integer NOT NULL DEFAULT 0 CHECK (daily_dismissal_count >= 0),
  muted_until timestamptz,
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id, trip_id)
);

CREATE INDEX IF NOT EXISTS destination_cue_prompt_policies_trip_idx
  ON destination_cue_prompt_policies(trip_id, owner_user_id);
