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
  `TRIP_INVITATION_DECLINE`,
  `TRIP_TITLE_UPDATE`, `TRIP_DRAFT_BRIEF_UPDATE`, `TRIP_ACTIVATE`,
  `EXPLORATION_START`, `TRIP_DEFAULT_THREAD_PROVISION`,
  `TRIP_PIN_SESSION_WRITTEN`,
  `CONSENT_GRANT`, `CONSENT_REVOKE`, `CONSENT_GRANT_TRIP`, `CONSENT_REVOKE_TRIP`.
- Planning: `PLAN_CREATE`, `PLAN_STALE`, `PLAN_REPLAN`, `PLAN_RESTART`, `CONFIRMATION_SET`,
  `PLAN_REPLAN_ENQUEUED`, `PLAN_ADOPTION_VOTED`, `PLAN_ADOPTED`.
- Team constraint orchestration (Phase 2 / `docs/team-agent-orchestration-implementation.md` §8):
  `TRIP_CONSTRAINT_PROPOSED`, `TRIP_CONSTRAINT_CONFIRMED`, `TRIP_CONSTRAINT_REVOKED`.
  These summaries include only `proposalId`/`factId` opaque ids, field category
  (catalog-derived label, never the value), visibility enum, strength enum, and
  revision; `valueJson` is intentionally excluded.
- Member conversation handoff: `MEMBER_CONVERSATION_CANDIDATES_CREATED`,
  `MEMBER_CONVERSATION_HANDOFF_CONFIRMED`,
  `MEMBER_CONVERSATION_HANDOFF_REJECTED`. Summaries contain only bounded
  field categories, candidate version, selection count and operation/result;
  they never contain private-thread text, candidate values, batch IDs or fact IDs.
- Flight search: `FLIGHT_SEARCH_REQUESTED`, `FLIGHT_SEARCH_COMPLETED`, `FLIGHT_SEARCH_UNAVAILABLE`; summaries contain only provider, bounded outcome/error code, and safe correlation identifiers, never raw provider payloads.
- Flight offer freshness (`flight-offer-freshness-service.ts`, spec §6.2): `FLIGHT_OFFER_EXPIRED`, recorded when confirmation or booking rejects a selected flight offer as expired, missing a verifiable expiry, or sourced from a provider (SerpAPI, FlightAPI) that cannot supply one; adoption (`PROPOSED → ACTIVE`) does not check freshness and never records this action; summary contains only provider, the bounded reason, and the server-observed expiry/server-time comparison, never provider payloads.
- Activities search: `ACTIVITIES_SEARCH_REQUESTED`, `ACTIVITIES_SEARCH_COMPLETED`, `ACTIVITIES_SEARCH_UNAVAILABLE`; summaries contain only the bounded provider/outcome/error category and never activity titles, MCP payloads, prices or links.
- Accommodation discovery: `ACCOMMODATION_DISCOVERY_REQUESTED`, `ACCOMMODATION_DISCOVERY_COMPLETED`, `ACCOMMODATION_DISCOVERY_UNAVAILABLE`; summaries contain only bounded provider/outcome/count metadata and never destination text, accommodation names, coordinates, OSM identifiers or raw provider payloads.
- Hotel search: `HOTEL_SEARCH_REQUESTED`, `HOTEL_SEARCH_COMPLETED`, `HOTEL_SEARCH_UNAVAILABLE`; summaries contain only bounded provider/outcome/error categories and never destination text, property names, prices, occupancy, links or raw provider payloads. Provider-only quote authorization uses `HOTEL_PROVIDER_GRANTED`, `HOTEL_PROVIDER_REVOKED`, and `HOTEL_PROVIDER_SWITCH_BLOCKED`; summaries contain only provider, field and version/status metadata, never nationality or ciphertext.
- Stay preferences: `STAY_SEARCH_PREFERENCES_CONFIRMED`; summary contains only the new preference version, never occupancy or currency values.
- Personal research: `PERSONAL_RESEARCH_PROACTIVE_INTRO_ENQUEUED` and
  `PERSONAL_RESEARCH_TOOL_DISPATCH`. Summaries contain only safe state,
  bounded capability/field-count labels, version and counters; never user
  text, extracted values, Profile fields or provider payloads.
- Place, navigation, and mobility providers: `PLACE_SEARCH_REQUESTED`,
  `PLACE_SEARCH_COMPLETED`, `PLACE_SEARCH_UNAVAILABLE`,
  `NAVIGATION_ROUTE_REQUESTED`, `NAVIGATION_ROUTE_COMPLETED`,
  `NAVIGATION_ROUTE_UNAVAILABLE`, `MOBILITY_OFFER_REQUESTED`,
  `MOBILITY_OFFER_COMPLETED`, `MOBILITY_OFFER_UNAVAILABLE`. Summaries contain
  provider and bounded operation/outcome metadata only; never raw provider payloads.
- Trip places and research: `TRIP_PLACE_PROPOSED`, `TRIP_PLACE_ADOPTED`,
  `TRIP_PLACE_REVOKED`, `RESEARCH_RESULT_RECORDED`,
  `RESEARCH_COMMAND_ACCEPTED`, `RESEARCH_COMMAND_REJECTED`,
  `RESEARCH_COMPLETED`. Research-command summaries retain only safe task,
  operation, outcome, and status metadata; never user prompt or research
  content.
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
  /(?:password|secret|token|credential|authorization|cookie|passport|documentNumber|dateOfBirth|nationality|rawBody|requestBody|prompt|conversation|privateMessage|payload|valueJson|orchestratorConfidential|projectionManifest)/i;
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

For DRAFT Personal Research durable tasks, `PERSONAL_RESEARCH_COMMAND_ACCEPTED`,
`PERSONAL_RESEARCH_COMPLETED`, and `PERSONAL_RESEARCH_CANCELLED` retain only
safe task/capability/status identifiers, never the confirmed request input.

- `PROFILE_CREATE`, `PROFILE_UPDATE`, `PROFILE_DELETE`
- `TRIP_CREATE`, `TRIP_JOIN`
- `TRIP_INVITATION_CREATE`, `TRIP_INVITATION_ACCEPT`, `TRIP_INVITATION_REVOKE`,
  `TRIP_INVITATION_DECLINE`
- `TRIP_TITLE_UPDATE`, `TRIP_DRAFT_BRIEF_UPDATE`, `TRIP_ACTIVATE`
- `EXPLORATION_START`, `TRIP_DEFAULT_THREAD_PROVISION`, `TRIP_PIN_SESSION_WRITTEN`
- `CONSENT_GRANT`, `CONSENT_REVOKE`, `CONSENT_GRANT_TRIP`, `CONSENT_REVOKE_TRIP`
- `PLAN_CREATE`, `PLAN_STALE`, `PLAN_REPLAN`, `PLAN_RESTART`,
  `PLAN_REPLAN_ENQUEUED`, `PLAN_ADOPTION_VOTED`, `PLAN_ADOPTED`
- `FLIGHT_SEARCH_REQUESTED`, `FLIGHT_SEARCH_COMPLETED`, `FLIGHT_SEARCH_UNAVAILABLE`
- `FLIGHT_OFFER_EXPIRED`
- `ACTIVITIES_SEARCH_REQUESTED`, `ACTIVITIES_SEARCH_COMPLETED`, `ACTIVITIES_SEARCH_UNAVAILABLE`
- `ACCOMMODATION_DISCOVERY_REQUESTED`, `ACCOMMODATION_DISCOVERY_COMPLETED`, `ACCOMMODATION_DISCOVERY_UNAVAILABLE`
- `HOTEL_SEARCH_REQUESTED`, `HOTEL_SEARCH_COMPLETED`, `HOTEL_SEARCH_UNAVAILABLE`
- `HOTEL_PROVIDER_GRANTED`, `HOTEL_PROVIDER_REVOKED`, `HOTEL_PROVIDER_SWITCH_BLOCKED`
- `STAY_SEARCH_PREFERENCES_CONFIRMED`
- `PERSONAL_RESEARCH_PROACTIVE_INTRO_ENQUEUED`, `PERSONAL_RESEARCH_TOOL_DISPATCH`
- `PLACE_SEARCH_REQUESTED`, `PLACE_SEARCH_COMPLETED`, `PLACE_SEARCH_UNAVAILABLE`
- `NAVIGATION_ROUTE_REQUESTED`, `NAVIGATION_ROUTE_COMPLETED`, `NAVIGATION_ROUTE_UNAVAILABLE`
- `MOBILITY_OFFER_REQUESTED`, `MOBILITY_OFFER_COMPLETED`, `MOBILITY_OFFER_UNAVAILABLE`
- `TRIP_PLACE_PROPOSED`, `TRIP_PLACE_ADOPTED`, `TRIP_PLACE_REVOKED`
- `MEMBER_CONVERSATION_CANDIDATES_CREATED`, `MEMBER_CONVERSATION_HANDOFF_CONFIRMED`,
  `MEMBER_CONVERSATION_HANDOFF_REJECTED`
- `RESEARCH_RESULT_RECORDED`
- `RESEARCH_COMMAND_ACCEPTED`, `RESEARCH_COMMAND_REJECTED`, `RESEARCH_COMPLETED`
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

## Long-term memory actions

长期记忆的每个写操作都记审计，summary **只允许** action、field category、source、
status、count 与关联 ID，**禁止**出现 value、value hash、聊天正文、国籍、证件或行为时间线
（见 [long-term-memory-implementation.md](../../../docs/long-term-memory-implementation.md) §7）。

| Action | 触发点 | summary 允许字段 |
| --- | --- | --- |
| `MEMORY_PROPOSAL_CREATE` | `memory-proposal-service.ts:observeBehavior` | `fieldCategory`, `source`, `observationCount` |
| `MEMORY_PROPOSAL_CONFIRM` | `memory-proposal-service.ts:confirmProposal` | `fieldCategory`, `observationCount` |
| `MEMORY_PROPOSAL_DISMISS` | `memory-proposal-service.ts:dismissProposal` | `observationCount` |
| `PREFERENCE_FACT_UPDATE` | `preference-fact-service.ts:replaceFact` | `fieldCategory`, `source`, `superseded` |
| `PREFERENCE_FACT_DELETE` | `preference-fact-service.ts:deleteFact` | `fieldCategory` |
| `TRIP_MEMORY_UPDATE` | `TripMemoryService`（待实现） | `fieldCategory`, `kind`, `source` |
| `TRIP_MEMORY_DELETE` | `TripMemoryService`（待实现） | `fieldCategory`, `kind` |
| `MEMORY_PROJECTION_CREATE` | `MemoryProjectionBuilder`（待实现） | `memberCount`, `fieldCount` |
| `MEMORY_INVALIDATION` | `MemoryInvalidationService`（待实现） | `scope`, `count` |

回归覆盖：`tests/memory-preference-facts.test.ts` 断言审计行中不含事实值。

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
