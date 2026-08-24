---
name: personal.consent.explanation
source-of-truth: ./consent-explanation-skill.ts
agent: personal
status: implemented
---

# `personal.consent.explanation` Skill

Answers "what am I currently sharing on this trip?". Read-only. Does not
call the LLM.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `consent.explanation` | ... |
| `agent` | `personal` | ... |
| `version` | `1.0.0` | ... |
| `allowedTools` | `["consent:read"]` | Within `personal` allow-list. |
| `timeoutMs` | `2000` | ... |
| `needsConfirm` | `false` | ... |

## 输入 Schema

[Source: `./consent-explanation-skill.ts:5-8`]

```ts
const consentExplanationInputSchema = z.object({
  tripId: z.string().uuid(),
  userId: z.string().uuid(),
}).strict();
```

## 输出 Schema

[Source: `./consent-explanation-skill.ts:10-15`]

```ts
const consentExplanationOutputSchema = z.object({
  scopes: z.array(z.object({
    scope: z.string(),
    fields: z.array(z.string()),
  })),
}).strict();
```

`scope` strings are the `consent_scope` SQL enum values:
`PROFILE_BASIC`, `PROFILE_PREFERENCES`, `PROFILE_NATIONALITY`,
`PROFILE_DOCUMENTS`, `PROFILE_BUDGET`, `PROFILE_RESTRICTIONS`.
`fields` is the per-scope `field_list` from `consent_grants`.

## Handler 语义

1. Call `getActiveConsents({ tripId, userId })` which reads from
   `consent_grants` filtering `granted = true` and `revoked_at IS NULL`.
2. Map each grant to `{ scope, fields }`.

Only **active** grants are returned. Revoked grants are not surfaced (they
are still in the table with `granted = false` and `revoked_at` set).

## 强制约束

| Constraint | Implementation | Failure |
| --- | --- | --- |
| `allowedTools` within `personal` allow-list | registry | `SkillError('TOOL_NOT_ALLOWED')` at registration. |
| `version` only invoked once per process | `lastUsedVersion` strict dedupe | `SkillError('OUTPUT_INVALID', 'stale_version_reuse')`. |

## 失败模式

| code | Trigger | HTTP |
| --- | --- | --- |
| `INPUT_INVALID` | `tripId/userId` is not a UUID. | 400 |
| `OUTPUT_INVALID` | Output schema violation or `stale_version_reuse`. | 422 |
| `TIMEOUT` | Handler exceeds `2000ms`. | 504 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md)
- [../../agents/REGISTRY.md](../agents/REGISTRY.md)

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`