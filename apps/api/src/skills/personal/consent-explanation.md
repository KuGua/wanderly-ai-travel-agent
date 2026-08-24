---
name: personal.consent.explanation
source-of-truth: ./consent-explanation-skill.ts
agent: personal
status: implemented
---

# `personal.consent.explanation` Skill

回答"我在这趟行程里当前共享了什么"。只读。**不调用 LLM**。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `consent.explanation` | `Skill.name` |
| `agent` | `personal` | `AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["consent:read"]` | `personal` allow-list |
| `timeoutMs` | `2000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./consent-explanation-skill.ts:5-8](./consent-explanation-skill.ts)]

```ts
const consentExplanationInputSchema = z.object({
  tripId: z.string().uuid(),
  userId: z.string().uuid(),
}).strict();
```

## 输出 Schema

[源：[./consent-explanation-skill.ts:10-15](./consent-explanation-skill.ts)]

```ts
const consentExplanationOutputSchema = z.object({
  scopes: z.array(z.object({
    scope: z.string(),
    fields: z.array(z.string()),
  })),
}).strict();
```

`scope` 是 `consent_scope` SQL enum：
`PROFILE_BASIC`、`PROFILE_PREFERENCES`、`PROFILE_NATIONALITY`、
`PROFILE_DOCUMENTS`、`PROFILE_BUDGET`、`PROFILE_RESTRICTIONS`。
`fields` 是该 scope 下 `consent_grants.field_list`。

## Handler 语义

1. 调用 `getActiveConsents({ tripId, userId })` 读取
   `consent_grants`（过滤 `granted = true` 且 `revoked_at IS NULL`）。
2. 把每条 grant 映射为 `{ scope, fields }`。

仅返回**当前生效**的 grant。已撤销的（`granted = false` 且 `revoked_at` 非空）不会出现在结果里。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `allowedTools` 落在 `personal` allow-list | registry | 注册期抛 `SkillError('TOOL_NOT_ALLOWED')` |
| `version` 在同一进程内只允许 invoke 一次 | `lastUsedVersion` 严格去重 | 第二次调用抛 `SkillError('OUTPUT_INVALID', 'stale_version_reuse')` |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `INPUT_INVALID` | `tripId/userId` 不是 UUID | 400 | 否 |
| `OUTPUT_INVALID` | 输出 schema 违规；或 `stale_version_reuse` | 422 | 否 |
| `TIMEOUT` | handler 超过 2000ms | 504 | 是 |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `personal` scope | 403 | 否 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md)
- [../../agents/REGISTRY.md](../agents/REGISTRY.md)
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md)

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
- `npm run docs:verify`