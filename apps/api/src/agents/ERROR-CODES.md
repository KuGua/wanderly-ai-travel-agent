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
  | "TOOL_NOT_ALLOWED"
  | "INPUT_INVALID"
  | "OUTPUT_INVALID"
  | "TIMEOUT"
  | "PLAN_VALIDATION_FAILED"
  | "SNAPSHOT_REQUIRED"
  | "POLICY_DENIED"
  | "UPSTREAM_FAILURE";
```

## HTTP status mapping (`errors.ts:12-22`)

```ts
const SKILL_ERROR_STATUS: Record<SkillErrorCode, number> = {
  UNKNOWN_SKILL: 404,
  TOOL_NOT_ALLOWED: 403,
  INPUT_INVALID: 400,
  OUTPUT_INVALID: 422,
  TIMEOUT: 504,
  PLAN_VALIDATION_FAILED: 422,
  SNAPSHOT_REQUIRED: 400,
  POLICY_DENIED: 403,
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
| `TOOL_NOT_ALLOWED` | (a) Registration with scope outside agent-kind allow-list; (b) Runtime when `DefaultPolicyGate.requireScope` rejects. | Wraps a plain `Error` from `policy-gate.ts`. |
| `INPUT_INVALID` | `skill.input.parse(payload)` Zod failure. | Message includes the Zod issue path. |
| `OUTPUT_INVALID` | (a) `skill.output.parse(handlerResult)` Zod failure; (b) `lastUsedVersion` strict dedupe (`stale_version_reuse`). | Both reuse the same code. |
| `TIMEOUT` | `Promise.race` rejecting timer fires within `skill.timeoutMs`. | Handler must respect the forwarded `signal` to release resources. |
| `PLAN_VALIDATION_FAILED` | `plan.comparison` Skill when `policy/plan-output-validator.ts` throws `PlanValidationError`. | The Skill catches the validator exception and rethrows as `SkillError(code, message, violations)`. |
| `SNAPSHOT_REQUIRED` | Shared Skill invoked without `ctx.snapshot`. | Plan comparison throws this when `snapshot` is missing. |
| `POLICY_DENIED` | Invalid `agent` kind value at registration. | Not a runtime/operational error path. |
| `UPSTREAM_FAILURE` | Reserved for Skills that wrap external providers (none today). | The `LLMGateway` does NOT use this — it falls back to mock instead and records via `provider_fallback_total`. |

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
- `skill-registry.ts` throws 7 of the 9 codes (all except `POLICY_DENIED`
  and `UPSTREAM_FAILURE`).
- `plan-comparison-skill.ts` throws `SNAPSHOT_REQUIRED`,
  `PLAN_VALIDATION_FAILED`.

## Verification

- `npx vitest run tests/skill-registry.test.ts` — covers 6 of the codes.
- `npx vitest run tests/skill-integration.test.ts` — covers
  `PLAN_VALIDATION_FAILED` end-to-end.
- `npx vitest run tests/skill-allowlist.test.ts` — covers `TOOL_NOT_ALLOWED`.