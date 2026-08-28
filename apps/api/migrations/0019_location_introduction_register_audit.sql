-- S4 admin registration adds a new audit action. Enum ADD VALUE
-- must run outside a transaction; we wrap each in DO $$ to keep the
-- script re-runnable against partially-migrated databases.
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'LOCATION_INTRODUCTION_REGISTER';
EXCEPTION WHEN OTHERS THEN NULL; END $$;