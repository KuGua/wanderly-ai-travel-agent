-- 0053 — Durable private-conversation hotel search readiness
--
-- Stores only typed hotel query fields plus the explicit confirmation marker.
-- It is keyed by private thread, cascades with the thread, and is never a
-- shared Trip constraint, provider result, or source of booking authority.

CREATE TABLE IF NOT EXISTS conversation_hotel_search_states (
  thread_id UUID PRIMARY KEY
    REFERENCES chat_threads(id) ON DELETE CASCADE,
  trip_id UUID NOT NULL
    REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  city_code VARCHAR(3) NOT NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  adults INTEGER NOT NULL,
  rooms INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  confirmed_message_id UUID
    REFERENCES chat_messages(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_hotel_search_states_dates_chk
    CHECK (check_out > check_in),
  CONSTRAINT conversation_hotel_search_states_occupancy_chk
    CHECK (adults BETWEEN 1 AND 8 AND rooms BETWEEN 1 AND 8),
  CONSTRAINT conversation_hotel_search_states_confirmation_chk
    CHECK (
      (confirmed_message_id IS NULL AND confirmed_at IS NULL)
      OR (confirmed_message_id IS NOT NULL AND confirmed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS conversation_hotel_search_states_trip_owner_idx
  ON conversation_hotel_search_states(trip_id, owner_user_id);
