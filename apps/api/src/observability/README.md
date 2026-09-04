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
`FORBIDDEN_LABEL_KEYS` (25 high-cardinality or sensitive identifiers in
[`metrics.ts`](./metrics.ts)); the same list is mirrored by
`FORBIDDEN_SPAN_ATTRIBUTE_KEYS` on the trace side.

### Series

`MetricsRegistry.describe()` is the machine-readable form of this table, and
`npm run docs:verify` fails when the two disagree in either direction — a
series registered but undocumented, a documented series that no longer
exists, or a changed label allow-list. Dashboards and alert rules are built
from these names, so a silent rename would leave a panel permanently empty
rather than visibly broken; keep the table generated, not hand-edited.

| metric | type | labels | allowed values |
| --- | --- | --- | --- |
| `accommodation_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["opentripmap"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,10000,30000]` |
| `accommodation_provider_requests_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["opentripmap"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `accommodation_tool_invocations_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["opentripmap"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `activities_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["viator_mcp"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,8000,15000,30000]` |
| `activities_provider_requests_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["viator_mcp"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `activities_tool_invocations_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["viator_mcp"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `agent_skill_duration_ms` | histogram | agent, skill, outcome | agent ∈ `["personal","shared"]`; skill ∈ `["profile.memory","profile.change_proposal","consent.explanation","thread.recall","travel.conversation","trip.constraint.propose","plan.comparison","readiness.check","flight.search","hotel.search","accommodation.discover","activities.search","places.search","places.adopt","navigation.route","mobility.search","other"]`; outcome ∈ `["success","failure","rejected","timeout"]`; buckets = `[50,100,250,500,1000,2000,5000,10000,30000,60000]` |
| `agent_skill_retries_total` | counter | agent, skill | agent ∈ `["personal","shared"]`; skill ∈ `["profile.memory","profile.change_proposal","consent.explanation","thread.recall","travel.conversation","trip.constraint.propose","plan.comparison","readiness.check","flight.search","hotel.search","accommodation.discover","activities.search","places.search","places.adopt","navigation.route","mobility.search","other"]` |
| `agent_skill_runs_total` | counter | agent, skill, outcome | agent ∈ `["personal","shared"]`; skill ∈ `["profile.memory","profile.change_proposal","consent.explanation","thread.recall","travel.conversation","trip.constraint.propose","plan.comparison","readiness.check","flight.search","hotel.search","accommodation.discover","activities.search","places.search","places.adopt","navigation.route","mobility.search","other"]`; outcome ∈ `["success","failure","rejected","timeout"]` |
| `agent_task_duration_ms` | histogram | operation, outcome | operation ∈ `["conversation","plan","replan","research","personal_research"]`; outcome ∈ `["completed","completed_with_gaps","failed","cancelled"]`; buckets = `[100,250,500,1000,2000,5000,10000,30000,60000,300000]` |
| `agent_task_outcomes_total` | counter | operation, outcome | operation ∈ `["conversation","plan","replan","research","personal_research"]`; outcome ∈ `["completed","completed_with_gaps","failed","cancelled","retrying"]` |
| `agent_task_recoveries_total` | counter | outcome | `["retrying","failed","cancelled"]` |
| `booking_callback_outcomes_total` | counter | callbackResult | `["processed","duplicate","failed"]` |
| `booking_gate_denials_total` | counter | errorCategory | `["callback_auth","membership","quorum","plan_state","plan_unavailable","non_unanimous","snapshot_stale","offer_stale","unknown"]` |
| `callback_verifications_total` | counter | callbackResult | `["valid","missing_header","malformed_timestamp","expired","bad_signature","configuration_error"]` |
| `conversation_context_build_total` | counter | result | `["success","empty","denied","error"]` |
| `conversation_context_chars` | counter | — | — |
| `conversation_context_messages` | counter | — | — |
| `conversation_context_truncated_total` | counter | reason | `["turn_limit","char_limit"]` |
| `conversation_handoff_candidate_batch_total` | counter | result | `["extracted","catalog_invalid","extraction_failed","empty"]` |
| `conversation_handoff_confirm_total` | counter | operation, result | operation ∈ `["plan","replan"]`; result ∈ `["success","rejected","stale","conflict"]` |
| `conversation_memory_context_facts` | counter | — | — |
| `conversation_memory_notes_dropped_total` | counter | — | — |
| `conversation_memory_context_total` | counter | result | `["success","empty"]` |
| `draft_command_rejected_total` | counter | operation | `["invitation","consent","planning","confirmation","booking","change_event","research","constraint_read","constraint_upsert","constraint_propose","constraint_confirm","constraint_dismiss","constraint_revoke"]` |
| `exploration_start_total` | counter | result | `["created","cached","conflict","error"]` |
| `external_provider_http_calls_total` | counter | provider, operation, outcome | provider ∈ `["amadeus","flightapi","nuitee_connect","openrouteservice","opentripmap","serpapi","viator_mcp","location_reference"]`; operation ∈ `["flight.search","hotel.search","accommodation.discover","place.search","navigation.route","mobility.search","activities.search","oauth.token","location.resolve"]`; outcome ∈ `["success","failure"]` |
| `external_provider_http_latency_ms` | histogram | provider, operation | provider ∈ `["amadeus","flightapi","nuitee_connect","openrouteservice","opentripmap","serpapi","viator_mcp","location_reference"]`; operation ∈ `["flight.search","hotel.search","accommodation.discover","place.search","navigation.route","mobility.search","activities.search","oauth.token","location.resolve"]`; buckets = `[100,250,500,1000,2000,5000,8000,15000,30000]` |
| `flight_offer_staleness_total` | counter | reason | `["expired","missing_expiry","unverifiable_expiry"]` |
| `flight_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["amadeus","flightapi","serpapi"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,8000,15000]` |
| `flight_provider_requests_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["amadeus","flightapi","serpapi"]`; error_category ∈ `["none","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","no_results","provider_not_approved","search_constraints_incomplete"]` |
| `flight_tool_invocations_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["amadeus","flightapi","serpapi","unconfigured"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `free_text_memory_writes_total` | counter | result | `["saved","too_long","list_full"]` |
| `hotel_provider_city_mismatch_total` | counter | provider, outcome | provider ∈ `["nuitee_connect","serpapi"]`; outcome ∈ `["partial","all_elsewhere","empty"]` |
| `hotel_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["nuitee_connect","serpapi_google_hotels","unconfigured"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,8000,10000,15000,30000]` |
| `hotel_provider_requests_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["nuitee_connect","serpapi_google_hotels","unconfigured"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `hotel_tool_invocations_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["nuitee_connect","serpapi_google_hotels","unconfigured"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `http_request_duration_ms` | histogram | method, status_class | method ∈ `["GET","HEAD","OPTIONS","POST","PUT","PATCH","DELETE","OTHER"]`; status_class ∈ `["1xx","2xx","3xx","4xx","5xx"]`; buckets = `[10,25,50,100,250,500,1000,2000,5000,10000,30000]` |
| `http_requests_total` | counter | method, status_class | method ∈ `["GET","HEAD","OPTIONS","POST","PUT","PATCH","DELETE","OTHER"]`; status_class ∈ `["1xx","2xx","3xx","4xx","5xx"]` |
| `llm_request_errors_total` | counter | provider, error_category, retryable | provider ∈ `["openai","gemini","openai-compatible"]`; error_category ∈ `["upstream_5xx","upstream_failure","network","timeout","schema_parse","tool_protocol","rate_limited","unknown"]`; retryable ∈ `["true","false"]` |
| `llm_request_latency_ms` | histogram | provider, outcome | provider ∈ `["openai","gemini","openai-compatible"]`; outcome ∈ `["success","failure"]`; buckets = `[50,100,250,500,1000,2000,5000,10000,30000]` |
| `location_introduction_cache_entries` | gauge | status | `["ready","generating"]` |
| `location_introduction_generation_duration_ms` | histogram | outcome | `["success","failure"]`; buckets = `[50,100,250,500,1000,2000,5000,10000,30000]` |
| `location_introduction_registry_total` | counter | outcome | `["registered","duplicate","error"]` |
| `location_introduction_requests_total` | counter | outcome | `["hit","miss","generating","unsupported","rate_limited","unavailable"]` |
| `location_reference_requests_total` | counter | outcome | `["reference","no_reference","unavailable","rate_limited"]` |
| `memory_fact_mutations_total` | counter | operation, source | operation ∈ `["replace","delete"]`; source ∈ `["profile_form","proposal_confirmation"]` |
| `memory_highlight_outcomes_total` | counter | outcome | `["field","note","too_long","list_full","sensitive_field","empty"]` |
| `memory_observation_skipped_total` | counter | reason | `["not_in_catalog","value_not_an_object","value_shape_mismatch"]` |
| `memory_projection_build_total` | counter | result | `["built","empty","failed"]` |
| `memory_proposal_resolutions_total` | counter | outcome | `["confirmed","dismissed","expired","already_resolved","not_found"]` |
| `memory_proposals_total` | counter | outcome, source | outcome ∈ `["created","aggregated","duplicate_episode","in_cooldown","rejected"]`; source ∈ `["behavior_aggregation"]` |
| `mobility_offer_selected_total` | counter | service_type | `["taxi","transfer","charter","rental"]` |
| `mobility_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["amadeus-transfer"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,8000,15000]` |
| `mobility_provider_requests_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["amadeus-transfer"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `mobility_search_tool_invocations_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["amadeus-transfer"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved","policy_denied"]` |
| `navigation_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["openrouteservice"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,8000,15000]` |
| `navigation_provider_requests_total` | counter | outcome, provider, error_category, transport_mode | outcome ∈ `["live","unavailable"]`; provider ∈ `["openrouteservice"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]`; transport_mode ∈ `["walk","drive","cycle","any"]` |
| `navigation_route_tool_invocations_total` | counter | outcome, provider, error_category, transport_mode | outcome ∈ `["live","unavailable"]`; provider ∈ `["openrouteservice"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved","policy_denied","per_run_cap_exceeded"]`; transport_mode ∈ `["walk","drive","cycle"]` |
| `personal_research_intent_confirmation_total` | counter | outcome | `["confirmed","dismissed","superseded","lease_lost"]` |
| `personal_research_intent_total` | counter | capability, disposition | capability ∈ `["flight","accommodation","hotel","activities","places","navigation","mobility","readiness"]`; disposition ∈ `["proposed","conversation","refusal"]` |
| `personal_research_proactive_intro_total` | counter | outcome | `["rendered","skipped_team","failure","enqueued"]` |
| `personal_research_readiness_total` | counter | capability, outcome | capability ∈ `["flight","accommodation","hotel","activities","places","navigation","mobility","readiness"]`; outcome ∈ `["ready","needs_setup","needs_place_selection"]` |
| `personal_research_setup_followup_questions_total` | counter | outcome | `["model","fallback"]` |
| `personal_research_setup_followup_total` | counter | outcome, reason | outcome ∈ `["model","fallback"]`; reason ∈ `["model","empty","no_gateway","schema","invalid_code","pii","length","model_error"]` |
| `personal_research_setup_session_total` | counter | outcome | `["opened","updated","confirmed","cancelled","expired","open_failed"]` |
| `pin_write_total` | counter | path, outcome | path ∈ `["orchestrator","confirm"]`; outcome ∈ `["success","skipped","failure"]` |
| `place_provider_latency_ms` | histogram | provider, outcome | provider ∈ `["openrouteservice","opentripmap"]`; outcome ∈ `["live","unavailable"]`; buckets = `[100,250,500,1000,2000,5000,8000,15000]` |
| `place_provider_requests_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["openrouteservice","opentripmap"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved"]` |
| `place_search_tool_invocations_total` | counter | outcome, provider, error_category | outcome ∈ `["live","unavailable"]`; provider ∈ `["openrouteservice"]`; error_category ∈ `["none","not_configured","search_constraints_incomplete","no_results","rate_limited","upstream_timeout","upstream_failure","invalid_provider_response","provider_not_approved","policy_denied","per_run_cap_exceeded"]` |
| `plan_adoption_vote_total` | counter | decision, result | decision ∈ `["accept","needs_changes"]`; result ∈ `["cast","adopted","blocked","stale_plan"]` |
| `plan_replan_total` | counter | trigger, result | trigger ∈ `["trip_constraint_confirmed","trip_constraint_revoked","trip_constraint_upsert","consent","change_event","conversation_handoff"]`; result ∈ `["enqueued","superseded","missing_snapshot"]` |
| `plan_validation_failures_total` | counter | validationResult | `["schema","authorization","route","provenance","evidence","unknown"]` |
| `provider_search_cache_total` | counter | category, outcome | category ∈ `["hotel","activity","accommodation"]`; outcome ∈ `["hit_live","hit_unavailable","miss","wait_timeout"]` |
| `research_auto_accept_total` | counter | outcome | `["adopted","stale_plan","already_adopted","not_solo","error"]` |
| `research_stage_total` | counter | stage, outcome | stage ∈ `["snapshot_created","researching","validating","persisting","completed","completed_with_gaps","failed","stale"]`; outcome ∈ `["success","failure"]` |
| `solo_plan_adoption_total` | counter | outcome | `["adopted","stale_plan","not_solo","forbidden","plan_not_proposed","error"]` |
| `trip_activation_total` | counter | result | `["success","conflict","forbidden","invalid","error"]` |
| `thread_title_writes_total` | counter | source, result | source ∈ `["deterministic","llm","manual"]`; result ∈ `["applied","rejected","unavailable","no_material","manual_locked"]` |
| `trip_brief_destination_resolution_total` | counter | result | `["accepted","unresolved"]` |
| `trip_constraint_mutation_total` | counter | operation, visibility, strength, result | operation ∈ `["propose","confirm","dismiss","upsert","revoke","handoff_confirm"]`; visibility ∈ `["team_visible","orchestrator_confidential","mixed","n_a"]`; strength ∈ `["hard","soft","mixed","n_a"]`; result ∈ `["success","replay","conflict","catalog_invalid"]` |
| `trip_brief_proposal_dates_total` | counter | result | `["ok","end_before_start","in_past","malformed"]` |
| `trip_brief_proposal_destination_resolution_total` | counter | result | `["accepted","rejected"]` |
| `trip_draft_brief_update_total` | counter | result | `["success"]` |
| `trip_brief_destination_resolution_total` | counter | result | `["accepted","unresolved"]` |
| `trip_invitation_rejected_total` | counter | reason | `["terminal_trip"]` |
| `trip_place_actions_total` | counter | action, visibility | action ∈ `["proposed","adopted","revoked","stale_invalidated"]`; visibility ∈ `["owner_private","team_visible","orchestrator_confidential"]` |
| `ui_diagnostic_events_total` | counter | action, outcome, error_category | action ∈ `["frontend.runtime","profile.save","trip.activate","trip.thread_create","conversation.submit","agent.run_cancel","invitation.accept","invitation.decline","plan.confirm","booking.confirm"]`; outcome ∈ `["success","failure"]`; error_category ∈ `["none","validation","network","http_4xx","http_5xx","timeout","aborted","invalid_response","render","unhandled"]` |

`MetricProvider` is the type alias for the `provider` label on the LLM
series: `"openai" \| "gemini" \| "openai-compatible"`.

### Render

`metrics.render()` returns a Prometheus text-format dump. The
`/metrics` route in `app.ts` returns it with content type
`text/plain; version=0.0.4; charset=utf-8`. `metrics.reset()` clears all
samples and is used by tests.

The Worker has its own registry. `workers/metrics-server.ts` exposes it at
`GET /metrics` and `GET /health` on `WORKER_METRICS_HOST` / `WORKER_METRICS_PORT`
(default `127.0.0.1:9464`). Docker Compose binds it only inside the Compose
network; a production collector must scrape it from the Worker task, never
publish it through public ingress.

## Log redaction

### Pino paths (`LOGGER_REDACT_PATHS` in `telemetry.ts`)

### Local file fallback

Container stdout is always JSON by default so `docker compose logs … | jq`
remains parseable. Set `LOG_FORMAT=pretty` only for an interactive host-run
process; the optional NDJSON sink remains JSON in both modes.

When `LOCAL_DEBUG_LOG_FILE` is set to `auto` or a simple `.ndjson` filename,
Pino writes the normal redacted stdout stream and a second, daily NDJSON stream
under `apps/api/runtime/` (for example `api-2026-09-01.ndjson`). The sink
switches at midnight in `LOCAL_LOG_TIMEZONE` and removes this process role's
dated files outside the newest seven calendar days at startup. It is
independent of OTel and contains only safe `runtime_event` lifecycle metadata
(no prompt, completion, tool payload or private data). See [the deployment
runbook](../../../../docs/observability-deployment.md#local-diagnostic-fallback).

`LOGGER_REDACT_PATHS` is a 40-entry string list array. Pino replaces every
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

### External provider HTTP boundary

`external-provider.ts` wraps every current outbound travel-provider request
(Amadeus, FlightAPI, Nuitee, SerpApi, OpenTripMap, openrouteservice and Viator
MCP), plus the local location-reference sidecar. Each request produces an
`external_provider_call` record at `started` and `completed`, and an
`external.provider.*` client span. A retry therefore appears as another
start/completion pair in the same trace. The only emitted fields are the
bounded `provider`, `operation`, HTTP method, outcome, HTTP status, duration,
and an optional `Content-Length` response size. Network and abort failures are
classified as `network` or `timeout`; exception text is never emitted.

The metrics are `external_provider_http_calls_total{provider,operation,outcome}`
and `external_provider_http_latency_ms{provider,operation}`. Neither accepts
URL, supplier IDs, request/response content, credentials, trip identifiers nor
other high-cardinality fields as a label or span attribute.

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
| `external.provider.*` | `observability/external-provider.ts`, called by all travel-provider adapters and the location sidecar | `provider.name`, `provider.operation`, `http.request.method`, `http.response.status_code`, `provider.outcome`, `provider.error_code`, `provider.latency_ms`, `provider.response_bytes`; all values are bounded/safe metadata |
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
