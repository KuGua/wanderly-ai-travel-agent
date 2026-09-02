-- 0063_conversation_trip_brief_proposal.sql
-- Keeps the extracted trip brief with the run that produced it.
--
-- The confirmation card was delivered only as a `trip.brief_proposed`
-- notification. NOTIFY is fire-and-forget and is never replayed, so a client
-- that finishes subscribing after the worker has already published simply
-- never learns the brief exists — which is what happens on a fast turn, and
-- why the card in docs/personal-and-planning-boundaries.md §9 never appeared.
-- A reload or a move between the globe and the trip workspace lost it for the
-- same reason.
--
-- This is still a candidate, not a trip fact: nothing here reaches
-- `shared_trips` until the traveller presses confirm. It lives on the run so
-- the card can be rebuilt from the resource the client already polls.

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS trip_brief_proposal JSONB;
