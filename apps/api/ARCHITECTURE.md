# Architecture

## Overview

AI Travel Agent is a **modular monolith** — not a microservice architecture. All business logic runs in a single Fastify process with clear module boundaries designed for future extraction if needed.

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

**Constraints**: Model cannot access database or execute irreversible operations.
**Current**: `gateway-factory.ts` selects the deterministic `MockModelGateway`
unless an OpenAI key/provider is configured. `LLMGateway` uses structured model
output, records model/prompt versions and agent-run metadata, and falls back to
the mock implementation on bounded upstream or parse failures. Both paths return
candidate data that must pass the control plane below before persistence.

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

### 4. Database Layer (`src/db/`)

- **Schema** (`schema.ts`) — Drizzle ORM table definitions
- **Migration** (`migrate.ts`) — SQL DDL execution
- **Seed** (`seed.ts`) — Demo user/profile creation

## Domain Model

```
users ──1:1── user_profiles (private)
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
- `GET /api/v1/demo/users` is the sole unauthenticated API bootstrap endpoint;
  it exposes only seeded user UUID, `externalId`, and `displayName` so the demo
  UI can select an identity and create member references.
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

### Audit Trail
- Every sensitive operation records an `audit_event` with:
  - `correlation_id` (request-level trace)
  - `action` (enum)
  - `actor_user_id`
  - `summary` (minimal, no PII)

## Idempotency Strategy

All mutating operations use `idempotency_records`:
- **Planning**: keyed by `change_event:{eventId}`
- **Booking**: keyed by `booking:{orchestrationRequestId}`
- **Callbacks**: keyed by `callback:{eventId}`

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
- Cognito integration (demo auth middleware only)
