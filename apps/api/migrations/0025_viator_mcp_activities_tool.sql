-- Provider-neutral activities.search backed by Viator's official public MCP.
-- No API key, raw provider payload, click-off link, or currency-less price is
-- persisted by this migration or its application code.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ACTIVITIES_SEARCH_REQUESTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ACTIVITIES_SEARCH_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ACTIVITIES_SEARCH_UNAVAILABLE';

ALTER TABLE provider_search_runs
  ALTER COLUMN destination_id TYPE varchar(128);
