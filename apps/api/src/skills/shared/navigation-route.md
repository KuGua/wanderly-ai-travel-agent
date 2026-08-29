---
name: navigation-route
source-of-truth: ./navigation-route-skill.ts
agent: shared
status: stable
applies-to: [Shared PLAN/REPLAN durable tasks]
---

# navigation.route

Snapshot- and run-bound walking / driving / cycling route between two
already-adopted TripPlaces. The model only ever submits two authorized
`placeId`s plus a mode; coordinates are derived server-side from the
current-trip place table.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `navigation.route` | constant |
| `agent` | `shared` | constant |
| `version` | `1.0.0` | constant |
| `allowedTools` | `snapshot:read`, `navigation:route` | `skill.allowedTools` |
| `timeoutMs` | `10_000` | per-call upstream deadline |
| `needsConfirm` | `false` | route is informational, no booking authority |

## Contract and authorization

Input schema (model-visible, no `snapshotId`):

```ts
{
  originPlaceId: string;        // UUID, must belong to trip and be ACTIVE
  destinationPlaceId: string; // UUID, must belong to trip and be ACTIVE
  mode: "WALK" | "DRIVE" | "CYCLE";
}
```

The dispatcher injects `snapshotId` from the run-bound task row before
invocation. The skill / service layer rejects:

- `placeId`s whose visibility is `OWNER_PRIVATE`
- `placeId`s whose status is not `ACTIVE`
- a `snapshotId` that does not match the run-bound value
- modes outside `WALK` / `DRIVE` / `CYCLE`
- origin equal to destination

Per-run cap: enforced by the planner's `PLAN_MAX_ROUTE_QUERIES` env knob;
today's default is 24 invocations per agent task run.

## Output

`LIVE` outcomes carry a stable `routeId` (the `navigation_route_evidence.id`)
and a summary of `distanceMeters`, `durationSeconds`, `stepCount`, `source`,
`capturedAt`. The full encoded geometry is server-internal and never crosses
this boundary; it reaches the authorized Trip UI through a separate
snapshot-bound DTO.

`UNAVAILABLE` carries a bounded `ProviderUnavailableCode`. The route is NOT
inserted as `navigation_route_evidence`; downstream planning treats the
capability as `COMPLETED_WITH_GAPS` (see Phase 4 outcome matrix).

## 失败模式

| Code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Non-shared agent tried to invoke this skill |
| `SNAPSHOT_REQUIRED` | No `ctx.snapshot` / `ctx.navigation` on the call |
| `INPUT_INVALID` | Zod parse failure (wrong mode, malformed UUIDs) |
| `POLICY_DENIED` | Place not in trip, `OWNER_PRIVATE`, not `ACTIVE`, snapshot mismatch |
| `TIMEOUT` | 10s deadline exceeded |

## Verification

- `npx vitest run tests/navigation-route-service.test.ts`
- `npx vitest run tests/navigation-route-skill.test.ts`
- `npx vitest run tests/ors-navigation-provider.test.ts`