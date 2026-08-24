---
name: personal.profile.change_proposal
source-of-truth: ./profile-change-proposal-skill.ts
agent: personal
status: implemented
---

# `personal.profile.change_proposal` Skill

Returns a non-persisting proposal for a Profile field change. The handler
**does not write to the database**. Persistence is the caller's job after
explicit user confirmation (`needsConfirm: true`).

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `profile.change_proposal` | `../agents/contracts.ts:Skill.name` |
| `agent` | `personal` | ... |
| `version` | `1.0.0` | ... |
| `allowedTools` | `["profile:write:propose"]` | Within `personal` allow-list (proposals, not writes). |
| `timeoutMs` | `1000` | ... |
| `needsConfirm` | `true` | UI must prompt before persisting. |

## 输入 Schema

[Source: `./profile-change-proposal-skill.ts:6-22`]

```ts
const profileChangeProposalInputSchema = z.object({
  userId: z.string().uuid(),
  field: z.string().min(1).max(64)
    .refine(field => !SENSITIVE_FIELDS.includes(field), { message: "..." }),
  value: z.unknown(),
  source: z.enum(["profile", "this_trip"]),
}).strict().superRefine((data, ctx) => {
  if (data.field === "nationality" && data.source !== "this_trip") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["field"], message: "..." });
  }
});
```

Where `SENSITIVE_FIELDS = ["passportNumber", "dateOfBirth"]` (line 3).

### Hard-rejected fields

- `passportNumber`, `dateOfBirth` — always rejected, regardless of source.
- `nationality` — rejected **unless** `source === "this_trip"` (a trip-local
  override, not a stable Profile change).

## 输出 Schema

[Source: `./profile-change-proposal-skill.ts:24-29`]

```ts
const profileChangeProposalOutputSchema = z.object({
  field: z.string(),
  value: z.unknown(),
  source: z.enum(["profile", "this_trip"]),
  proposedAt: z.string().datetime(),
}).strict();
```

`proposedAt` is `new Date().toISOString()` at invocation time.

## Handler 语义

Pure passthrough:

1. Echo `field`, `value`, `source` from input.
2. Stamp `proposedAt` with the current time.
3. Return the proposal.

The Skill **never** writes to `user_profiles` or any other table. The caller
must invoke the persistence layer after the user accepts the proposal.

## 强制约束

| Constraint | Implementation | Failure |
| --- | --- | --- |
| `field ∈ {passportNumber, dateOfBirth}` blocked | Zod `.refine(...)` (lines 7-9) | `SkillError('INPUT_INVALID')` (Zod failure surfaces as INPUT_INVALID). |
| `field === "nationality"` requires `source === "this_trip"` | Zod `.superRefine(...)` (lines 14-19) | `SkillError('INPUT_INVALID')`. |
| No DB writes anywhere | The handler has no `db.insert(...)`. | (Verified by manual review; no metric.) |

## 失败模式

| code | Trigger | HTTP |
| --- | --- | --- |
| `INPUT_INVALID` | Sensitive field; `nationality` with non-`this_trip` source; non-UUID `userId`; empty / >64-char field; non-`profile \| this_trip` `source`. | 400 |
| `OUTPUT_INVALID` | Output schema violation or `stale_version_reuse`. | 422 |
| `TIMEOUT` | Handler exceeds `1000ms`. | 504 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md)
- [../../agents/REGISTRY.md](../agents/REGISTRY.md)

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`