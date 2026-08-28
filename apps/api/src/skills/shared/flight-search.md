---
name: shared.flight.search
source-of-truth: ./flight-search-skill.ts
agent: shared
status: implemented
---

# `shared.flight.search` Skill

The Shared Agent's bounded flight-query capability. It accepts only strict,
snapshot-bound arguments and returns normalized evidence or a stable
`UNAVAILABLE` code. It never exposes provider payloads, credentials, private
snapshot fields, or internal errors.

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `flight.search` | `Skill.name` |
| `agent` | `shared` | `AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["snapshot:read", "flight:search"]` | `shared` allow-list |
| `timeoutMs` | `12000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## Contract and authorization

Input is the strict Phase 1 `flightSearchInputSchema`: controlled origin and
destination IDs, immutable `snapshotId`, trip type, confirmed dates, adults,
cabin, and ISO-4217 currency. The server-derived `SkillContext.flightSearch`
binds trip ID, snapshot ID, preference version, values, and optional task ID.
It is never model or client input.

Before calling the provider, the handler verifies the current stored preference
version, exact execution-context values, airport reference IDs, destination
candidate membership, dates, and every confirmed preference. It then calls the
Phase 1 search/evidence service with the registry-propagated abort signal.

## Output

- `LIVE`: a persisted `queryId` and strict normalized offers only.
- `UNAVAILABLE`: a bounded code; no raw provider error or payload.

## 失败模式

| code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Personal/Review or missing `flight:search` scope |
| `SNAPSHOT_REQUIRED` | Shared Skill invoked without snapshot |
| `INPUT_INVALID` | Malformed or excess tool argument |
| `POLICY_DENIED` | Missing execution context, snapshot mismatch, airport/destination/date/preference mismatch |
| `SEARCH_PREFERENCES_STALE` | Preference version is missing, superseded, or differs from execution context |
| `TIMEOUT` | Skill deadline/cancellation timeout |

## Verification

- `npm test -- --run tests/flight-search-skill.test.ts`
- `npm run docs:verify`
