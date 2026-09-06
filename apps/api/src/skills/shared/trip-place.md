---
name: places.adopt
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
| `allowedTools` | `"snapshot:read"`, `"places:search"`, `"places:adopt"`, `"plan:write:propose"` | `skill.allowedTools` |
| `timeoutMs` | `8000` | per-call DB transaction deadline |
| `needsConfirm` | `false` | adoption is the user-confirming UI step |

## Contract and authorization

The input is a discriminated union by `action`:

```ts
| { action: "propose", candidateId, visibility, kind }
| { action: "adopt", placeId }
| { action: "revoke", placeId, reason }
```

`propose` names a candidate; it does not carry one. The caller supplies the
run's candidate store as `ctx.placeSearch.resolveCandidate`, and the skill
resolves `candidateId` through it. The branch used to accept the candidate's
own fields — display name, coordinates, `source`, `capturedAt` — from its
caller, and on the planning path the caller is the model, so a model could
name a place that does not exist and have invented coordinates and an invented
source persisted as trip evidence. A `candidateId` the run never issued is now
refused with `INPUT_INVALID` and nothing is written.

Server-only invariants enforced before any write:

- The model cannot submit `OWNER_PRIVATE` visibility with `kind` outside the
  snapshot's allowed categories; private places are still persisted but never
  participate in shared evidence (see `trip-place-service` for the audit
  chain).
- `adopt` rejects places that are not in `PROPOSED` state.
- `revoke` is idempotent on `REVOKED` rows.

## How the planning model calls it

The Shared planning tool loop does **not** offer this union. It offers three
flat tools — `places.propose`, `places.adopt`, `places.revoke` — and supplies
the `action` itself (`PLACE_MUTATION_ACTION_BY_TOOL` in `planning-service.ts`).

One tool carrying an `action` discriminator advertised
`{ action, candidateId, placeId }` while this schema required `visibility` +
`kind` for propose and `reason` for revoke, so all three actions were
uncallable; on 2026-09-06 a run spent its entire turn budget discovering that
one rejection at a time and produced no plan. `tests/planning-tool-contract.test.ts`
now holds each advertised schema against the branch that validates it.

The three tools are offered only when `places.search` is offered in the same
run: a `candidateId` is meaningful only inside the run that issued it.

## Output

`ACCEPTED` / `REVOKED` carry the persisted `placeId`. `REJECTED` carries a
bounded code (`PLACE_NOT_FOUND`, `PLACE_VISIBILITY_DENIED`,
`PLACE_CANDIDATE_STALE`, `PLACE_NOT_ADOPTABLE`).

## 失败模式

| Code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Non-shared agent tried to invoke this skill |
| `SNAPSHOT_REQUIRED` | No `ctx.snapshot` / `ctx.placeSearch` on the call |
| `INPUT_INVALID` | Zod parse failure (unknown action, missing fields), or a `candidateId` this run's `places.search` never returned |
| `POLICY_DENIED` | Snapshot mismatch, missing `actorUserId` |

## Verification

- `npx vitest run tests/trip-place-service.test.ts`
- `npx vitest run tests/trip-place-skill-candidate-authority.test.ts`
- `npx vitest run tests/planning-tool-contract.test.ts`
