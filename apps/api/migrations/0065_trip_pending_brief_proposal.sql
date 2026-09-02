-- 0065_trip_pending_brief_proposal.sql
-- Moves the unconfirmed trip brief to the trip it describes.
--
-- It first lived only in a `trip.brief_proposed` notification, which is never
-- replayed, so a client that subscribed late never saw it. 0063 put it on the
-- run, which fixed that but not the rest: once the run is no longer the one
-- being polled — after a reload, or on another device — the card is gone
-- again, and the traveller is left with an assistant that extracted their trip
-- and a screen that never offers to save it.
--
-- The brief is about the trip, not about one turn, so it belongs on the trip.
-- It stays a candidate: these columns are proposals awaiting confirmation and
-- are cleared the moment the traveller confirms or ignores. The confirmed
-- values remain the `departure_cities` / `destination_candidates` /
-- `travel_date_*` columns and are only ever written by that confirmation.

ALTER TABLE shared_trips
  ADD COLUMN IF NOT EXISTS pending_brief_proposal JSONB;
