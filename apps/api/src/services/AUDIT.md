---
name: audit-summary-whitelist
source-of-truth: ./audit-service.ts
applies-to: [every recordAudit caller]
---

# Audit Summary Whitelist

`audit-service.ts` is the only place `audit_events.summary` is constructed.
`whitelistSummary(value)` is a strict, **throw-on-violation** validator that
runs **before** any insert. Rejection propagates as
`AuditSummaryValidationError` and prevents the audit row from being written.

## Source-of-truth

`./audit-service.ts`.

## Audit action vocabulary

`AuditAction` currently permits:

- Profile: `PROFILE_CREATE`, `PROFILE_UPDATE`, `PROFILE_DELETE`.
- Trip and consent: `TRIP_CREATE`, `TRIP_JOIN`, `TRIP_INVITATION_CREATE`,
  `TRIP_INVITATION_ACCEPT`, `TRIP_INVITATION_REVOKE`,
  `TRIP_TITLE_UPDATE`, `TRIP_DRAFT_BRIEF_UPDATE`, `TRIP_ACTIVATE`,
  `EXPLORATION_START`, `TRIP_DEFAULT_THREAD_PROVISION`,
  `CONSENT_GRANT`, `CONSENT_REVOKE`.
- Planning: `PLAN_CREATE`, `PLAN_STALE`, `PLAN_REPLAN`, `PLAN_RESTART`, `CONFIRMATION_SET`.
- Flight search: `FLIGHT_SEARCH_REQUESTED`, `FLIGHT_SEARCH_COMPLETED`, `FLIGHT_SEARCH_UNAVAILABLE`; summaries contain only provider, bounded outcome/error code, and safe correlation identifiers, never raw provider payloads.
- Booking and changes: `BOOKING_SUBMIT`, `BOOKING_RESULT`, `CHANGE_EVENT`, `VISA_CHECK`.
- Chat: `CHAT_THREAD_CREATE`, `CHAT_THREAD_DELETE`, `CHAT_MESSAGE_APPEND`.
- Agent runtime: `SKILL_INVOKE`, `AGENT_RUN`, `AGENT_TASK`. Task summaries
  contain only safe run/operation/status identifiers and never question or
  streamed/final message text.

## Scope & invariants

- `whitelistSummary` **never silently redacts**. If a key, value, depth, or
  prototype fails the whitelist, it **throws**.
- `recordAudit` invokes `whitelistSummary(params.summary ?? {})` before
  insert; the throw becomes a `try/catch` responsibility at every caller.
  Today every caller treats the audit as best-effort and lets the throw
  bubble up as a 500.
- Allowed value types: `string, number (finite), boolean, null`, plus
  plain-JSON `Array` and `Object` (Object prototype must be exactly
  `Object.prototype`).
- Forbidden value types: `undefined`, functions, `Symbol`, `BigInt`,
  `Number.NaN`, `Number.POSITIVE_INFINITY`, `Number.NEGATIVE_INFINITY`,
  `Buffer`, `Date`, class instances, `Object.create(...)`, cycles.
- Maximum depth: `MAX_SUMMARY_DEPTH = 3`.

## `UNSAFE_SUMMARY_KEY` regex (`audit-service.ts:20`)

```ts
const UNSAFE_SUMMARY_KEY =
  /(?:password|secret|token|credential|authorization|cookie|passport|documentNumber|dateOfBirth|nationality|rawBody|requestBody|prompt|conversation|privateMessage|payload)/i;
```

Any key matching this regex triggers `AuditSummaryValidationError("Unsafe
audit summary key: <key>")`. The regex is case-insensitive.

## `AuditSummaryValue` type

```ts
type AuditSummaryValue =
  | string
  | number
  | boolean
  | null
  | AuditSummaryValue[]
  | { [key: string]: AuditSummaryValue };
```

## Audit actions

The supported `AuditAction` values are:

- `PROFILE_CREATE`, `PROFILE_UPDATE`, `PROFILE_DELETE`
- `TRIP_CREATE`, `TRIP_JOIN`
- `TRIP_INVITATION_CREATE`, `TRIP_INVITATION_ACCEPT`, `TRIP_INVITATION_REVOKE`
- `TRIP_TITLE_UPDATE`, `TRIP_DRAFT_BRIEF_UPDATE`, `TRIP_ACTIVATE`
- `EXPLORATION_START`, `TRIP_DEFAULT_THREAD_PROVISION`
- `CONSENT_GRANT`, `CONSENT_REVOKE`
- `PLAN_CREATE`, `PLAN_STALE`, `PLAN_REPLAN`, `PLAN_RESTART`
- `FLIGHT_SEARCH_REQUESTED`, `FLIGHT_SEARCH_COMPLETED`, `FLIGHT_SEARCH_UNAVAILABLE`
- `CONFIRMATION_SET`
- `BOOKING_SUBMIT`, `BOOKING_RESULT`
- `CHANGE_EVENT`, `VISA_CHECK`
- `CHAT_THREAD_CREATE`, `CHAT_THREAD_DELETE`, `CHAT_MESSAGE_APPEND`
- `SKILL_INVOKE`, `AGENT_RUN`, `AGENT_TASK`

## Failure modes

| Cause | Error message | When |
| --- | --- | --- |
| Depth > 3 | `Audit summary exceeds maximum depth 3` | Nested past root + 3 levels. |
| Non-finite number | `Audit summary numbers must be finite` | `NaN`, `Infinity`. |
| Cycle | `Audit summary cannot contain cycles` | Object/Array referenced twice. |
| Non-Object prototype | `Audit summary objects must use the plain Object prototype` | Class instance, `Object.create`, `Buffer`, `Date`. |
| Other type (function, Symbol, BigInt, undefined) | `Unsupported audit summary value: <typeof>` | Anything not in the allowed list. |
| Sensitive key | `Unsafe audit summary key: <key>` | Key matches `UNSAFE_SUMMARY_KEY`. |

## Call sites

Exactly one: `audit-service.ts:78` inside `recordAudit`. There are no other
callers; if you need to validate a value before calling `recordAudit`, you
must call `whitelistSummary` directly.

## Consumers

- Every service that calls `recordAudit`:
  `services/audit-service.ts`, `services/planning-service.ts`,
  `services/confirmation-service.ts`, `services/booking-service.ts`,
  `services/change-event-service.ts`,
  `tasks/task-repository.ts` (action `AGENT_TASK`),
  `agents/skill-registry.ts` (action `SKILL_INVOKE`),
  `providers/llm-gateway.ts` → `observability/agent-runs.ts` (action `AGENT_RUN`).

## Verification

- `npx vitest run tests/audit-whitelist.test.ts` — covers primitives,
  arrays, depth limits, unsupported values (Buffer/Date/class), cycles, and
  unsafe keys.
