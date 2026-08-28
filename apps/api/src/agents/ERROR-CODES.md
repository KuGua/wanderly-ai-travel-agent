---
name: skill-error-codes
source-of-truth: ./errors.ts
applies-to: [error-handler.ts, all skill invocations]
---

# Skill Error Codes

`SkillError` is the structured failure type thrown by the Skill registry and
by individual Skills. `error-handler.ts` recognises it on the way out and
maps the body to a JSON envelope that includes `code`, `violations`, and
`correlationId`.

## Source-of-truth

`./errors.ts`.

## `SkillErrorCode` union (`errors.ts:1-10`)

```ts
type SkillErrorCode =
  | "UNKNOWN_SKILL"
  | "SKILL_VERSION_MISMATCH"
  | "TOOL_NOT_ALLOWED"
  | "INPUT_INVALID"
  | "OUTPUT_INVALID"
  | "TIMEOUT"
  | "NETWORK"
  | "UPSTREAM_5XX"
  | "SCHEMA_PARSE"
  | "PLAN_VALIDATION_FAILED"
  | "SNAPSHOT_REQUIRED"
  | "POLICY_DENIED"
  | "SEARCH_PREFERENCES_STALE"
  | "UPSTREAM_FAILURE";
```

## HTTP status mapping (`errors.ts:12-22`)

```ts
const SKILL_ERROR_STATUS: Record<SkillErrorCode, number> = {
  UNKNOWN_SKILL: 404,
  SKILL_VERSION_MISMATCH: 409,
  TOOL_NOT_ALLOWED: 403,
  INPUT_INVALID: 400,
  OUTPUT_INVALID: 422,
  TIMEOUT: 504,
  NETWORK: 502,
  UPSTREAM_5XX: 502,
  SCHEMA_PARSE: 422,
  PLAN_VALIDATION_FAILED: 422,
  SNAPSHOT_REQUIRED: 400,
  POLICY_DENIED: 403,
  SEARCH_PREFERENCES_STALE: 409,
  UPSTREAM_FAILURE: 502,
};
```

## `SkillError` class (`errors.ts:29-45`)

```ts
class SkillError extends Error {
  readonly code: SkillErrorCode;
  readonly statusCode: number;
  readonly violations?: SkillViolation[];
  constructor(code: SkillErrorCode, message: string, violations?: SkillViolation[]);
}
```

`statusCode` is set automatically from `SKILL_ERROR_STATUS[code]`.

## `SkillViolation` (`errors.ts:24-27`)

```ts
interface SkillViolation {
  path: string;
  reason: string;
}
```

Used to carry `PlanValidationError.violations` through the registry to the
HTTP envelope (see [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md) for
the structured shape the validator emits).

## Per-code triggers

| code | Triggered by | Notes |
| --- | --- | --- |
| `UNKNOWN_SKILL` | Registry missing-name lookup; duplicate registration. | Registry uses this code for both cases. |
| `SKILL_VERSION_MISMATCH` | `invokeSkill` caller pins an `expectedVersion` different from the registered contract. | Rejected before policy, parsing, or handler execution; HTTP 409. |
| `TOOL_NOT_ALLOWED` | (a) Registration with scope outside agent-kind allow-list; (b) Runtime when `DefaultPolicyGate.requireScope` rejects. | Wraps a plain `Error` from `policy-gate.ts`. |
| `INPUT_INVALID` | `skill.input.parse(payload)` Zod failure. | Message includes the Zod issue path. |
| `OUTPUT_INVALID` | `skill.output.parse(handlerResult)` Zod failure. | Repeated execution of the same Skill version is valid. |
| `TIMEOUT` | `Promise.race` rejecting timer fires within `skill.timeoutMs`. | Handler must respect the forwarded `signal` to release resources. |
| `NETWORK` | Model/provider transport could not be reached. | Durable Worker may retry within its fixed attempt budget. |
| `UPSTREAM_5XX` | Model/provider returned a classified 5xx failure. | Durable Worker may retry within its fixed attempt budget. |
| `SCHEMA_PARSE` | Model output failed its strict final shape/content bound. | Terminal; never automatically retried or persisted as an ASSISTANT message. |
| `PLAN_VALIDATION_FAILED` | `plan.comparison` Skill when `policy/plan-output-validator.ts` throws `PlanValidationError`. | The Skill catches the validator exception and rethrows as `SkillError(code, message, violations)`. |
| `SNAPSHOT_REQUIRED` | Shared Skill invoked without `ctx.snapshot`. | Plan comparison throws this when `snapshot` is missing. |
| `POLICY_DENIED` | Invalid `agent` kind value at registration. | Not a runtime/operational error path. |
| `SEARCH_PREFERENCES_STALE` | `flight.search` execution context points to a missing, superseded, or changed confirmed preference version. | Terminal; create a fresh planning execution context. |
| `UPSTREAM_FAILURE` | Other classified model/provider failure. | Durable conversation execution retries only within the server-owned task budget; production never substitutes mock text. |

## HTTP envelope (`error-handler.ts`)

When the registry or any other call site throws `SkillError`, the global error
handler returns:

```json
{
  "statusCode": 422,
  "error": "PLAN_VALIDATION_FAILED",
  "message": "Plan output failed validator (3 violations)",
  "code": "PLAN_VALIDATION_FAILED",
  "violations": [
    { "path": "flights.0.origin", "reason": "Origin Mars not in snapshot.departureCities" }
  ],
  "correlationId": "…"
}
```

Fields always present: `statusCode`, `error`, `message`, `code`,
`correlationId`. `violations` is `[]` when not provided.

## Consumers

- `error-handler.ts` (in `../middleware/`) maps `SkillError` → JSON.
- `skill-registry.ts` owns registry/policy/parse/timeout codes; model-backed
  Skills preserve bounded network, upstream and schema classifications for the
  durable Worker without exposing provider error text.
- `plan-comparison-skill.ts` throws `SNAPSHOT_REQUIRED`,
  `PLAN_VALIDATION_FAILED`.

## Verification

- `npx vitest run tests/skill-registry.test.ts` — covers 6 of the codes.
- `npx vitest run tests/skill-integration.test.ts` — covers
  `PLAN_VALIDATION_FAILED` end-to-end.
- `npx vitest run tests/skill-allowlist.test.ts` — covers `TOOL_NOT_ALLOWED`.
