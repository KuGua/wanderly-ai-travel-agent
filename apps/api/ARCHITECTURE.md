# Architecture

## Overview

AI Travel Agent is a **modular monolith** — not a microservice architecture.
The API and durable Agent Worker are two process entrypoints over the same code,
database, policy, and provider modules; HTTP request processes never own accepted
Agent execution.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Fastify HTTP Layer                        │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────────┐  │
│  │Profile │ │  Trip  │ │Consent │ │ Planning │ │ Confirmation│  │
│  │Routes  │ │Routes  │ │Routes  │ │  Routes  │ │   Routes   │  │
│  └───┬────┘ └───┬────┘ └───┬────┘ └────┬─────┘ └─────┬──────┘  │
│      │          │          │           │              │          │
│  ┌───┴──────────┴──────────┴───────────┴──────────────┴──────┐  │
│  │                    Business Services                       │  │
│  │  consent │ planning │ confirmation │ booking │ change-event│  │
│  │  audit   │ idempotency │ visa                             │  │
│  └───┬──────────┬────────────────┬───────────────┬───────────┘  │
│      │          │                │               │               │
│  ┌───┴────┐ ┌───┴────────┐ ┌────┴───────┐ ┌────┴──────────┐   │
│  │ Model  │ │  Travel    │ │  Consent   │ │  Idempotency  │   │
│  │Gateway │ │  Providers │ │  Store     │ │  + Outbox     │   │
│  └────────┘ └────────────┘ └────────────┘ └───────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              PostgreSQL (Drizzle ORM)                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## Module Boundaries

### 1. ModelGateway (`src/providers/model-gateway.ts`)

Application-layer interface for AI model interactions:
- `generateStructuredPlan()` — produces itinerary from provider offers
- `explainPlanDiff()` — explains differences between old/new plans
- `generateConversationReply()` — produces a typed private Personal Agent
  answer with explicit `MODEL` provenance
- `streamConversationReply()` — OpenAI-compatible async chunks for the Worker;
  chunks remain untrusted until the streaming safety gate approves them

**Constraints**: Model cannot access database or execute irreversible operations.
**Current**: `gateway-factory.ts` requires a configured real OpenAI, Gemini, or
OpenAI-compatible provider. `LLMGateway` uses structured model output and records
safe model/prompt versions and Agent-run metadata. Upstream, timeout, and parse
failures fail closed. Tests may inject fakes, but production has no mock fallback.
Conversation policy may return `SAFE_REFUSAL` without calling the gateway.

### 2. TravelProvider Adapters (`src/providers/`)

Unified interfaces for travel data:
- `FlightProvider` — search flights
- `StayProvider` — search accommodations
- `GroundProvider` — search ground transport
- `VisaProvider` — check visa readiness

**Current**: `FixtureProvider` returns deterministic demo data through the
discriminated `ProviderResult<T>` contract. Usable fixture results use
`outcome: "FALLBACK_DEMO"` with a stable reason and provenance; unsupported
queries use `outcome: "UNAVAILABLE"` and carry no fabricated `data` field.
**Rule**: Any live provider failure must fall back to fixture with `Demo data` marker.
**Never**: Fabricate real-time prices or inventory.

Fixture datasets expose a stable version and fixed `capturedAt` value. Provider
queries return copies of matching records and apply their documented filters;
an unsupported route or date range returns no offers rather than fabricated data.

### 2a. Plan Output Control Plane (`src/policy/`)

`snapshot-policy.ts` accepts only exact
`authorizedData.<memberId>.<fieldName>` references that exist in the immutable
snapshot. Missing, malformed, or ambiguous references fail closed.

`plan-output-validator.ts` treats `ModelGateway` output as untrusted. Before an
`ACTIVE` plan can be inserted, it enforces a strict Zod structure, allowed
origins/destination, complete provenance, and exact equality between every
selected offer and the run-scoped provider evidence. A failure raises
`PlanValidationError` (`422`) with low-risk `{ code, fieldPath, reason }`
violations; no plan, provider offer, source evidence, or plan audit row is
written by that planning attempt.

`PlanComparisonSkill` applies the same validator as an early proposal check,
but this does not replace the final `PlanningService` check. Skill policy gates
control which scopes may be invoked; the validator independently proves that
the proposed facts are authorized and exactly backed by current-run evidence.

### 3. Business Services (`src/services/`)

Core business logic — NOT in LLM/Agent:
- **ConsentService** — grant/revoke/build authorized data
- **PlanningService** — snapshot creation, plan generation, stale marking
- **ConfirmationService** — member confirmations, quorum checking
- **BookingService** — sandbox orchestration, idempotency
- **ChangeEventService** — change event processing, replan triggering
- **VisaService** — readiness checks with nationality authorization
- **AuditService** — correlation-ID-based audit trail
- **IdempotencyService** — global idempotency for all operations
- **ChatConversationService** — owner-only deterministic history reads
- **TaskRepository / AgentTaskWorker** — short acceptance transaction, atomic
  `SKIP LOCKED` claims, renewable leases, recovery/retry, explicit cancellation,
  streaming policy enforcement, and conditional final persistence

### 4. Database Layer (`src/db/`)

- **Schema** (`schema.ts`) — Drizzle ORM table definitions
- **Migration** (`migrate.ts`) — SQL DDL execution
- **Seed** (`seed.ts`) — Demo user/profile creation

## Domain Model

```
users ──1:1── user_profiles (private)
  │
  ├──< chat_threads ──< chat_messages (owner-only USER / server ASSISTANT)
  │          └──< agent_task_runs (durable state; no prompt/partial text)
  │
  └──< trip_members >── shared_trips
         │                  │
         │                  ├── constraint_snapshots (immutable)
         │                  │        │
         │                  │        └── itinerary_plans (versioned)
         │                  │                │
         │                  │                ├── member_confirmations
         │                  │                ├── visa_readiness_checks
         │                  │                ├── source_evidence
         │                  │                └── provider_offers
         │                  │
         │                  └── consent_grants (per-scope, per-field)
         │
         └── booking_executions
                │
                └── idempotency_records

Cross-cutting:
  audit_events (correlation_id, action, summary)
  outbox_events (event_id, type, payload, status)
```

## Security Boundaries

### Consent Model
- Profile data is **private by default**
- Sharing requires explicit `consent_grants` per scope per trip
- Scopes: `PROFILE_BASIC`, `PROFILE_PREFERENCES`, `PROFILE_NATIONALITY`, `PROFILE_DOCUMENTS`, `PROFILE_BUDGET`, `PROFILE_RESTRICTIONS`
- Revoking consent → all related plans become `STALE`

### Data Minimization
- `buildAuthorizedData()` only includes explicitly granted fields
- Passport number is **never** included in authorized data or logs
- Nationality is only used for visa checks when explicitly shared
- Cognito login is the identity bootstrap. Protected routes verify bearer
  access tokens and derive the database user from the verified token `sub`;
  clients cannot select an identity by submitting a user ID.
- Trip list/detail queries enforce membership in PostgreSQL before returning
  trip or safe member presentation data.

### HTTP Contract Boundary
- Zod defines the canonical request/response contracts and supplies JSON Schema
  to Fastify OpenAPI for the frontend client boundary.
- Profile PUT is a strict partial update: omitted fields are preserved, `null`
  and unknown fields are rejected, and server-owned identity/timestamp fields
  are immutable.
- API failures use one correlation-aware error envelope; the response
  `x-correlation-id` header matches the body `correlationId`.
- Plan policy failures extend that same envelope with structured `violations`;
  rejected values and private snapshot data are never returned.
- Public chat clients submit only `requestId`, `question`, and optional bounded
  place context. Persisted roles and sender identity are server-controlled.
- Owner-readable raw conversation history is separate from redacted
  `thread.recall`; neither trip membership nor thread binding widens access.

### Audit Trail
- Every sensitive operation records an `audit_event` with:
  - `correlation_id` (request-level trace)
  - `action` (enum)
  - `actor_user_id`
  - `summary` (minimal, no PII)
- Audit summaries accept only finite JSON primitives, `null`, arrays, and plain
  objects through three nested structure levels. Unsafe keys, raw payloads,
  functions, class instances, `Buffer`, `Date`, cycles, and custom prototypes
  are rejected rather than silently stored or truncated.

### Callback Security

- `POST /api/v1/bookings/callback` is the only business route exempt from demo
  identity auth; it instead requires HMAC-SHA256 over
  `${timestamp}.${rawRequestBody}`.
- Exact request bytes, strict timestamp syntax, a five-minute replay window,
  hex signature format, and timing-safe comparison are enforced before schema
  parsing or booking lookup.
- All authentication failures return the same `401` body. Bounded internal
  categories support warning logs and metrics without exposing cryptographic
  details.

### Observability

- Fastify uses one centralized Pino logger with correlation IDs and configured
  redaction for credentials, callback signatures, document fields, nationality,
  dates of birth, and private model inputs.
- `/metrics` renders process-local Prometheus text for the MVP. Every metric has
  an exact bounded label schema; identifiers and free-form values are rejected.
- Distributed tracing is wired through `src/observability/tracing.ts` (see
  [src/observability/README.md](src/observability/README.md)). The API and the
  Worker each call `initTracing()` as their first import; the SDK is opt-in in
  production (`OTEL_SDK_DISABLED=true` by default until the CloudWatch / OTLP
  collector sidecar lands). W3C `traceparent` is parsed on `onRequest`,
  attached as `trace_id` / `span_id` Pino bindings, and echoed back as a
  response header. Spans are added manually at the highest-value boundaries
  (HTTP, DB write hot-spots, LLM, skill, worker run, SSE event) — no auto-
  instrumentation — and every span attribute is gated by
  `FORBIDDEN_SPAN_ATTRIBUTE_KEYS`. There is no durable trace storage or
  scraper configuration in this repository yet.

### Durable task trace context

`agent_task_runs.trace_context` is a JSONB column added by migration
`0010_agent_task_trace_context.sql`. It carries the W3C trace context
captured at HTTP ingress (shape: `{ traceparent, tracestate?, correlationId }`),
so the Worker process — which runs in a separate ECS Fargate task — can
reconstruct the originating trace without any new inbound call. The
producer side is `acceptConversationTask` (`apps/api/src/tasks/task-repository.ts`),
which writes the column inside the same transaction that inserts the run
row. The consumer side is `ctxFromRun(run)` in
`apps/api/src/tasks/task-repository.ts`, called by
`processNextAgentTask` to build a `RequestContext` whose
`traceparent`/`tracestate` mirror the persisted values.

The Worker root span is `agent_task_worker.run` (`SpanKind.CONSUMER`,
`apps/api/src/workers/agent-task-worker.ts`). When the task row carries a
trace context, the span is opened with a `SpanLink` to the originating HTTP
server span — the parent may already have ended (the Worker polls), so we
do not assert a parent relationship. When the column is `null` (old rows,
recovery path, replay), the span is opened as a fresh root and tagged with
`tasks.recovery=true`.

## Idempotency Strategy

All mutating operations use `idempotency_records`:
- **Planning**: keyed by `change_event:{eventId}`
- **Booking**: keyed by `booking:{orchestrationRequestId}`
- **Callbacks**: keyed by `callback:{eventId}`
- **Chat turns**: keyed by `chat_turn:{threadId}:{requestId}`; acceptance stores
  the durable run ID and USER message exactly once. Completion updates only safe
  result IDs/response mode, never message bodies or partial stream text.

Duplicate requests return cached results without side effects.

## State Machine

### Plan Lifecycle
```
DRAFT → ACTIVE → STALE (consent change, price change, etc.)
                  ↓
              SUPERSEDED (replaced by new plan)
```

### Confirmation Lifecycle
```
PENDING → CONFIRMED | NEEDS_CHANGES → STALE (when plan becomes stale)
```

### Booking Lifecycle
```
PENDING → SUBMITTED → SUCCESS | FAILED
```

## Out-of-Scope (MVP)

- Real payment processing
- Live supplier API integration (only fixtures)
- Native group chat
- Free-form destination search
- Redis / Temporal / Step Functions
- Multi-microservice architecture
- Cognito sign-in UI (the API already verifies Cognito access tokens)
