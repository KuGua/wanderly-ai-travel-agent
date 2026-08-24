---
name: observability-overview
source-of-truth: ./
applies-to: [all services, all skill invocations, all LLM calls, all bookings]
---

# `apps/api/src/observability/`

The `observability/` directory owns three cross-cutting concerns: **bounded
metrics** (no high-cardinality labels), **structured logging redaction**
(Pino paths + an in-memory helper), and **agent run records** (`agent_runs`
rows plus an `AGENT_RUN` audit event per LLM attempt). Anything sensitive
must go through these; nothing else.

## Files

| File | Purpose | See |
| --- | --- | --- |
| `metrics.ts` | In-process `MetricsRegistry` with 6 counters + 1 histogram. Bounded labels via `MetricLabelError`. | [§Metrics](#metrics) |
| `telemetry.ts` | Pino instance with `LOGGER_REDACTION`, `correlationChild`, `FastifyRequest` augmentation for `rawBody` + `correlationId`. | [§Log redaction](#log-redaction) |
| `redaction.ts` | Generic `redact(value, opts)` walker with default depth=4 and `DEFAULT_REDACT_KEYS`. | [§Log redaction](#log-redaction) |
| `agent-runs.ts` | `recordAgentRun({...})` writes `agent_runs` + an `AGENT_RUN` audit event. | [§Agent runs](#agent-runs) |

## Metrics

### Series registry

Each series is registered at module load with an `allowedLabels` allow-list.
Any `metrics.inc(name, labels)` call that uses an unknown label key, an
unexpected set of keys, or a label value outside the allow-list throws
`MetricLabelError`. The label key set is checked against
`FORBIDDEN_LABEL_KEYS` (13 high-cardinality identifiers — see
[observability/metrics.ts:30-34](../../src/observability/metrics.ts)).

### Series

| metric | type | labels | allowed values |
| --- | --- | --- | --- |
| `agent_skill_runs_total` | counter | operation, outcome | operation ∈ `["profile","consent","research","readiness","planning","review","confirmation","booking"]`; outcome ∈ `["success","failure","rejected","timeout","fallback"]` |
| `plan_validation_failures_total` | counter | validationResult | `["schema","authorization","route","provenance","evidence","unknown"]` |
| `provider_fallback_total` | counter | provider, outcome | provider ∈ `["openai","gemini","openai-compatible","mock"]`; outcome ∈ `["TIMEOUT","SCHEMA_PARSE","NETWORK","UPSTREAM_5XX","UPSTREAM_FAILURE","UNKNOWN"]` |
| `booking_gate_denials_total` | counter | errorCategory | `["callback_auth","membership","quorum","plan_state","unknown"]` |
| `callback_verifications_total` | counter | callbackResult | `["valid","missing_header","malformed_timestamp","expired","bad_signature","configuration_error"]` |
| `booking_callback_outcomes_total` | counter | callbackResult | `["processed","duplicate","failed"]` |
| `llm_request_latency_ms` | histogram | provider, outcome | provider ∈ `["openai","gemini","openai-compatible","mock"]`; outcome ∈ `["success"]`; buckets = `[50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000]` ms |

`MetricProvider` is the type alias for the `provider` label:
`"openai" \| "gemini" \| "openai-compatible" \| "mock"`.

### Render

`metrics.render()` returns a Prometheus text-format dump. The
`/metrics` route in `app.ts` returns it with content type
`text/plain; version=0.0.4; charset=utf-8`. `metrics.reset()` clears all
samples and is used by tests.

## Log redaction

### Pino paths (`telemetry.ts:4-36`)

`LOGGER_REDACT_PATHS` is a 31-entry string list array. that Pino replaces with
`"[REDACTED]"` at log time. Categories (verbatim):

- `req.headers.authorization`, `cookie`, `x-api-key`, `x-sandbox-signature`
- `req.body.password`, `secret`, `apiKey`, `accessToken`, `refreshToken`,
  `passportNumber`, `documentNumber`, `nationality`, `dateOfBirth`, `prompt`,
  `privateConversation`, `memberPreferences`
- `req.body.*.passportNumber`, `documentNumber`, `nationality`, `dateOfBirth`
- `res.headers['set-cookie']`
- `res.body.passportNumber`, `documentNumber`, `nationality`, `dateOfBirth`,
  `violations`
- `err.config.headers.authorization`, `x-api-key`
- `err.request.headers.authorization`, `x-sandbox-signature`
- `err.response.data`

### In-memory walker (`redaction.ts`)

`redact(value, { depth = 4, keys = DEFAULT_REDACT_KEYS })`:

- Default key regex: `DEFAULT_REDACT_KEYS = /^(passportNumber|dateOfBirth|nationality)$/i`.
- Cycles collapse to `[REDACTED]`.
- Class instances / `Date` / `Buffer` collapse to `[REDACTED]`.
- Depth limit prevents unbounded payloads from leaking via a single log line.

`whitelistSummary` in `services/audit-service.ts` is a stricter variant
that **throws** instead of redacting on sensitive keys. See
[../../services/AUDIT.md](../../services/AUDIT.md).

### Correlation binding

`correlationChild(base, correlationId)` returns
`base.child({ correlationId })` so every request-bound log line carries the
correlation ID. `app.ts` wires this on `onRequest`.

## Agent runs

`recordAgentRun({ ctx, skillName, agentName, modelName, promptVersion,
outputHash, latencyMs, status, errorCode?, tokens? })` inserts one row into
`agent_runs` then writes an `audit_events` row with `action: "AGENT_RUN"`.

Schema (from `db/schema.ts:258-271`):

```text
agent_runs(
  id uuid PK, run_id uuid NOT NULL, skill_name varchar, agent_name varchar,
  model_name varchar, prompt_version varchar, output_hash varchar,
  latency_ms int, status varchar, error_code varchar NULL,
  tokens jsonb NULL, created_at timestamptz DEFAULT now()
)
```

`status` values: `"SUCCESS" \| "FALLBACK" \| "TIMEOUT" \| "ERROR"`.

The LLM gateway is the only caller today (see
[../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md)). `tokenUsage`
shape: `{ prompt, completion, total }`.

## Consumers

- `metrics.inc` is called from `agents/skill-registry.ts`,
  `providers/llm-gateway.ts`, `routes/bookings.ts`, and `policy/*` (rejections).
- `pinoInstance` is wired into `app.ts` (`Fastify({ logger: pinoInstance })`),
  used by `utils/logger.ts` (re-export), and read by `middleware/*`.
- `recordAgentRun` is called from `providers/llm-gateway.ts` only.

## Verification

- `npx vitest run tests/observability-hardening.test.ts` — covers logger
  redaction and bounded metric labels.
- `npx vitest run tests/llm-gateway.test.ts` — covers
  `provider_fallback_total` and `llm_request_latency_ms` increments.
- `npx vitest run tests/audit-whitelist.test.ts` — covers
  `whitelistSummary` (the audit-side stricter variant).