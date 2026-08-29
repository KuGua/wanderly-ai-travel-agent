---
name: skill-contract
source-of-truth: ./contracts.ts
applies-to: [skill-registry.ts, all skills/]
---

# Skill Contract

The `Skill<I, O>` interface (`contracts.ts:30-40`) is the canonical shape every
Personal / Shared / Review Skill must satisfy. The registry, policy gate, and
audit emission all assume these fields are present.

## Source-of-truth

`./contracts.ts` lines 30–40.

## Scope & invariants

- A Skill is a **typed Zod-validated capability** with a declared owner agent
  kind, an allow-list of tools, a hard timeout, and an optional `version`.
- Skills are stateless. Anything they need at invocation time arrives via the
  `SkillContext` (request context, optional snapshot, policy gate).
- The same `Skill` object is reused across all invocations; no per-call
  construction.

## Symbols

### `AgentKind` (`contracts.ts:5`)

```ts
type AgentKind = "personal" | "shared" | "review" | "public-content";
```

Determines which scopes a Skill may declare (see [§Allowed tools](#allowed-tools))
and which default policy applies at invocation time.

### `SkillScope` (`contracts.ts:7-18`)

The 14-element union every Skill's `allowedTools` is constrained to:

```ts
type SkillScope =
  | "profile:read"
  | "profile:write:propose"
  | "consent:read"
  | "plan:write:propose"
  | "readiness:read"
  | "bookings"
  | "snapshot:read"
  | "chat:read"
  | "flight:search"
  | "activities:search"
  | "places:search"
  | "places:adopt"
  | "navigation:route"
  | "mobility:search";
```

### `PolicyGate` (`contracts.ts:20-22`)

```ts
interface PolicyGate {
  requireScope(scopes: readonly SkillScope[]): void;
}
```

Consulted by the registry **before** invoking a handler. `DefaultPolicyGate`
in `policy-gate.ts:9-13` throws a plain `Error` (not `SkillError`) when a Skill
declares a scope outside its agent kind's allow-list; the registry wraps the
plain error into `SkillError('TOOL_NOT_ALLOWED')` (see
[REGISTRY.md](./REGISTRY.md)).

### `SkillContext` (`contracts.ts:24-28`)

```ts
interface SkillContext {
  ctx: RequestContext;
  snapshot?: ConstraintSnapshotData;
  flightSearch?: FlightSearchExecutionContext;
  activitiesSearch?: ActivitySearchExecutionContext;
  placeSearch?: PlaceSearchExecutionContext;
  navigation?: NavigationRouteExecutionContext;
  mobility?: MobilitySearchExecutionContext;
  policyGate: PolicyGate;
}
```

`snapshot` is **required** for every `agent: "shared"` Skill; the registry
throws `SkillError('SNAPSHOT_REQUIRED')` if missing (see
[REGISTRY.md](./REGISTRY.md)).

### `Skill<I, O>` (`contracts.ts:30-40`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | `string` | yes | Unique across the registry. |
| `agent` | `AgentKind` | yes | Drives `DefaultPolicyGate`. |
| `input` | `z.ZodType<I>` | yes | `.strict()` recommended; the registry parses payload with this schema. |
| `output` | `z.ZodType<O>` | yes | `.strict()` recommended; the registry validates the handler's return value. |
| `allowedTools` | `readonly SkillScope[]` | yes | Validated against the agent kind allow-list. |
| `timeoutMs` | `number` | yes | Hard upper bound; exceeded → `SkillError('TIMEOUT')`. |
| `needsConfirm` | `boolean` | yes | Hint for the UI; does not gate persistence. |
| `version` | `string` | yes | Contract version; callers may pin it with `invokeSkill(..., { expectedVersion })`. It does not limit repeat execution. |
| `handler` | `(ctx, input, signal) => Promise<O>` | yes | Must respect `AbortSignal`. |

### `SkillInvocationRecord` (`contracts.ts:42-48`)

The shape written to `audit_events` summary under `action: "SKILL_INVOKE"`.
The registry hashes the canonicalized output via SHA-256 to populate
`outputHash`.

## Allowed tools per agent kind

Defined in `policy-gate.ts:9-13`:

| AgentKind | Allowed `SkillScope` values |
| --- | --- |
| `personal` | `profile:read`, `profile:write:propose`, `consent:read`, `chat:read` |
| `shared` | `snapshot:read`, `plan:write:propose`, `readiness:read`, `flight:search`, `activities:search`, `places:search`, `places:adopt`, `navigation:route`, `mobility:search` |
| `review` | `snapshot:read`, `plan:write:propose` |
| `public-content` | none |

Any Skill whose `allowedTools` contains a value not in its agent kind's list
is rejected at **registration** with `SkillError('TOOL_NOT_ALLOWED')`
([REGISTRY.md](./REGISTRY.md)).

## Consumers

- `skill-registry.ts` imports every type from this file.
- `policy-gate.ts` imports `PolicyGate` + `AgentKind` + `SkillScope`.
- `errors.ts` does not import from this file but is the public sibling used by
  the same callers.
- All Skill files in `../skills/{personal,shared}/` import `Skill<I,O>`.

## Verification

- `npx vitest run tests/skill-registry.test.ts` — exercises successful
  repeated invocation, expected-version mismatch, timeout, output invalid,
  unknown skill rejection.
- `npx vitest run tests/skill-allowlist.test.ts` — exercises
  `Personal` + `bookings` registration-time rejection and
  `Personal → Shared` runtime rejection.
