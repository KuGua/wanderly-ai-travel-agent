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
| `metrics.ts` | In-process `MetricsRegistry` with bounded-label counters and histograms, including durable Agent task outcomes, recoveries and terminal latency. | [§Metrics](#metrics) |
| `telemetry.ts` | Pino instance with `LOGGER_REDACTION`, `correlationChild`, `FastifyRequest` augmentation for `rawBody` + `correlationId`/`traceId`/`spanId`. | [§Log redaction](#log-redaction) |
| `redaction.ts` | Generic `redact(value, opts)` walker with default depth=4 and `DEFAULT_REDACT_KEYS`. | [§Log redaction](#log-redaction) |
| `tracing.ts` | OpenTelemetry bootstrap, `parseTraceparent`/`formatTraceparent`, `FORBIDDEN_SPAN_ATTRIBUTE_KEYS`, `safeSetAttribute`, `recordSpanError`. | [§Distributed tracing](#distributed-tracing) |
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

`correlationChild(base, correlationId, clientRequestId?, traceId?, spanId?)` returns
`base.child({ correlationId, clientRequestId?, trace_id?, span_id? })` so every
request-bound log line carries the correlation id and, when an OpenTelemetry
span is active, the W3C `trace_id` / `span_id` pair. `app.ts` wires this on
`onRequest`. The function reads the active span via
`apps/api/src/observability/tracing.ts#getActiveSpan`; when the SDK is
disabled or no span is active, the trace/span bindings are silently omitted.

## Distributed tracing

### Bootstrap (`tracing.ts`)

`initTracing({ serviceName?, serviceVersion? })` is idempotent and must be the
first import in both `apps/api/src/server.ts` and
`apps/api/src/workers/worker-main.ts`. It reads environment to pick:

| Env var | Default | Effect |
| --- | --- | --- |
| `OTEL_SDK_DISABLED` | unset | `true` → skip the provider entirely (no spans, no propagator registration is also skipped, so `parseTraceparent` is still safe) |
| `OTEL_TRACES_EXPORTER` | env-driven | `console` / `otlp` / `none` override the default; `in-memory` only meaningful in tests |
| `NODE_ENV` | `development` | `test` → in-memory exporter; `production` → OTLP when endpoint set, else no-op |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | when present, OTLP exporter is wired (`http/protobuf` default, `grpc` falls back to `http/protobuf`) |
| `OTEL_TRACES_SAMPLER_ARG` | `0.05` (prod only) | sample ratio for `ParentBased(TraceIdRatioBased)` in production; dev/test always on |
| `OTEL_LOG_LEVEL` | `warn` | internal SDK logger verbosity |

`shutdownTracing()` is wired to `SIGTERM` / `SIGINT` in both processes for
clean exporter flush.

### W3C trace context (`tracing.ts`)

`parseTraceparent(headerValue)` and `formatTraceparent(traceId, spanId, flags)`
implement the W3C trace-context spec verbatim — version `00`, all-zero
`traceId` / `spanId` are rejected. `newTraceId()` / `newSpanId()` mint fresh
32-hex / 16-hex ids via `crypto.randomFillSync`.

The API's `onRequest` hook:

1. parses inbound `traceparent` if present, otherwise mints a fresh trace id;
2. mints a fresh span id;
3. starts a `SpanKind.SERVER` span named `HTTP <METHOD> <ROUTE>` (route is
   resolved in `preHandler` via `request.routeOptions.url`);
4. sets `http.method`, `http.target`, `net.peer.ip`, `http.route`,
   `http.status_code`, and `app.correlation_id` on the span;
5. ends the span in `onResponse` and echoes the response header `traceparent`.

### Span attribute policy

`FORBIDDEN_SPAN_ATTRIBUTE_KEYS` is a `Set<string>` covering:

- Credentials: `authorization`, `cookie`, `password`, `secret`, `apiKey`,
  `accessToken`, `refreshToken`, `x-api-key`, `x-sandbox-signature`,
  `set-cookie`, `rawBody`.
- Private profile fields: `passportNumber`, `documentNumber`, `nationality`,
  `dateOfBirth`, `memberPreferences`.
- Private chat / model content: `privateConversation`, `body`, `message`,
  `privateMessage`, `redactedSummary`, `prompt`, `question`.
- High-cardinality identifiers (mirrored from `metrics.ts`):
  `userId`, `tripId`, `planId`, `bookingId`, `conversationId`, `threadId`,
  `destination`, `origin`, `model`, `timestamp`, `name`, `correlationId`,
  `requestId`, `orchestrationRequestId`, `payload`.

`safeSetAttribute(span, key, value)` throws on any forbidden key.
`trySetAttribute` returns `false` instead of throwing. Production span sites
must use these helpers — never `span.setAttribute(...)` directly. PR 2
introduces the per-site allow-list tables for `db.*` and `llm.*` spans;
this PR ships the policy mechanism only.

### Tests

- `npx vitest run tests/tracing-foundations.test.ts` — covers
  `parseTraceparent` / `formatTraceparent`, ID generators, forbidden-key
  policy, `initTracing` env-driven exporter selection, and active-span
  integration with `recordSpanError`.

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
