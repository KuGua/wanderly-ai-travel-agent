---
name: policy-overview
source-of-truth: ./
applies-to: [plan-comparison-skill, planning-service]
---

# `apps/api/src/policy/`

The `policy/` directory enforces the deterministic boundary between the
LLM's structured output and authoritative plan state. Anything the LLM
generates passes through here before becoming a database row.

## Files

| File | Purpose | See also |
| --- | --- | --- |
| `plan-output-validator.ts` | Zod schema + per-field evidence comparison + provenance checks + throws `PlanValidationError`. | [VALIDATOR.md](./VALIDATOR.md) |
| `snapshot-policy.ts` | `assertFieldAllowed` — enforces that model-declared `constraintReferences` paths point to fields copied into the snapshot by `consent-service.buildAuthorizedData`. | [VALIDATOR.md §Constraint references](./VALIDATOR.md) |

## How to read this directory

1. Read [VALIDATOR.md](./VALIDATOR.md) for the 16 `PlanViolationCode` values,
 the `validatePlanOutput` flow, and what the validator throws vs returns.
2. The validator is invoked by `apps/api/src/skills/shared/plan-comparison-skill.ts`
 after the LLM gateway returns; the Skill catches `PlanValidationError` and
 rethrows it as `SkillError('PLAN_VALIDATION_FAILED', 422, violations)`.

## Consumers

- `apps/api/src/skills/shared/plan-comparison-skill.ts` — the only
  runtime caller.
- `apps/api/tests/plan-output-validator.test.ts` and
  `apps/api/tests/plan-validator.test.ts` — exercise every violation code.

## Verification

- `npx vitest run tests/plan-output-validator.test.ts`
- `npx vitest run tests/plan-validator.test.ts` (integration via
  `generatePlan`)
