-- Preserve the reader's interface language across the durable conversation
-- queue. Nullable keeps already-accepted tasks valid; workers fall back to the
-- trip title locale for those legacy rows.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS conversation_locale varchar(8);

ALTER TABLE agent_task_runs
  DROP CONSTRAINT IF EXISTS agent_task_runs_conversation_locale_check;
ALTER TABLE agent_task_runs
  ADD CONSTRAINT agent_task_runs_conversation_locale_check
  CHECK (conversation_locale IS NULL OR conversation_locale IN ('en', 'zh'));
