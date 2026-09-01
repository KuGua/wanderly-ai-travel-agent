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
| `trip_constraint_mutation_total` | counter | operation, visibility, strength, result | operation ∈ `["propose","confirm","dismiss","upsert","revoke"]`; visibility ∈ `["team_visible","orchestrator_confidential","n_a"]`; strength ∈ `["hard","soft","n_a"]`; result ∈ `["success","replay","conflict","catalog_invalid"]` |
| `plan_adoption_vote_total` | counter | decision, result | decision ∈ `["accept","needs_changes"]`; result ∈ `["cast","adopted","blocked","stale_plan"]` |
| `plan_replan_total` | counter | trigger, result | trigger ∈ `["trip_constraint_confirmed","trip_constraint_revoked","trip_constraint_upsert","consent","change_event"]`; result ∈ `["enqueued","superseded","missing_snapshot"]` |
| `llm_request_latency_ms` | histogram | provider, outcome | provider ∈ `["openai","gemini","openai-compatible","mock"]`; outcome ∈ `["success"]`; buckets = `[50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000]` ms |

`MetricProvider` is the type alias for the `provider` label:
`"openai" \| "gemini" \| "openai-compatible" \| "mock"`.

### Render

`metrics.render()` returns a Prometheus text-format dump. The
`/metrics` route in `app.ts` returns it with content type
`text/plain; version=0.0.4; charset=utf-8`. `metrics.reset()` clears all
samples and is used by tests.

## Log redaction

### Pino paths (`telemetry.ts:6-46`)

### Local file fallback

When `LOCAL_DEBUG_LOG_FILE` is set to `auto` or a simple `.ndjson` filename,
Pino writes the normal redacted stdout stream and a second, daily NDJSON stream
under `apps/api/runtime/` (for example `api-2026-09-01.ndjson`). The sink
switches at midnight in `LOCAL_LOG_TIMEZONE` and removes this process role's
dated files outside the newest seven calendar days at startup. It is
independent of OTel and contains only safe `runtime_event` lifecycle metadata
(no prompt, completion, tool payload or private data). See [the deployment
runbook](../../../../docs/observability-deployment.md#local-diagnostic-fallback).

`LOGGER_REDACT_PATHS` is a 39-entry string list array. Pino replaces every
matched path with `"[REDACTED]"` at log time. Categories (verbatim):

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

### API → Worker log join

`ctxFromRun` (`tasks/task-repository.ts`) rehydrates `correlationId` **and**
`traceId` from the persisted `agent_task_runs.trace_context`, so the API line
that accepted `POST /planning/generate` and every Worker line for the same
durable task share both ids. `spanId` is deliberately left unset there:
`correlationChild` then binds the Worker's *own* active span, so `span_id`
identifies the Worker unit of work while `trace_id` still joins back to the
originating request. A task row with no `trace_context` (recovery, replay,
pre-PR-3 rows) keeps a fresh `correlationId` and omits the trace bindings.

### `runtime_event` correlation and provider fields

`SafeRuntimeEvent` carries, in addition to the lifecycle fields,
`relatedRunId` / `relatedSnapshotId` (validated UUIDs — the durable
`agent_task_runs.id` and the immutable constraint snapshot; log/trace
correlation only, **never** metric labels) and, for external searches,
`provider` ∈ `["amadeus","flightapi","serpapi","unconfigured"]`,
`providerStatus` ∈ `["LIVE","UNAVAILABLE"]`, plus the controlled
`originId` / `destinationId` catalogue ids. `executeAndPersistFlightSearch`
emits a `started` record and one terminal record carrying `providerStatus`,
`latencyMs`, and either `itemCount` (normalized offer count) or `errorCode`
(the bounded `UNAVAILABLE` reason). The supplier URL, API key, raw payload
and raw provider error never reach this layer — they stay inside the
provider adapter.

## Distributed tracing

### Bootstrap (`tracing.ts`)

`initTracing({ serviceName?, serviceVersion? })` is idempotent and must be the
first import in both `apps/api/src/server.ts` and
`apps/api/src/workers/worker-main.ts`. It reads environment to pick:

| Env var | Default | Effect |
| --- | --- | --- |
| `OTEL_SDK_DISABLED` | unset | `true` → skip the provider entirely; the API still installs the W3C propagator so inbound trace context remains readable |
| `OTEL_TRACES_EXPORTER` | env-driven | `console` / `otlp` / `none` override the default; `in-memory` only meaningful in tests |
| `NODE_ENV` | `development` | `test` → in-memory exporter; any non-test environment exports to OTLP when an endpoint is set, otherwise development uses console and production is no-op |
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

The API's `onRequest` hook (registered before the CORS plugin so preflight
requests cannot bypass it):

1. parses inbound `traceparent` if present, otherwise mints a fresh trace id;
2. mints a fresh span id;
3. starts a `SpanKind.SERVER` span named `HTTP <METHOD> <ROUTE>` (route is
   resolved in `preHandler` via `request.routeOptions.url`);
4. sets `http.method`, `http.target`, `net.peer.ip`, `http.route`,
   `http.status_code`, and `app.correlation_id` on the span;
4b. stores the serialized `traceparent` (and the inbound `tracestate`, when
   present) on the request. Routes forward these into `createRequestContext`,
   and `tasks/task-repository.ts#buildTraceContextForTask` persists them into
   `agent_task_runs.trace_context`. This is the only way trace context
   survives the durable boundary — without it the column is `NULL` for every
   task and the Worker cannot rejoin the originating request's log thread;
5. writes the response `traceparent` before later `onRequest` hooks can
   short-circuit a response, then ends the span in `onResponse`.

CORS preflight requests may be completed by the CORS plugin before the API's
`onRequest` hook creates a trace context. Those successful `OPTIONS` responses
intentionally omit `traceparent` rather than attempting to format missing IDs.

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
must use these helpers — never `span.setAttribute(...)` directly.

### Span catalogue

Each span site uses one of the prefixes below; attributes are restricted to
the keys listed for that prefix. Adding a new key requires updating both the
allow-list and the `docs/agent-architecture.md` trace map.

| Prefix | Site | Allowed attributes |
| --- | --- | --- |
| `http.*` | `app.ts` `onRequest`/`preHandler`/`onResponse` | `http.method`, `http.route`, `http.status_code`, `http.target`, `net.peer.ip`, `app.correlation_id` |
| `db.*` | `tasks/task-repository.ts` hot-spots | `db.system` (=`"postgresql"`), `db.operation` (`INSERT`/`SELECT`/`UPDATE`), `db.sql.table` (=`"agent_task_runs"`), `db.outcome` (`success`/`failure`/`duplicate`/`empty`) |
| `llm.*` | `providers/llm-gateway.ts` (3 sites) | `llm.system` (=`"openai-compatible"`), `llm.provider` (∈ openai/gemini/openai-compatible), `llm.model.name`, `llm.model.prompt_version`, `llm.method` (plan.comparison / travel.conversation), `llm.stream` (bool), `llm.skill.name`, `llm.outcome` (`success`/error code), `llm.error_code`, `llm.tokens.{prompt,completion,total}` |
| `trip.constraint.*` | (Phase 2+) `services/constraint-proposal-service.ts`, `services/constraint-fact-service.ts` mutation transactions | `trip.constraint.operation` ∈ `["propose","confirm","dismiss","replace","revoke"]`, `trip.constraint.visibility` ∈ `["TEAM_VISIBLE","ORCHESTRATOR_CONFIDENTIAL"]`, `trip.constraint.strength` ∈ `["HARD","SOFT"]`, `trip.constraint.field_category` (one of the catalog field groups, never the value), `trip.constraint.outcome` ∈ `["success","conflict","stale"]`. **Never** include `fieldKey` raw values — use the catalog-derived category label only. |
| `snapshot.projection.*` | (Phase 1+) `services/memory-projection-builder.ts`, `services/planning-service.ts#createConstraintSnapshot` | `snapshot.projection.schema_version` (=`2`), `snapshot.projection.confidential_count` (low-cardinality bucket: `0`/`1-2`/`3+`), `snapshot.projection.team_visible_count` (same buckets), `snapshot.projection.outcome` ∈ `["built","superseded","projection_invalid"]`. **Never** include member userIds, aliases, fact values, or source IDs. |
| `plan.adoption.*` | (Phase 4+) `services/plan-adoption-service.ts#castVote`, `#tallyVotes` | `plan.adoption.decision` ∈ `["ACCEPT","NEEDS_CHANGES"]`, `plan.adoption.required_count` (bucket `1`/`2`/`3`/`4+`), `plan.adoption.received_count` (same buckets), `plan.adoption.outcome` ∈ `["pending","accepted","blocked","invalid"]`. **Never** include vote owner ids, plan data, fact values. |

The trace context itself (the W3C `traceparent` value and the active
`trace_id`/`span_id` pair) is **not** duplicated as a span attribute — it
already rides on every span by virtue of the SDK. The `app.correlation_id`
attribute on the `http.*` span is the join key back to Pino logs and audit
rows.

### Span trace propagation

- HTTP server span → outbound LLM call: `traceparent` header injected on the
  OpenAI SDK call via `outboundTraceHeaders()` in `llm-gateway.ts`.
- HTTP server span → durable Worker: persisted in
  `agent_task_runs.trace_context` JSONB column (see PR 3 for the
  migration). The Worker reconstructs the span context via
  `ctxFromRun(run)` in `workers/agent-task-worker.ts`.
- Worker root span → SSE event: stored in `AgentStreamRelay` and re-applied
  per event as a `SpanLink` rather than a child (the SSE stream lives
  across process boundaries where the parent span may have already ended).

### Tests

- `npx vitest run tests/tracing-foundations.test.ts` — covers
  `parseTraceparent` / `formatTraceparent`, ID generators, forbidden-key
  policy, `initTracing` env-driven exporter selection, and active-span
  integration with `recordSpanError`.
- `npx vitest run tests/llm-gateway-tracing.test.ts` — covers
  `traceparent` header injection on outbound SDK calls and span attribute
  policy enforcement on `llm.openai.parse`.
- `npx vitest run tests/db-span-attributes.test.ts` — covers the forbidden
  span attribute policy and the attribute set shape for the `db.*` prefix.

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
