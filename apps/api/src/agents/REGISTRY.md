---
name: skill-registry
source-of-truth: ./skill-registry.ts
applies-to: [all skill invocations in services and routes]
---

# Skill Registry

`skill-registry.ts` is the single entry point through which every Skill is
invoked. It enforces (1) registration-time scope consistency, (2) per-call
`AbortSignal` timeout, (3) input/output Zod validation, (4) optional expected
contract-version matching, and (5) `SKILL_INVOKE` audit emission.

## Source-of-truth

`./skill-registry.ts`.

## Scope & invariants

- `invokeSkill` is the only path a route or service may use to run a Skill.
- Every Skill invocation is logged once in `audit_events` with
  `action: "SKILL_INVOKE"` and a summary containing `skillName`, `version`,
  `outputHash`, `latencyMs`, `status`.
- A Skill version describes its contract; it is not an idempotency key. The
  same registered version may run repeatedly across independent requests.
- The registry does not write metrics directly. `LLMGateway` does, in
  [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md).

## Public surface

```ts
registerSkill<I, O>(skill: Skill<I, O>): void
getSkill(name: string): Skill<unknown, unknown>
listSkills(): Skill<unknown, unknown>[]
invokeSkill<I, O>(name: string, ctx: SkillContext, payload: unknown,
  options?: { expectedVersion?: string }): Promise<O>
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
2. **Expected-version check** — when supplied, a mismatch is rejected with
   `SkillError('SKILL_VERSION_MISMATCH')` before policy, parsing, or handler execution.
3. **Policy gate check** — calls
   `ctx.policyGate.requireScope(skill.allowedTools)`; a plain `Error` from
   `DefaultPolicyGate` is wrapped into
   `SkillError('TOOL_NOT_ALLOWED')`.
4. **Snapshot check** — if `skill.agent === "shared"` and `ctx.snapshot`
   is undefined, throws `SkillError('SNAPSHOT_REQUIRED')`.
5. **Input Zod parse** — Zod failures become
   `SkillError('INPUT_INVALID')`.
6. **Timeout via `Promise.race`** — the registry spawns a rejecting
   `setTimeout(skill.timeoutMs)` race alongside `skill.handler(ctx, input, controller.signal)`.
   On timeout the registry throws `SkillError('TIMEOUT')` (504). The
   `AbortSignal` is forwarded to the handler so it can release external
   resources.
7. **Output Zod parse** — failures become `SkillError('OUTPUT_INVALID')`
   (422).
8. **Audit emission** — calls `recordAudit({ action: "SKILL_INVOKE", summary: { skillName, version, outputHash, latencyMs, status: "SUCCESS" } })`.
   `outputHash` is `sha256(canonicalize(value))` where `canonicalize`
   emits sorted-key JSON so order-insensitive equality is possible across
   runs.

## Version compatibility

Callers that pin a Skill contract pass `expectedVersion`. Matching versions
execute normally; mismatches fail with HTTP 409 before the handler runs. Calls
that omit the option accept the currently registered version. Repeated calls
to the same version are normal and continue to receive full policy, schema,
timeout, and audit enforcement.

## Failure mode mapping

| Cause | `SkillError.code` | HTTP |
| --- | --- | --- |
| Unknown Skill | `UNKNOWN_SKILL` | 404 |
| Expected version differs from registered version | `SKILL_VERSION_MISMATCH` | 409 |
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

- `../skills/shared/plan-comparison-skill.ts` and
  `../skills/personal/travel-conversation-skill.ts` invoke the model gateway.
- `apps/api/src/services/chat-conversation-service.ts` invokes
  `thread.recall` and `travel.conversation` for the owner-only conversation path.

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-integration.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
