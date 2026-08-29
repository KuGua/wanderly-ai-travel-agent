---
name: shared.places.adopt
source-of-truth: ./trip-place-skill.ts
agent: shared
status: stable
applies-to: [Shared PLAN/REPLAN durable tasks; web trip-workspace confirm UI]
---

# places.adopt

Server-authoritative TripPlace lifecycle. Three actions: `propose`, `adopt`,
`revoke`. `adopt` and `revoke` are atomic with respect to dependent
`navigation_route_evidence` and the trip's `ACTIVE` plan + confirmations —
all of them flip to `STALE` in the same transaction so downstream route
evidence can never outlive its referenced place.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `places.adopt` | constant |
| `agent` | `shared` | constant |
| `version` | `1.0.0` | constant |
| `allowedTools` | `["snapshot:read", "places:search", "places:adopt", "plan:write:propose"]` | `skill.allowedTools` |
| `timeoutMs` | `8000` | per-call DB transaction deadline |
| `needsConfirm` | `false` | adoption is the user-confirming UI step |

## Contract and authorization

The input is a discriminated union by `action`:

```ts
| { action: "propose", visibility, kind, candidate: PlaceCandidate }
| { action: "adopt", placeId }
| { action: "revoke", placeId, reason }
```

Server-only invariants enforced before any write:

- The model cannot submit `OWNER_PRIVATE` visibility with `kind` outside the
  snapshot's allowed categories; private places are still persisted but never
  participate in shared evidence (see `trip-place-service` for the audit
  chain).
- `adopt` rejects places that are not in `PROPOSED` state.
- `revoke` is idempotent on `REVOKED` rows.

## Output

`ACCEPTED` / `REVOKED` carry the persisted `placeId`. `REJECTED` carries a
bounded code (`PLACE_NOT_FOUND`, `PLACE_VISIBILITY_DENIED`,
`PLACE_CANDIDATE_STALE`, `PLACE_NOT_ADOPTABLE`).

## 失败模式

| Code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Non-shared agent tried to invoke this skill |
| `SNAPSHOT_REQUIRED` | No `ctx.snapshot` / `ctx.placeSearch` on the call |
| `INPUT_INVALID` | Zod parse failure (unknown action, missing fields) |
| `POLICY_DENIED` | Snapshot mismatch, missing `actorUserId` |

## Verification

- `npx vitest run tests/trip-place-service.test.ts`
- `npx vitest run tests/trip-place-skill.test.ts`
