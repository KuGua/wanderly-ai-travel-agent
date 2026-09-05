-- Durable, member-authorized replay journal for Agent SSE. Payloads are the
-- same private run events already delivered over SSE; they must never be
-- copied to logs, metrics, or traces.
CREATE TABLE IF NOT EXISTS agent_stream_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_stream_events_run_id_id_idx
  ON agent_stream_events(run_id, id);
