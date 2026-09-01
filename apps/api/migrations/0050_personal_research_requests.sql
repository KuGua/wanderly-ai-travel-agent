-- Immutable owner-confirmed input for PERSONAL_RESEARCH. The Worker must read
-- this row, never the originating conversation's editable draft.
CREATE TABLE IF NOT EXISTS personal_research_requests (
  run_id uuid PRIMARY KEY REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  originating_intent_run_id uuid NOT NULL REFERENCES agent_task_runs(id),
  capability personal_research_capability NOT NULL,
  input_json jsonb NOT NULL,
  input_hash varchar(64) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_personal_research_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'personal_research_requests are immutable';
END;
$$;

DROP TRIGGER IF EXISTS personal_research_requests_immutable ON personal_research_requests;
CREATE TRIGGER personal_research_requests_immutable
  BEFORE UPDATE ON personal_research_requests
  FOR EACH ROW EXECUTE FUNCTION reject_personal_research_request_mutation();
