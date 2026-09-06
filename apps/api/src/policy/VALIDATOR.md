---
name: plan-output-validator
source-of-truth: ./plan-output-validator.ts
applies-to: [plan-comparison-skill.ts]
---

# Plan Output Validator

`validatePlanOutput({ planData, snapshot, evidence })` is the deterministic
gate between the LLM's structured output and `itinerary_plans.plan_data`. It
runs **after** the LLM Gateway, **before** the Skill returns, and is the only
component that decides whether the LLM's plan is allowed to become
authoritative state.

## Source-of-truth

`./plan-output-validator.ts` (`validatePlanOutput`, `planOutputSchema`,
`PlanValidationError`).

## Scope & invariants

- The validator is **fail-closed**: any structural mismatch or evidence
  disagreement throws `PlanValidationError` and the Skill converts it into
  `SkillError('PLAN_VALIDATION_FAILED', 422, violations)`. The plan row is
  never inserted on failure.
- Each offer in the LLM's plan must `isDeepStrictEqual` match the
  provider-scoped `evidence` (the offers returned by
  configured Flight/Stay/Ground providers).
  The validator never trusts the LLM on price, time, or source — only on
  *which* offer IDs it selects.
- `constraintReferences` must point to fields the snapshot actually carries
  (see [§Constraint references](#constraint-references)). This prevents
  the LLM from "justifying" recommendations with private Profile fields the
  trip owner never authorised.

## `PlanViolationCode` union (`plan-output-validator.ts:61-72`)

```ts
type PlanViolationCode =
  | "STRUCTURE_INVALID"
  | "FIELD_NOT_AUTHORIZED"
  | "ORIGIN_NOT_ALLOWED"
  | "ORIGIN_MISSING"
  | "DESTINATION_NOT_ALLOWED"
  | "DESTINATION_MISMATCH"
  | "DESTINATION_CANDIDATES_INCOMPLETE"
  | "SOURCE_REQUIRED"
  | "PROVENANCE_REQUIRED"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_MISMATCH"
  | "EVIDENCE_SLOT_MISMATCH"
  | "GENERATED_AT_MISMATCH"
  | "CONFIDENTIAL_VALUE_LEAK"
  | "EXPLANATION_TOKEN_NOT_ALLOWED"
  | "HARD_CONSTRAINT_UNSATISFIED";
```

## `PlanViolation` shape

```ts
interface PlanViolation {
  code: PlanViolationCode;
  fieldPath: string;
  reason: string;
}
```

`fieldPath` uses dotted JSON paths:
- `flights.0.origin`, `flights.0.source`
- `stays.0.destination`, `stays.0.style`
- `ground.0.destination`
- `destination` (top-level)
- `constraintReferences.0`
- `planData` (Zod parse root failure fallback)

## Per-code triggers

| Code | Trigger |
| --- | --- |
| `STRUCTURE_INVALID` | `planOutputSchema.safeParse(planData)` failed; `fieldPath` is the Zod issue path joined with `.` or `"planData"` when no path. |
| `FIELD_NOT_AUTHORIZED` | `constraintReferences[i]` failed `assertFieldAllowed(snapshot, path)`. |
| `ORIGIN_NOT_ALLOWED` | `plan.flights[i].origin` not in `snapshot.departureCities`. |
| `ORIGIN_MISSING` | Some `snapshot.departureCities` entry has no selected flight. |
| `DESTINATION_NOT_ALLOWED` | `plan.destination` not in `snapshot.destinationCandidates`. |
| `DESTINATION_MISMATCH` | An offer's `destination` does not equal `plan.destination`. |
| `SOURCE_REQUIRED` | An offer's `source` is empty/whitespace. |
| `PROVENANCE_REQUIRED` | An offer's `capturedAt` is empty or unparseable. |
| `EVIDENCE_NOT_FOUND` | An offer's `id` is not present in the provider evidence. |
| `EVIDENCE_MISMATCH` | An offer with the same `id` does not `isDeepStrictEqual` match the evidence. |
| `EVIDENCE_SLOT_MISMATCH` | An evidence id exists but belongs to another route, date, destination, or capability slot. |
| `GENERATED_AT_MISMATCH` | `plan.generatedAt` does not equal the latest `capturedAt` across all selected offers. |
| `DESTINATION_CANDIDATES_INCOMPLETE` | Spec §6.1 — `plan.destinationCandidatesEvaluated` does not cover every entry in `snapshot.destinationCandidates`, or names a destination not in the snapshot. |
| `CONFIDENTIAL_VALUE_LEAK` | Spec §6.1 — `assertConfidentialFree` found a confidential value or field-key reference in the plan JSON. |
| `HARD_CONSTRAINT_UNSATISFIED` | Deterministic evidence-backed evaluator rejected a selected offer; the message is a safe public token and never contains the protected value. |
| `EXPLANATION_TOKEN_NOT_ALLOWED` | Spec §6.1 — `plan.publicExplanationTokens` contains a token not on the safe allow-list derived from the v2 snapshot projection. |

## `validatePlanOutput` signature and behaviour

```ts
function validatePlanOutput(params: {
  planData: unknown;
  snapshot: ConstraintSnapshotData;
  evidence: PlanProviderEvidence;
}): ValidatedPlanOutput;
```

Returns the validated `ValidatedPlanOutput` (typed by `planOutputSchema`) when
zero violations. Throws `PlanValidationError` carrying `violations` when any
violation is detected — **including** when Zod schema parsing itself fails.
There is no silent fallback path.

## Constraint references

The validator consumes `plan.constraintReferences: string[]` (optional) and
asserts each entry against the snapshot using
`./snapshot-policy.ts:assertFieldAllowed`. The accepted path format is:

```
authorizedData.<memberId>.<fieldName>
```

Exactly 3 segments, non-empty. `<memberId>` must be a key of
`snapshot.authorizedData`; `<fieldName>` must be an own property of that
member's data. Anything else throws `SnapshotFieldNotAllowedError`, which
the validator catches and converts into `FIELD_NOT_AUTHORIZED`.

The prefix `authorizedData` is exported as
`SNAPSHOT_FIELD_PATH_PREFIX` in `snapshot-policy.ts:3`.

## Consumers

- `apps/api/src/skills/shared/plan-comparison-skill.ts` — invokes
  `validatePlanOutput({ planData: candidatePlanData, snapshot, evidence })`.
  The Skill catches `PlanValidationError` and rethrows as
  `SkillError('PLAN_VALIDATION_FAILED', 422, violations)`.

## Verification

- `npx vitest run tests/plan-output-validator.test.ts` — covers all 16 codes.
- `npx vitest run tests/plan-validator.test.ts` — integration: end-to-end
  flow including `generatePlan` reject-on-invalid path.
