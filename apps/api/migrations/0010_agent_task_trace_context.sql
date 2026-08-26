-- PR 3 (trace plan): carry the W3C trace context from the originating HTTP
-- request through the durable Worker boundary so the worker span continues
-- the same trace. The column is optional and additive; existing rows are
-- unaffected. The contract is consumed by apps/api/src/observability/tracing.ts
-- helpers (ctxFromRun, outboundTraceHeaders) and never carries prompt text,
-- credentials, or other PII — only the OTel trace identifiers.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS trace_context JSONB;

COMMENT ON COLUMN agent_task_runs.trace_context IS
  'W3C trace context carried from the originating request. Shape: { traceparent: string, tracestate?: string, correlationId: string }';