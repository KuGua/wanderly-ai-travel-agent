CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  skill_name VARCHAR(128) NOT NULL,
  agent_name VARCHAR(32) NOT NULL,
  model_name VARCHAR(128) NOT NULL,
  prompt_version VARCHAR(64) NOT NULL,
  output_hash VARCHAR(64) NOT NULL,
  latency_ms INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(64),
  tokens JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_runs_skill_idx ON agent_runs(skill_name);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status);