-- 0060 — Whether a member has been shown this trip's preference card
--
-- The card offers the traveller their profile preferences as this trip's
-- starting point, once, the first time they open a chat in it. Most people
-- will close it — inheriting the profile is usually right — so "has an
-- override" cannot stand in for "has seen it": that would show the card again
-- on every visit until they changed something, which is nagging, not offering.
--
-- Per member, not per trip: each member of a shared trip has their own
-- profile to inherit from and their own moment of being asked.

CREATE TABLE IF NOT EXISTS trip_preference_card_views (
  trip_id UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);
