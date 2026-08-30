# Research Command — API Contract

> Zod schemas are the truth-of-truth (`apps/api/src/types/schemas.ts` Phase 0 skeletons).
> Runtime OpenAPI is emitted by `@fastify/swagger` from the Fastify route schemas (Phase 2).

## `POST /api/v1/trips/:tripId/research`

Owner (single required member) confirms a research intent. Server:

1. Validates caller is active required member.
2. Validates Trip is `PLANNING` or `STALE` (not `DRAFT`).
3. Validates candidates count matches mode (`SOLO` 1–5 / `TEAM` 2–5).
4. Checks capability dependencies (confirmed search preferences, consents, TripPlace states).
5. In one transaction: creates an immutable `constraint_snapshots` row + inserts `agent_task_runs` with `operation: "RESEARCH"`, `research_mode`, `requested_capabilities` + writes `outbox` event + audit `RESEARCH_COMMAND_ACCEPTED`.
6. Returns `202` envelope (or the cached 202 on idempotent retry of the same `requestId`).

### Request body (`researchCommandRequestSchema`)

```json
{
  "requestId": "uuid",
  "outputMode": "RESEARCH_ONLY | PROPOSE_PLAN",
  "requestedCapabilities": ["activities", "places"]
}
```

`.strict()` rejects any other key, including:

- `snapshotId`, `provider`, `toolCallId`
- `latitude`, `longitude`, `address`, `placeId`, `placeName`
- `dates`, `departureDate`, `returnDate`
- `currency`, `adults`, `cabin`
- `identity`, `userId`, `tripId`
- `question`, `prompt`, `messages`

### 202 response (`researchCommandAcceptedResponseSchema`)

```json
{
  "runId": "uuid",
  "operation": "RESEARCH",
  "snapshotId": "uuid",
  "status": "QUEUED"
}
```

`operation` is `"RESEARCH"` for the new endpoint; the legacy `POST /planning/generate` returns the same envelope with `operation: "PLAN"` (and internally delegates with `outputMode: "PROPOSE_PLAN"` and full capability set).

### Stable error codes

| HTTP | code | Trigger |
|---|---|---|
| 403 | `Forbidden` | Caller is not an active required member of `:tripId`. |
| 404 | `Not Found` | `:tripId` does not exist. |
| 409 | `TRIP_NOT_ACTIVE` | Trip is `DRAFT`. |
| 422 | `RESEARCH_DRAFT_REJECTED` | Trip is `DRAFT` (semantic mirror). |
| 422 | `RESEARCH_BRIEF_INVALID` | Candidate count violates mode rules (`SOLO` must be 1–5; `TEAM` must be 2–5). |
| 422 | `RESEARCH_CAPABILITY_GAP` | A requested capability has unmet server-side dependencies (e.g. no confirmed `trip_search_preferences`). |
| 422 | `Bad Request` (ZodError) | Body has unknown keys or shape errors. |

## SSE events

Phase 1+ adds two new variants to `agentStreamEventSchema`:

### `research.intent_extracted`

Emitted by the conversation skill when the model extracts a research draft from chat. Carries `personalResearchIntentSchema`. **Draft only** — never auto-runs.

### `research.stage`

Emitted by the orchestrator on lifecycle transitions. `stage` ∈ `researchStageSchema` (the 8 values in §4.3 of the spec). The route emits `SNAPSHOT_CREATED` after `acceptResearchTask` commits, before the Worker picks up; the Worker emits the remaining stages. All events pass through `publishAgentStreamEvent` with the 7 500-byte cap and Zod re-validation.

The existing `run.phase` channel keeps its current enum; `RESEARCHING / VALIDATING / PERSISTING / COMPLETED / FAILED / STALE` continue to ride `run.phase` for cross-cutting observability.

## Invariants the server enforces (Phase 2)

1. The request body **must not** carry authority fields (`snapshotId`, `provider`, `latitude`, etc.). `.strict()` is the only PII gate — server never reads them.
2. The Worker never reads chat content into `SkillContext.snapshot`, tool args, `provider_*` payload, `evidence`, log lines, or telemetry labels.
3. `RESEARCH_ONLY` writes only `planning_research_results` and run metadata. **Never** writes `itinerary_plans` or `bookings`.
4. `PROPOSE_PLAN` synthesizes `PROPOSED` exclusively through `generatePlan({ outputMode: "PROPOSE_PLAN" })`, gated by `validatePlanOutput`. Owner `ACCEPT` is required for `ACTIVE`.
5. Idempotency key is `research_command:{tripId}:{requestId}`; same key returns same 202.