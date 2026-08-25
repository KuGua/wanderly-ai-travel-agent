---
name: skill-registry
source-of-truth: ./skill-registry.ts
applies-to: [all skill invocations in services and routes]
---

# Skill Registry

`skill-registry.ts` is the single entry point through which every Skill is
invoked. It enforces (1) registration-time scope consistency, (2) per-call
`AbortSignal` timeout, (3) input/output Zod validation, (4)
`lastUsedVersion` strict dedupe, and (5) `SKILL_INVOKE` audit emission.

## Source-of-truth

`./skill-registry.ts`.

## Scope & invariants

- `invokeSkill` is the only path a route or service may use to run a Skill.
- Every Skill invocation is logged once in `audit_events` with
  `action: "SKILL_INVOKE"` and a summary containing `skillName`, `version`,
  `outputHash`, `latencyMs`, `status`.
- `lastUsedVersion` is **strict per `(name, version)`** (NOT hash-based).
  See §Dedupe below.
- The registry does not write metrics directly. `LLMGateway` does, in
  [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md).

## Public surface

```ts
registerSkill<I, O>(skill: Skill<I, O>): void
getSkill(name: string): Skill<unknown, unknown>
listSkills(): Skill<unknown, unknown>[]
invokeSkill<I, O>(name: string, ctx: SkillContext, payload: unknown): Promise<O>
__resetRegistryForTests(): void
```

## Registration (`registerSkill`)

Order of checks:

1. **Duplicate name** → `SkillError('UNKNOWN_SKILL')` (registry uses
   `UNKNOWN_SKILL` for the duplicate case; see
   [ERROR-CODES.md](./ERROR-CODES.md)).
2. **`agent` kind validity** (must be `"personal" | "shared" | "review"`) →
   `SkillError('POLICY_DENIED')`.
3. **`allowedTools` is within agent-kind allow-list** — registration-time
   enforcement. A `personal` Skill declaring `bookings` or
   `plan:write:propose` is rejected with `SkillError('TOOL_NOT_ALLOWED')`.

The forbidden-scopes check is in
`skill-registry.ts:9-13` (constants) and `38-48` (enforcement).

## Invocation (`invokeSkill`)

Order of operations:

1. `getSkill(name)` → throws `SkillError('UNKNOWN_SKILL')` if missing.
2. **Snapshot check** — if `skill.agent === "shared"` and `ctx.snapshot`
   is undefined, throws `SkillError('SNAPSHOT_REQUIRED')`.
3. **Policy gate check** — calls
   `ctx.policyGate.requireScope(skill.allowedTools)`; a plain `Error` from
   `DefaultPolicyGate` is wrapped into
   `SkillError('TOOL_NOT_ALLOWED')`.
4. **Input Zod parse** — Zod failures become
   `SkillError('INPUT_INVALID')`.
5. **Timeout via `Promise.race`** — the registry spawns a rejecting
   `setTimeout(skill.timeoutMs)` race alongside `skill.handler(ctx, input, controller.signal)`.
   On timeout the registry throws `SkillError('TIMEOUT')` (504). The
   `AbortSignal` is forwarded to the handler so it can release external
   resources.
6. **Output Zod parse** — failures become `SkillError('OUTPUT_INVALID')`
   (422).
7. **Dedupe** — see below.
8. **Audit emission** — calls `recordAudit({ action: "SKILL_INVOKE", summary: { skillName, version, outputHash, latencyMs, status: "SUCCESS" } })`.
   `outputHash` is `sha256(canonicalize(value))` where `canonicalize`
   emits sorted-key JSON so order-insensitive equality is possible across
   runs.

## Dedupe (`lastUsedVersion` strict mode)

> When the same `skill.name` and `skill.version` are invoked a second time
> inside the same process, the registry throws
> `SkillError('OUTPUT_INVALID', 'stale_version_reuse')`.
>
> Source: `./skill-registry.ts:116-123`.

The dedupe is **not** hash-based. Two consequences:

- **Re-running with the same payload** (a deterministic replan after
  change-event invalidation) must use a new `version` string or be in a
  fresh process. Otherwise the second call throws `OUTPUT_INVALID`.
- **`__resetRegistryForTests()`** must be called between vitest cases
  whenever the same Skill is exercised more than once. Existing specs already
  call this in `beforeEach`.

## Failure mode mapping

| Cause | `SkillError.code` | HTTP |
| --- | --- | --- |
| Unknown Skill | `UNKNOWN_SKILL` | 404 |
| Skill scoped outside its agent allow-list (registration) | `TOOL_NOT_ALLOWED` | 403 |
| Input schema violation | `INPUT_INVALID` | 400 |
| Output schema violation | `OUTPUT_INVALID` | 422 |
| Timeout | `TIMEOUT` | 504 |
| Plan-output validation rejection (caller) | `PLAN_VALIDATION_FAILED` | 422 |
| Missing snapshot (shared) | `SNAPSHOT_REQUIRED` | 400 |
| Policy gate rejected (runtime) | `TOOL_NOT_ALLOWED` | 403 |
| Upstream failure (Skill-specific) | `UPSTREAM_FAILURE` | 502 |

Full mapping: [ERROR-CODES.md](./ERROR-CODES.md).

## Consumers

- `../skills/shared/plan-comparison-skill.ts` (only Skill that invokes the
  LLM gateway).
- `apps/api/src/services/planning-service.ts` invokes
  `plan.comparison` when generating a plan.

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-integration.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
