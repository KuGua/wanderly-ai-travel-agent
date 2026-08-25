---
name: personal.profile.memory
source-of-truth: ./profile-memory-skill.ts
agent: personal
status: implemented
---

# `personal.profile.memory` Skill

读取当前用户在该行程中已授权的 Profile 字段的快照投影。仅读，不写库，**不调用 LLM**。

> 字段来源于 `services/consent-service.ts:buildAuthorizedData` 写入 `constraint_snapshots.authorizedData` 的内容。该函数已显式排除 `passportNumber`（详见 [../../services/AUDIT.md](../../services/AUDIT.md) §call sites）。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `profile.memory` | `../agents/contracts.ts:Skill.name` |
| `agent` | `personal` | `../agents/contracts.ts:AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["profile:read"]` | `policy-gate.ts:9-13` 内 `personal` allow-list |
| `timeoutMs` | `2000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./profile-memory-skill.ts:5-9](./profile-memory-skill.ts)]

```ts
const profileMemoryInputSchema = z.object({
  tripId: z.string().uuid(),
  userId: z.string().uuid(),
  fields: z.array(z.string()).default([]),
}).strict();
```

- `fields` 过滤调用者想读的 Profile 键；空数组表示"全部已授权键"。

## 输出 Schema

[源：[./profile-memory-skill.ts:11-17](./profile-memory-skill.ts)]

```ts
const profileMemoryOutputSchema = z.object({
  items: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    source: z.enum(["profile", "this_trip"]),
  })),
}).strict();
```

每条 `item` 是单个 `{ field, value, source }` 三元组。本 Skill 中 `source` **始终**为 `"profile"`——它只读取长期 Profile，不读取 trip override。

## Handler 语义

1. 调用 `buildAuthorizedData({ tripId, userId })` 获取该成员的快照投影。
2. 按 `input.fields` 过滤返回键（空数组则不过滤）。
3. 把每个 `{ field, value }` 映射为 `{ field, value, source: "profile" }`。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `allowedTools` 必须落在 `personal` allow-list 内 | `agents/skill-registry.ts:38-48` | 注册期抛 `SkillError('TOOL_NOT_ALLOWED')` |
| `version` 是可固定的契约版本 | registry `expectedVersion` | 同版本可重复调用；不匹配时 `SKILL_VERSION_MISMATCH` |
| `input` 必须匹配 Zod schema | registry `input.parse` | `SkillError('INPUT_INVALID')` |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `INPUT_INVALID` | `input.fields` 不是字符串数组；`tripId/userId` 不是 UUID | 400 | 否（修正请求） |
| `OUTPUT_INVALID` | 输出 schema 违规 | 422 | 否（修正 Skill 输出） |
| `TIMEOUT` | handler 超过 2000ms | 504 | 是（同 payload） |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `personal` scope | 403 | 否（修正 Skill 定义） |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — `Skill<I,O>` 形态
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — 重复调用与 expected-version 契约
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md) — 错误码全集
- [../../services/consent-service.ts](../../services/consent-service.ts) — 数据源

## Verification

- `npx vitest run tests/skill-registry.test.ts` — 注册 + invoke + dedupe
- `npx vitest run tests/skill-allowlist.test.ts` — `Personal + bookings` 注册拒绝
- `npm run docs:verify` — 文档与代码一致
