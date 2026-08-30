---
name: mobility.search
source-of-truth: ./mobility-search-skill.ts
agent: shared
status: stable
applies-to: [Shared PLAN/REPLAN durable tasks; web trip-workspace confirm UI]
---

# mobility.search

Pricing/fare estimates for taxi / private transfer / charter / car rental
between two already-adopted TripPlaces. The model only ever submits two
authorized `placeId`s plus `passengers`/`departureAt`/`serviceType`. The
adapter layer drops any `bookingUrl` before persistence; the skill never
carries booking authority.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `mobility.search` | constant |
| `agent` | `shared` | constant |
| `version` | `1.0.0` | constant |
| `allowedTools` | `"snapshot:read"`, `"mobility:search"` | `skill.allowedTools` |
| `timeoutMs` | `10000` | per-call upstream deadline |
| `needsConfirm` | `false` | selection is a downstream action |

## Contract and authorization

Input schema (model-visible, no `snapshotId`):

```ts
{
  originPlaceId: string;            // UUID, must belong to trip and be ACTIVE
  destinationPlaceId: string;     // UUID, must belong to trip and be ACTIVE
  passengers: number;              // 1..9
  departureAt: string;             // ISO-8601 with offset
  serviceType: "TAXI" | "TRANSFER" | "CHARTER" | "RENTAL";
}
```

The dispatcher injects `snapshotId` from the run-bound task row before
invocation. The skill rejects:

- a `snapshotId` that does not match the run-bound value
- origin equal to destination
- `passengers` outside `1..9`

`PLAN_ENABLE_MOBILITY=false` short-circuits the entire capability with
`UNAVAILABLE/NOT_CONFIGURED` regardless of whether Amadeus credentials
are configured.

## Output

`LIVE` carries a stable `queryId` (the `provider_search_runs.id`) and 1..20
offers. Each offer exposes `offerId`, `serviceType`, `originPlaceId`,
`destinationPlaceId`, `passengers`, `departureAt`, `estimatedPrice`,
`currency`, `vehicleClass`, `estimated:true`, `expiresAt`, `source`,
`capturedAt`. **No `bookingUrl` is ever returned**; the adapter strips it
before persistence and the skill / DTO never reintroduces it.

`UNAVAILABLE` carries a bounded `ProviderUnavailableCode`. Selection of a
specific offer triggers the booking-sandbox gate in `services/booking-service.ts`
(not this skill).

## 失败模式

| Code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Non-shared agent tried to invoke this skill |
| `SNAPSHOT_REQUIRED` | No `ctx.snapshot` / `ctx.mobility` on the call |
| `INPUT_INVALID` | Zod parse failure (wrong serviceType, malformed UUIDs) |
| `POLICY_DENIED` | Snapshot mismatch, origin=destination, per-flag off |
| `TIMEOUT` | 10s deadline exceeded |

## Verification

- `npx vitest run tests/mobility-search-service.test.ts`
- `npx vitest run tests/mobility-search-skill.test.ts`
- `npx vitest run tests/amadeus-transfer-provider.test.ts`
