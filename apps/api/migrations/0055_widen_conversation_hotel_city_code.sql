-- 0055 — Widen conversation_hotel_search_states.city_code
--
-- The hotel draft schema's cityCode field (cityReferenceSchema) accepts an
-- IATA city code OR a city name up to 64 chars, matching what the location
-- resolver actually resolves ("Kyoto", "京都", "UKY"). The VARCHAR(3) column
-- here predates that widening and silently failed the INSERT for any
-- name-form city, surfacing as a misclassified UPSTREAM_5XX with the real
-- cause (a DB error) hidden behind that generic label.

ALTER TABLE conversation_hotel_search_states
  ALTER COLUMN city_code TYPE VARCHAR(64);
