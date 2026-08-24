---
name: personal.profile.change_proposal
source-of-truth: ./profile-change-proposal-skill.ts
agent: personal
status: implemented
---

# `personal.profile.change_proposal` Skill

返回一条 Profile 字段修改的 **proposal**。Handler **不写数据库**——持久化是调用方在用户明确确认（`needsConfirm: true`）之后的职责。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `profile.change_proposal` | `Skill.name` |
| `agent` | `personal` | `AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["profile:write:propose"]` | proposal 类操作，`personal` allow-list 允许 |
| `timeoutMs` | `1000` | `Skill.timeoutMs` |
| `needsConfirm` | `true` | UI **必须**在落库前再次确认 |

## 输入 Schema

[源：[./profile-change-proposal-skill.ts:6-22](./profile-change-proposal-skill.ts)]

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

其中 `SENSITIVE_FIELDS = ["passportNumber", "dateOfBirth"]`（文件第 3 行）。

### 硬拒绝字段

- `passportNumber`、`dateOfBirth` ——**任何 source 都拒绝**。
- `nationality` ——除非 `source === "this_trip"`（仅 trip 局部覆盖，不改长期 Profile）。

## 输出 Schema

[源：[./profile-change-proposal-skill.ts:24-29](./profile-change-proposal-skill.ts)]

```ts
const profileChangeProposalOutputSchema = z.object({
  field: z.string(),
  value: z.unknown(),
  source: z.enum(["profile", "this_trip"]),
  proposedAt: z.string().datetime(),
}).strict();
```

`proposedAt` 为 `new Date().toISOString()`（调用时刻）。

## Handler 语义

纯透传：

1. 回显 `field`、`value`、`source`。
2. 用当前时间戳打 `proposedAt`。
3. 返回 proposal。

Handler **从不**写 `user_profiles` 或任何其他表。调用方在用户接受 proposal 后再触发持久化。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `field ∈ {passportNumber, dateOfBirth}` 被拒 | Zod `.refine(...)`（line 7-9） | `SkillError('INPUT_INVALID')`（Zod 失败在 registry 包装） |
| `field === "nationality"` 必须 `source === "this_trip"` | Zod `.superRefine(...)`（line 14-19） | `SkillError('INPUT_INVALID')` |
| Handler 不写库 | Handler 中没有 `db.insert(...)` | （人工审查；无 metric） |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `INPUT_INVALID` | 敏感字段；`nationality` + 非 `this_trip` source；非 UUID `userId`；空 / >64 字符 `field`；非 `profile\|this_trip` 的 `source` | 400 | 否（修正请求） |
| `OUTPUT_INVALID` | 输出 schema 违规；或 `stale_version_reuse` | 422 | 否 |
| `TIMEOUT` | handler 超过 1000ms | 504 | 是 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md)
- [../../agents/REGISTRY.md](../agents/REGISTRY.md)
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md)

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
- `npm run docs:verify`