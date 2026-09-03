-- Repairs `research_route_selections.mode` where it is missing.
--
-- 0041 creates the table with `CREATE TABLE IF NOT EXISTS`, so any schema that
-- already had an earlier shape of the table kept that shape and 0041 silently
-- did nothing — while `schema_migrations` still recorded it as applied. The
-- `travelagent_test` schema reached exactly that state (its ledger was
-- back-filled by `scripts/sync-migrations-ledger.ts`), so every insert into the
-- table failed with 42703 and two suites were red for a reason that had nothing
-- to do with the code under test.
--
-- Written to be a no-op where the column already exists, so it is safe on
-- `public` and on any teammate's database.
DO $$
BEGIN
  IF to_regclass('research_route_selections') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('research_route_selections')
      AND attname = 'mode'
      AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE research_route_selections ADD COLUMN mode navigation_route_mode;

  -- A selected transport mode cannot be guessed, and inventing one would put
  -- fabricated routing data in front of a traveller. Everywhere the table was
  -- created correctly the column has been NOT NULL since 0041, so rows without
  -- one should not exist. If any do, stop and let a person look rather than
  -- pick a value or delete their rows.
  IF EXISTS (SELECT 1 FROM research_route_selections WHERE mode IS NULL) THEN
    RAISE EXCEPTION
      'research_route_selections has % row(s) with no mode; refusing to invent a transport mode',
      (SELECT count(*) FROM research_route_selections WHERE mode IS NULL);
  END IF;

  ALTER TABLE research_route_selections ALTER COLUMN mode SET NOT NULL;
END $$;
