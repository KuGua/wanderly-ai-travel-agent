-- Bind Nuitee quote authorization identity to the durable task. The value
-- itself stays only in stay_search_provider_authorizations.value_encrypted.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS hotel_quote_nationality_authorization_id UUID
    REFERENCES stay_search_provider_authorizations(id),
  ADD COLUMN IF NOT EXISTS hotel_quote_nationality_authorization_version INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_task_runs_hotel_quote_authorization_pair'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_hotel_quote_authorization_pair
      CHECK (
        (hotel_quote_nationality_authorization_id IS NULL AND hotel_quote_nationality_authorization_version IS NULL)
        OR
        (hotel_quote_nationality_authorization_id IS NOT NULL AND hotel_quote_nationality_authorization_version IS NOT NULL)
      );
  END IF;
END
$$;

-- Earlier development builds used a process-local cipher key. Those values
-- cannot be safely recovered after restart, so force an explicit re-grant
-- under AWS KMS rather than attempting a plaintext or best-effort migration.
UPDATE stay_search_provider_authorizations
SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
WHERE status = 'ACTIVE';
