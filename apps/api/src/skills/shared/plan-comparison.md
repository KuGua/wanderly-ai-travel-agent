---
name: shared.plan.comparison
source-of-truth: ./plan-comparison-skill.ts
agent: shared
status: implemented
---

# `shared.plan.comparison` Skill

The **only** Skill that calls the LLM. Generates a structured candidate plan
by combining the constraint snapshot's authorised data with deterministic
provider evidence, then validates the model's structured output against the
snapshot and the evidence before returning.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `plan.comparison` | ... |
| `agent` | `shared` | ... |
| `version` | `1.0.0` | ... |
| `allowedTools` | `["plan:write:propose", "snapshot:read"]` | Within `shared` allow-list. |
| `timeoutMs` | `10000` | ... |
| `needsConfirm` | `false` | ... |

## 输入 Schema

[Source: `./plan-comparison-skill.ts:7-13`]

```ts
const planComparisonInputSchema = z.object({
  destination: z.string().min(1),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  memberPreferences: z.record(z.string(), z.unknown()).default({}),
}).strict();
```

`flights/stays/ground` are already-cast typed arrays in production
(`FlightOffer[]` etc.); the schema accepts `unknown[]` so the validator can
deeply compare against the original provider evidence.

`memberPreferences` is the snapshot's `authorizedData` projection, already
filtered by `consent-service.buildAuthorizedData` so `passportNumber`,
`documentNumber`, `nationality`, `dateOfBirth` are not present unless the
member explicitly granted that scope.

## 输出 Schema

[Source: `./plan-comparison-skill.ts:15-21`]

```ts
const planComparisonOutputSchema = z.object({
  destination: z.string(),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  generatedAt: z.string().optional(),
}).strict();
```

The Skill returns the validated `planOutputSchema` (from
[../../policy/VALIDATOR.md](../../policy/VALIDATOR.md)) — the per-field
strict Zod with `id/origin/destination/priceUsd/isRedEye/...`.

## Handler 语义

1. Require `ctx.snapshot` (shared Skill invariant).
2. Acquire `modelGateway()` from `providers/gateway-factory.ts`.
3. Call `gateway.generateStructuredPlan({ destination, flights, stays, ground, memberPreferences, signal, ctx: ctx.ctx })`. The gateway either returns a real LLM response or falls back to `MockModelGateway`.
4. Call `validatePlanOutput({ planData: candidatePlanData, snapshot, evidence: { flights, stays, ground } })`.
5. Return the validated plan on success; throw `SkillError('PLAN_VALIDATION_FAILED', 422, violations)` on any validator rejection.

## 强制约束

| Constraint | Implementation | Failure |
| --- | --- | --- |
| Shared Skill must have `ctx.snapshot` | `agents/skill-registry.ts:67-69` | `SkillError('SNAPSHOT_REQUIRED')`. |
| Validator fails closed | `policy/plan-output-validator.ts` always throws on violations. | `SkillError('PLAN_VALIDATION_FAILED', 422, violations)`. |
| LLM fallback on any failure | `providers/llm-gateway.ts` `fallbackToMock` | All 4 trigger classes (client load, retry exhaustion, timeout, schema parse) — see [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md). |
| Sensitive fields must not appear in output | `policy/plan-output-validator.ts:STRUCTURE_INVALID` rejects; `src/services/AUDIT.md` redaction strips on logging. | Plan rejected or audit rejected. |
| `lastUsedVersion` strict dedupe | `agents/skill-registry.ts:116-123` | `SkillError('OUTPUT_INVALID', 'stale_version_reuse')` on second call. |

## LLM constraint surface

The LLM gateway runs at
[../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md):

- OpenAI Chat Completions `client.beta.chat.completions.parse(...)` with
  `response_format: { type: "json_object" }` and `signal`.
- System prompt: "You are the Shared Trip planning skill. Return one JSON
  object with exactly one top-level plan field. The plan must contain
  destination, flights, stays, ground, and generatedAt. Never include PII,
  passport numbers, or fields outside the supplied snapshot."
- `parsedCompletionSchema` (Zod) re-validates the parsed model output before
  the gateway returns it to the Skill.
- 4 fallback-to-mock trigger classes (client load, retry exhaustion, timeout,
  schema parse); all record to `agent_runs` and `provider_fallback_total`.

The validator then enforces deep-strict-equal evidence matching, snapshot
field allow-list, and provenance fields. The LLM is not trusted on
prices, times, sources, or member fields.

## 失败模式

| code | Trigger | HTTP |
| --- | --- | --- |
| `SNAPSHOT_REQUIRED` | `ctx.snapshot` missing. | 400 |
| `INPUT_INVALID` | Zod failure on input. | 400 |
| `OUTPUT_INVALID` | Output Zod failure or `stale_version_reuse`. | 422 |
| `PLAN_VALIDATION_FAILED` | `validatePlanOutput` threw any violation. | 422 |
| `TIMEOUT` | Handler exceeds `10000ms` (LLM call). | 504 |
| `TOOL_NOT_ALLOWED` | Registration-time only — `allowedTools` contains a non-`shared` scope. | 403 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — Skill shape.
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — dedupe + audit.
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md) — `PLAN_VALIDATION_FAILED` semantics.
- [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md) — what `validatePlanOutput` checks.
- [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md) — fallback triggers and `recordAgentRun`.
- [../../services/AUDIT.md](../../services/AUDIT.md) — `whitelistSummary` strict validation.
- [../../observability/README.md](../../observability/README.md) — `provider_fallback_total` and `agent_runs`.

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
- `npx vitest run tests/skill-integration.test.ts` — full happy + violation path.
- `npx vitest run tests/llm-gateway.test.ts` — fallback + success paths.
- `npx vitest run tests/plan-output-validator.test.ts` and
  `tests/plan-validator.test.ts` — all 11 violation codes.