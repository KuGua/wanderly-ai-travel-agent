# MVP Readiness Review

**Reviewed:** 2026-08-23  
**Scope:** `apps/api`, the current TypeScript backend MVP

## Verdict

The architectural direction is suitable for the hackathon: a TypeScript/Fastify modular monolith, PostgreSQL as the system of record, fixture-backed provider adapters, and a model gateway are all appropriate foundations for continued development.

The implementation is **not yet demo-ready or safely usable**. It builds and type-checks, but its database-backed tests were not executed because neither PostgreSQL nor the local Docker daemon was available. More importantly, several implemented paths do not meet the documented privacy and planning requirements.

## Required fixes before a demo

1. **Plan all configured candidates.** `planning.ts` currently selects only the first destination rather than comparing the configured two or three candidates.
2. **Use the snapshot for visa checks.** `visa-service.ts` substitutes `US` after nationality consent. It must read each member's authorized nationality from the immutable constraint snapshot, and never infer or substitute one.
3. **Invalidate immediately on consent changes.** Grant/revoke must atomically stale all affected active plans and confirmations. The current consent service only changes consent rows.
4. **Replan from persisted trip data.** `change-event-service.ts` currently hard-codes Tokyo, San Francisco, Shanghai, and dates. It must use the affected trip and event data, then persist an actual candidate/constraint diff.
5. **Protect the sandbox callback.** The callback currently accepts any authenticated demo user and has no provider signature/secret verification. Give it a separate authenticated provider boundary and confirm it is tied to the intended execution.
6. **Add relational uniqueness and transactions.** Enforce one profile per user; unique trip membership, `(trip_id, version)` snapshots/plans, one confirmation per `(plan_id, user_id)`, and one booking per orchestration request. Wrap state transitions and idempotency record creation in transactions.
7. **Make seed and migrations repeatable.** The seed currently inserts duplicate demo users on rerun; migrations are imperative startup code without migration history. Use versioned migrations and idempotent seed upserts.
8. **Restore working quality gates.** Add ESLint flat configuration and run the full test suite against disposable PostgreSQL in CI. Implement the documented OpenTelemetry/metrics integration or reduce the documentation claim until it exists.

## Verification performed

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | Failed: database connection to `127.0.0.1:5432` was refused; 12 integration tests were skipped after setup failure and 3 API tests returned 500 for the same reason. |
| `npm run lint` | Failed: ESLint 9 configuration file is missing. |
| Docker-backed validation | Not run: local Docker daemon is unavailable. |

## Repository cleanup

The obsolete Coze/Python scaffold was removed: `.coze`, `pyproject.toml`, `uv.lock`, and the former root `src/` and `scripts/` files. The deployable backend remains at `apps/api/`, a conventional monorepo layout. Empty legacy directories are not tracked by Git and can be removed locally by the developer if their file explorer retains them.
