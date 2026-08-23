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
**Future**: Swap `MockModelGateway` with OpenAI Agents SDK, Bedrock, etc.

### 2. TravelProvider Adapters (`src/providers/`)

Unified interfaces for travel data:
- `FlightProvider` — search flights
- `StayProvider` — search accommodations
- `GroundProvider` — search ground transport
- `VisaProvider` — check visa readiness

**Current**: `FixtureProvider` returns deterministic demo data.
**Rule**: Any live provider failure must fall back to fixture with `Demo data` marker.
**Never**: Fabricate real-time prices or inventory.

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
