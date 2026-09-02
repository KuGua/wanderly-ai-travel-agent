-- 0064_backfill_missing_user_profiles.sql
-- Gives every existing account the profile row registration used to skip.
--
-- Registration only ever inserted into `users`, so accounts created through it
-- had no `user_profiles` row. `GET /profiles/me` returned null, the Travel
-- preference page had nothing to edit, and the traveller could never record a
-- nationality — which meant hotel quotes could not be authorized and their
-- trips could not be planned. Registration now creates the row; this covers
-- everyone who registered before it did.
--
-- The rows are empty on purpose. A profile row is somewhere to put preferences,
-- not a claim that any were stated, so nothing is projected into memory here.

INSERT INTO user_profiles (user_id)
SELECT u.id
FROM users u
LEFT JOIN user_profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL;
