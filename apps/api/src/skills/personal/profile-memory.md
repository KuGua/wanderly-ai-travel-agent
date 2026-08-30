---
name: personal.profile.memory
source-of-truth: ./profile-memory-skill.ts
agent: personal
status: implemented
---

# `personal.profile.memory` Skill

读取调用者本人的长期记忆（active preference facts），可选返回未确认的行为建议。仅读，不写库，**不调用 LLM**。

> 数据源为 `services/preference-fact-service.ts:listActiveFacts`，按 owner 过滤。依据 [long-term-memory-implementation.md](../../../../docs/long-term-memory-implementation.md) §5.2，本 Skill **不**以 Trip consent 为前置条件：consent 约束的是能否导出给 Shared Agent，而不是 owner 自己的 Agent 能否回忆 owner 说过的话。跨 Trip 读取正是跨会话记忆的实现方式。
>
> `suggestions` 是 `memory_proposals` 中的 PENDING 候选，**不是事实**。只有 owner 确认才会写入 active fact；行为聚合永远不能绕过确认。所有字段必须在 `memory/memory-field-catalog.ts` 中注册，未注册字段 fail closed；敏感 form-only 字段永不出现在此处。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `profile.memory` | `../agents/contracts.ts:Skill.name` |
| `agent` | `personal` | `../agents/contracts.ts:AgentKind` |
| `version` | `2.0.0` | `Skill.version` |
| `allowedTools` | `["profile:read"]` | `policy-gate.ts:9-13` 内 `personal` allow-list |
| `timeoutMs` | `2000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./profile-memory-skill.ts:5-9](./profile-memory-skill.ts)]

```ts
const profileMemoryInputSchema = z.object({
  tripId: z.string().uuid().optional(),
  fields: z.array(z.string()).default([]),
  includeSuggestions: z.boolean().default(false),
}).strict();
```

- `fields` 过滤想读的字段键；空数组表示"该 owner 的全部 active facts"。
- `tripId` 仅用于关联，不影响返回内容。
- `includeSuggestions` 为 `true` 时附带未确认候选。

## 输出 Schema

[源：[./profile-memory-skill.ts:11-17](./profile-memory-skill.ts)]

```ts
const profileMemoryOutputSchema = z.object({
  items: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    category: z.enum(["PREFERENCE", "CONSTRAINT"]),
    source: z.enum(["PROFILE_FORM", "PROPOSAL_CONFIRMATION"]),
    updatedAt: z.string(),
  })),
  suggestions: z.array(z.object({
    field: z.string(),
    value: z.unknown(),
    observationCount: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
  })).default([]),
}).strict();
```

`items` 是已确认的长期事实；`source` 说明它来自 Profile 表单还是提案确认。`suggestions` 是候选，调用方必须以"待确认"呈现，不得当作事实使用。行为证据本身（时间线、原始事件）不返回。

## Handler 语义

0. owner 取自 `ctx.actorUserId`，**不是** input 字段。skill input 由模型填写，把 owner 放进 input 意味着模型可以写出"读另一个人的记忆"这个请求，「始终是已认证调用方」就只是约定而非规则。`actorUserId` 缺失时直接抛错，不退回任何默认值。
1. 调用 `listActiveFacts(ownerUserId)` 读取该 owner 的 active facts。
2. 按 `input.fields` 过滤（空数组则不过滤）。
3. 丢弃未在 `MEMORY_FIELD_CATALOG` 注册的历史键——目录不再背书的字段不外发。
4. `includeSuggestions` 为 `true` 时，追加 `listSurfaceableProposals(ownerUserId)` 的候选。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `allowedTools` 必须落在 `personal` allow-list 内 | `agents/skill-registry.ts:38-48` | 注册期抛 `SkillError('TOOL_NOT_ALLOWED')` |
| `version` 是可固定的契约版本 | registry `expectedVersion` | 同版本可重复调用；不匹配时 `SKILL_VERSION_MISMATCH` |
| `input` 必须匹配 Zod schema | registry `input.parse` | `SkillError('INPUT_INVALID')` |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `INPUT_INVALID` | `input.fields` 不是字符串数组；`tripId` 不是 UUID | 400 | 否（修正请求） |
| `OUTPUT_INVALID` | 输出 schema 违规 | 422 | 否（修正 Skill 输出） |
| `TIMEOUT` | handler 超过 2000ms | 504 | 是（同 payload） |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `personal` scope | 403 | 否（修正 Skill 定义） |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — `Skill<I,O>` 形态
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — 重复调用与 expected-version 契约
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md) — 错误码全集
- [../../services/preference-fact-service.ts](../../services/preference-fact-service.ts) — 数据源
- [../../memory/memory-field-catalog.ts](../../memory/memory-field-catalog.ts) — 字段目录与敏感度

## Verification

- `npx vitest run tests/skill-registry.test.ts` — 注册 + invoke + dedupe
- `npx vitest run tests/skill-allowlist.test.ts` — `Personal + bookings` 注册拒绝
- `npm run docs:verify` — 文档与代码一致
