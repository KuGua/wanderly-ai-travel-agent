# AI Travel Agent — Backend MVP

> Hackathon project: collaborative international trip planning with consent-based data sharing, fixture-backed providers, and sandbox booking.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment config
cp .env.example .env

# 3. Start PostgreSQL (local or Docker)
# Option A: Docker
docker compose up -d postgres

# Option B: Local PostgreSQL (ensure DB_HOST, DB_PORT, etc. match .env)

# 4. Run database migrations
npm run db:migrate

# 5. Seed demo data
npm run db:seed

# 6. Start the server
npm run dev
```

Server runs at `http://localhost:3000`. OpenAPI docs at `http://localhost:3000/docs`.

## Demo Users

| User  | External ID | Departure City | Key Traits |
|-------|------------|----------------|------------|
| Alice | `alice`    | San Francisco  | Art interests, city center stays, **no red-eye** |
| Bob   | `bob`      | San Francisco  | Budget cap $2500, comfort preference |
| Chen  | `chen`     | Shanghai       | History/temples, limited departure dates |

Use the `X-Demo-User` header to authenticate:
```bash
curl -H "X-Demo-User: alice" http://localhost:3000/api/v1/profiles/me
```

## Key Features

- **Profile CRUD** — Private by default, never shared without explicit consent
- **Shared Trip Management** — Create trips, invite members, manage destinations
- **Consent-Based Data Sharing** — Per-field, per-scope, per-trip consent grants/revocations
- **Constraint Snapshots** — Immutable snapshots of authorized data per planning round
- **Fixture Providers** — All flight/stay/ground/visa data marked as `Demo data`
- **Visa Readiness** — Checklist per member; shows "verify with official sources" when nationality not shared
- **Plan Versioning** — Generate, stale, replan with diff
- **Three-Person Confirmation** — All 3 required members must confirm before sandbox booking
- **Sandbox Booking** — No real payments; returns demo references
- **Idempotency** — All planning, change events, and booking operations are idempotent
- **Audit Trail** — All sensitive operations logged with correlation IDs

## Testing

```bash
npm test
```

20 tests covering:
- Cross-user access rejection
- Consent revocation → plan stale
- Snapshot immutability
- Fixture fallback markers
- Unauthorized nationality not inferred
- Change event idempotency
- Three-person confirmation threshold
- Old plan/confirmation rejection
- Duplicate/out-of-order callback handling
- Error states cannot create bookings

## Tech Stack

- **Runtime**: Node.js 22 LTS + TypeScript
- **Framework**: Fastify 5
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Validation**: Zod
- **Testing**: Vitest
- **Logging**: Pino (structured, PII-redacted)
- **Deployment**: Docker → AWS App Runner (target)

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — System design and module boundaries
- [API.md](./API.md) — REST API reference

## License

MIT
