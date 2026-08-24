---
name: personal.profile.memory
source-of-truth: ./profile-memory-skill.ts
agent: personal
status: implemented
---

# `personal.profile.memory` Skill

Read-only access to the user's private Profile fields that have been copied
into the trip's immutable constraint snapshot by
`services/consent-service.ts:buildAuthorizedData`. Does **not** call the LLM.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `profile.memory` | `../agents/contracts.ts:Skill.name` |
| `agent` | `personal` | ... |
| `version` | `1.0.0` | ... |
| `allowedTools` | `["profile:read"]` | All within the `personal` allow-list. |
| `timeoutMs` | `2000` | ... |
| `needsConfirm` | `false` | ... |

## 输入 Schema

[Source: `./profile-memory-skill.ts:5-9`]

```ts
const profileMemoryInputSchema = z.object({
  tripId: z.string().uuid(),
  userId: z.string().uuid(),
  fields: z.array(z.string()).default([]),
}).strict();
```

`fields` filters which authorised Profile keys the caller wants back. Empty
array means "all authorised keys".

## 输出 Schema

[Source: `./profile-memory-skill.ts:11-17`]

```ts
const profileMemoryOutputSchema = z.object({
  items: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    source: z.enum(["profile", "this_trip"]),
  })),
}).strict();
```

Every item is a single `{ field, value, source }` triple. `source` is
**always** `"profile"` for this Skill — it reads the long-term Profile only.

## Handler 语义

1. Call `buildAuthorizedData({ tripId, userId })` to get the per-member
   snapshot projection.
2. Filter the result's own keys to those requested in `input.fields`
   (or include all if `fields` is empty).
3. Map each `{ field, value }` to `{ field, value, source: "profile" }`.

## 强制约束

| Constraint | Implementation | Failure |
| --- | --- | --- |
| `allowedTools` within `personal` allow-list | `agents/skill-registry.ts:38-48` | `SkillError('TOOL_NOT_ALLOWED')` at registration. |
| `version` only invoked once per process | `agents/skill-registry.ts:116-123` | Second call throws `SkillError('OUTPUT_INVALID', 'stale_version_reuse')`. |
| `input` matches Zod schema | registry `input.parse` | `SkillError('INPUT_INVALID')`. |

## 失败模式

| code | Trigger | HTTP |
| --- | --- | --- |
| `INPUT_INVALID` | `input.fields` is not an array of strings, or `tripId/userId` is not a UUID. | 400 |
| `OUTPUT_INVALID` | (a) Output schema violation; (b) `stale_version_reuse`. | 422 |
| `TIMEOUT` | Handler exceeds `2000ms`. | 504 |
| `TOOL_NOT_ALLOWED` | Registration-time only — `allowedTools` contains a non-`personal` scope. | 403 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — `Skill<I,O>` shape.
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — `lastUsedVersion` dedupe.
- [../../services/consent-service.ts](../../services/consent-service.ts) — the
  `buildAuthorizedData` source this Skill reads.

## Verification

- `npx vitest run tests/skill-registry.test.ts` — exercises successful
  registration + invocation.
- `npx vitest run tests/skill-allowlist.test.ts` — exercises `Personal +
  bookings` rejection at registration.