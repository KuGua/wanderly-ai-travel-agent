-- Owner-only opaque candidate identity for Flight/Hotel Offer Cue.
-- Bounded projection of provider results that the user has actually seen;
-- the browser sees opaque `candidateRef` only — never providerOfferId, raw
-- payload, coordinates, or PII. `visible_before_message_sequence` is the
-- upper-bound `chat_messages.message_sequence` of the assistant message
-- that streamed this offer set; the cue resolver excludes candidates whose
-- visible_before_message_sequence is >= the user's current message sequence
-- so the model never sees offers the traveller has not actually seen.

DO $$ BEGIN
  CREATE TYPE offer_cue_capability AS ENUM ('flight', 'hotel');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS personal_research_offer_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES personal_research_evidence(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability offer_cue_capability NOT NULL,
  offer_set_id uuid NOT NULL,
  route_key varchar(64),
  stay_key varchar(64),
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 5),
  normalized_offer_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  visible_before_message_sequence bigint NOT NULL CHECK (visible_before_message_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_research_offer_candidates_capability_key_check CHECK (
    (capability = 'flight' AND route_key IS NOT NULL AND stay_key IS NULL)
    OR (capability = 'hotel'  AND stay_key  IS NOT NULL AND route_key IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS personal_research_offer_candidates_set_ord
  ON personal_research_offer_candidates(offer_set_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS personal_research_offer_candidates_set_route
  ON personal_research_offer_candidates(offer_set_id, route_key)
  WHERE capability = 'flight' AND route_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS personal_research_offer_candidates_set_stay
  ON personal_research_offer_candidates(offer_set_id, stay_key)
  WHERE capability = 'hotel' AND stay_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS personal_research_offer_candidates_trip_idx
  ON personal_research_offer_candidates(trip_id, capability, created_at DESC);
CREATE INDEX IF NOT EXISTS personal_research_offer_candidates_expires_idx
  ON personal_research_offer_candidates(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS personal_research_offer_candidates_evidence_idx
  ON personal_research_offer_candidates(evidence_id);
