---
name: places.search
source-of-truth: ./place-search-skill.ts
agent: shared
status: stable
applies-to: [Shared PLAN/REPLAN durable tasks]
---

# places.search

Restricted keyword POI search against the current Trip snapshot. Returns up
to five run-bound candidates per call; the model is never asked to submit
coordinates, provider name, or raw URLs.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `places.search` | constant |
| `agent` | `shared` | constant |
| `version` | `1.0.0` | constant |
| `allowedTools` | `"snapshot:read"`, `"places:search"` | `skill.allowedTools` |
| `timeoutMs` | `8000` | per-call upstream deadline |
| `needsConfirm` | `false` | no booking authority |

## Contract and authorization

Input schema (model-visible, no `snapshotId`):

```ts
{
  destinationId: string;        // 1..64, must match snapshot.destinationCandidates
  keyword: string;              // 1..160, never contains private markers
  category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
}
```

The dispatcher injects `snapshotId` from the run-bound task row before
invocation. The skill rejects:

- destinations outside `snapshot.destinationCandidates`
- keywords carrying `private` / `owner-only` / `do-not-share` markers
- a `snapshotId` that does not match the run-bound value

Per-run invocation cap: `PLACE_SEARCH_MAX_PER_RUN = 6`. The cap is enforced
at the skill boundary so a runaway model loop cannot exhaust provider quota.

## Output

`LIVE` outcomes carry a stable `queryId` (the inserted `provider_search_runs.id`)
and 1..5 candidates. Each candidate exposes `candidateId`, `displayName`,
`kind`, `countryCode`, `cityName`, `longitude`, `latitude`, `confidence`,
`needsUserConfirmation`, `source`, `capturedAt`. The model never sees raw
provider payloads or attribution metadata; both are surfaced to the web UI
via the snapshot-bound DTO.

`UNAVAILABLE` carries a bounded `ProviderUnavailableCode`. The candidate is
NOT promoted to a TripPlace and downstream planning treats the capability as
`COMPLETED_WITH_GAPS` (see Phase 4 outcome matrix).

## 失败模式

| Code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Non-shared agent tried to invoke this skill |
| `SNAPSHOT_REQUIRED` | No `ctx.snapshot` / `ctx.placeSearch` on the call |
| `INPUT_INVALID` | Zod parse failure (wrong category, oversized keyword) |
| `POLICY_DENIED` | Destination outside candidates, keyword carries private markers, snapshot mismatch |
| `TIMEOUT` | 8s deadline exceeded |

## Verification

- `npx vitest run tests/place-search-service.test.ts`
- `npx vitest run tests/place-search-skill.test.ts`
- `npx vitest run tests/ground-capability-router.test.ts`
