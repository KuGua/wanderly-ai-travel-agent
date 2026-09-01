-- 0054 — Durable private-conversation flight search readiness
--
-- Mirrors 0053 (hotel) for the `flight.search` capability: stores only typed
-- flight query fields plus the explicit confirmation marker. It is keyed by
-- private thread, cascades with the thread, and is never a shared Trip
-- constraint, provider result, or source of booking authority.

CREATE TABLE IF NOT EXISTS conversation_flight_search_states (
  thread_id UUID PRIMARY KEY
    REFERENCES chat_threads(id) ON DELETE CASCADE,
  trip_id UUID NOT NULL
    REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  origin_id VARCHAR(3) NOT NULL,
  destination_id VARCHAR(3) NOT NULL,
  trip_type VARCHAR(16) NOT NULL,
  departure_date DATE NOT NULL,
  return_date DATE,
  adults INTEGER NOT NULL,
  cabin VARCHAR(32) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  confirmed_message_id UUID
    REFERENCES chat_messages(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_flight_search_states_trip_type_chk
    CHECK (trip_type IN ('ONE_WAY', 'ROUND_TRIP')),
  CONSTRAINT conversation_flight_search_states_return_date_chk
    CHECK (
      (trip_type = 'ONE_WAY')
      OR (trip_type = 'ROUND_TRIP' AND return_date IS NOT NULL AND return_date >= departure_date)
    ),
  CONSTRAINT conversation_flight_search_states_adults_chk
    CHECK (adults BETWEEN 1 AND 9),
  CONSTRAINT conversation_flight_search_states_confirmation_chk
    CHECK (
      (confirmed_message_id IS NULL AND confirmed_at IS NULL)
      OR (confirmed_message_id IS NOT NULL AND confirmed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS conversation_flight_search_states_trip_owner_idx
  ON conversation_flight_search_states(trip_id, owner_user_id);
