CREATE TABLE IF NOT EXISTS prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  version VARCHAR(64) NOT NULL,
  template_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT prompt_versions_name_version_unique UNIQUE (name, version)
);