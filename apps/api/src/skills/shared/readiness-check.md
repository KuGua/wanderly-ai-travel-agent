---
name: shared.readiness.check
source-of-truth: ./readiness-skill.ts
agent: shared
status: implemented
---

# `shared.readiness.check` Skill

Per-member readiness placeholder for visa/entry preparation. Returns a
fixed `PENDING` status for every requested member. Does **not** call the
LLM and does **not** consult a real visa data source today — the
`FixtureVisaProvider` exists in `providers/fixture-provider.ts` but is not
wired into this Skill.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `readiness.check` | ... |
| `agent` | `shared` | ... |
| `version` | `1.0.0` | ... |
| `allowedTools` | `["readiness:read", "snapshot:read"]` | Within `shared` allow-list. |
| `timeoutMs` | `2000` | ... |
| `needsConfirm` | `false` | ... |

## 输入 Schema

[Source: `./readiness-skill.ts:4-7`]

```ts
const readinessInputSchema = z.object({
  destination: z.string().min(1),
  memberIds: z.array(z.string().uuid()).min(1),
}).strict();
```

## 输出 Schema

[Source: `./readiness-skill.ts:9-15`]

```ts
const readinessOutputSchema = z.object({
  members: z.array(z.object({
    memberId: z.string().uuid(),
    status: z.enum(["PENDING", "OK"]),
    note: z.string(),
  })),
}).strict();
```

## Handler 语义

1. Map every `memberId` to `{ memberId, status: "PENDING", note: "Readiness pending — verify with official government sources" }`.
2. Return the resulting array.

The Skill does not call the LLM, does not consult the snapshot's
`authorizedData`, and does not look up real visa rules.

## 强制约束

| Constraint | Implementation | Failure |
| --- | --- | --- |
| `agent === "shared"` requires `ctx.snapshot` | `agents/skill-registry.ts:67-69` | `SkillError('SNAPSHOT_REQUIRED')`. |
| `allowedTools` within `shared` allow-list | registry | `SkillError('TOOL_NOT_ALLOWED')` at registration. |
| `version` only invoked once per process | `lastUsedVersion` strict dedupe | `SkillError('OUTPUT_INVALID', 'stale_version_reuse')`. |

## 失败模式

| code | Trigger | HTTP |
| --- | --- | --- |
| `SNAPSHOT_REQUIRED` | `ctx.snapshot` missing. | 400 |
| `INPUT_INVALID` | Empty `memberIds`, non-UUID `memberId`, empty `destination`. | 400 |
| `OUTPUT_INVALID` | Output schema violation or `stale_version_reuse`. | 422 |
| `TIMEOUT` | Handler exceeds `2000ms`. | 504 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md)
- [../../agents/REGISTRY.md](../agents/REGISTRY.md)
- [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md) — sibling validator
- (this Skill is a placeholder; future versions will integrate with the
  validator's snapshot policy and the `FixtureVisaProvider`.)

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
- `npx vitest run tests/skill-integration.test.ts`