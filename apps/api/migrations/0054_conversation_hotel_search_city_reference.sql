-- 0054 — Let the stored city be the city the resolver accepts
--
-- 0053 declared `city_code` as VARCHAR(3) because the draft schema then
-- accepted only an IATA code. The draft was widened to take a city name as
-- well — which is what the location resolver had always accepted, and what
-- the hotel tool's own description invites the model to send — but the column
-- was not, so the two disagreed.
--
-- The failure was quiet and looked like something else entirely. A two-
-- character Chinese name fit and worked; "Shanghai" or "Kyoto" overflowed,
-- Postgres rejected the write about six milliseconds in, and because a tool
-- dispatch error aborted the whole turn the traveller was told the assistant
-- could not reach the conversation model. Nothing in that message pointed at
-- a column width.
--
-- 64 matches `cityReferenceSchema` in apps/api/src/types/schemas.ts. Widening
-- a varchar rewrites no rows and takes no table rewrite lock.

ALTER TABLE conversation_hotel_search_states
  ALTER COLUMN city_code TYPE VARCHAR(64);
