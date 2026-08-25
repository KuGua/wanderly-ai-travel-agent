---
name: personal.thread.recall
source-of-truth: ./thread-recall-skill.ts
agent: personal
status: implemented
---

# `personal.thread.recall` Skill

读取 owner-only 私有对话线程中已**标记共享**的消息的脱敏摘要。仅读，不写库，**不调用 LLM**。

> 实现细节与 PRD / agent-architecture 锁定语义：raw transcript 永远不出 owner 会话，默认 LLM 上下文仅含服务端派生的脱敏摘要 + owner 显式标记 `markedSharedByOwner=true` 的消息。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `thread.recall` | `../agents/contracts.ts:Skill.name` |
| `agent` | `personal` | `../agents/contracts.ts:AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["chat:read"]` | `policy-gate.ts:9-13` 内 `personal` allow-list |
| `timeoutMs` | `2000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./thread-recall-skill.ts:5-9](./thread-recall-skill.ts)]

```ts
const threadRecallInputSchema = z.object({
  threadId: z.string().uuid(),
  limit: z.number().int().positive().max(100).default(20),
}).strict();
```

- `limit` 限制返回消息条数（最新 N 条），上限 100。`createdAt desc, limit` 取最近，倒序返回。

## 输出 Schema

[源：[./thread-recall-skill.ts:11-17](./thread-recall-skill.ts)]

```ts
const threadRecallOutputSchema = z.object({
  messages: z.array(z.object({
    id: z.string().uuid(),
    role: z.string(),
    contentRedacted: z.string(),
    createdAt: z.string().datetime(),
  })),
}).strict();
```

每条 `message` **故意不返回 raw `body`**。`contentRedacted` 仅当 `markedSharedByOwner=true` 且 `redactedSummary` 非空时填充，否则为空串。

## Handler 语义

1. SELECT `chat_threads` WHERE `id = input.threadId`：不存在 → 404。
2. 校验 `thread.ownerUserId === ctx.actorUserId`：不一致 → 403。**不**以 404 替代 403（避免枚举）。
3. SELECT `chat_messages` WHERE `threadId`，按 `createdAt desc` 取最近 `limit` 条。
4. 倒序为时间正序。
5. 映射 `contentRedacted`：`markedSharedByOwner && redactedSummary` → 取 `redactedSummary`；否则空串。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `allowedTools` 必须落在 `personal` allow-list 内 | `agents/skill-registry.ts:38-48` | 注册期抛 `SkillError('TOOL_NOT_ALLOWED')` |
| `version` 是可固定的契约版本 | registry `expectedVersion` | 同版本可重复调用；不匹配时 `SKILL_VERSION_MISMATCH` |
| `input` 必须匹配 Zod schema | registry `input.parse` | `SkillError('INPUT_INVALID')` |
| owner check 在 DB 读取之前 | `thread-recall-skill.ts:32-37` | 403（不是 404，避免枚举） |
| 永不返回 raw `body` | `thread-recall-skill.ts:55-58` | 强制——`contentRedacted` 只来自 `redacted_summary` |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `INPUT_INVALID` | `threadId` 不是 UUID；`limit` 越界或非整数 | 400 | 否（修正请求） |
| `OUTPUT_INVALID` | 输出 schema 违规 | 422 | 否（修正 Skill 输出） |
| `TIMEOUT` | handler 超过 2000ms | 504 | 是（同 payload） |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `personal` scope | 403 | 否（修正 Skill 定义） |

> 404/403 在路由层抛 `ApiError`，不通过 SkillError 抛出。SkillError 仅承载 Skill 自身契约错误。

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — `Skill<I,O>` 形态
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — 重复调用与 expected-version 契约
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md) — 错误码全集
- [../../db/schema.ts](../../db/schema.ts) — `chat_threads` + `chat_messages` 数据源

## Verification

- `npx vitest run tests/thread-recall-skill.test.ts` — 调用 + owner + redacted 输出
- `npx vitest run tests/skill-allowlist.test.ts` — `Personal + chat:read` 允许注册
- `npm run docs:verify` — 文档与代码一致
