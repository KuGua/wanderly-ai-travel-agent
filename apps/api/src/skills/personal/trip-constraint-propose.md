---
name: personal.trip.constraint.propose
source-of-truth: ./trip-constraint-propose-skill.ts
agent: personal
status: implemented
---

# `personal.trip.constraint.propose` Skill

owner 在其私有 thread 内可生成的 Trip 约束候选提案。仅产出 PENDING 候选，
不会自动确认或写入 Shared Agent 输入（spec §1.1, §5.1）。

字段值(value)和服务端字段目录(`apps/api/src/policy/constraint-field-catalog.ts`)
由 `validateSubmittedProposal` 在落库之前服务端再次校验。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `trip.constraint.propose` | `../agents/contracts.ts:Skill.name` |
| `agent` | `personal` | `../agents/contracts.ts:AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["consent:read"]` | `policy-gate.ts` 个人允许列表 |
| `timeoutMs` | `1500` | `Skill.timeoutMs` |
| `needsConfirm` | `true` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./trip-constraint-propose-skill.ts:5-28](./trip-constraint-propose-skill.ts)]

```ts
const tripConstraintProposeInputSchema = z.object({
  tripId: z.string().uuid(),
  question: z.string().min(1).max(1024),
  threadContext: z.object({
    tripBrief: z.object({
      departureCities: z.array(z.string().min(1)).min(1),
      destinationCandidates: z.array(z.string().min(1)).min(1),
      travelDateWindow: z.object({ start: …, end: … }).optional(),
    }).strict(),
    ownerProfileHints: z.object({
      interests: z.array(z.string()).optional(),
      accommodationStyle: z.string().optional(),
      noRedEye: z.boolean().optional(),
      budgetMaxUsd: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict(),
}).strict();
```

## 输出 Schema

```ts
const tripConstraintProposeOutputSchema = z.object({
  proposals: z.array(z.object({
    fieldKey: z.string().min(1).max(64),
    valueJson: z.unknown(),
    strength: z.enum(["HARD", "SOFT"]),
    suggestedVisibility: z.enum(["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"]),
    safeRationale: z.string().min(1).max(280),
  })).max(8),
}).strict();
```

每条 proposal 含 `{fieldKey, valueJson, strength, suggestedVisibility,
safeRationale}`。`safeRationale` 是 owner-only，绝对不引用先前的私聊原文
（spec §5.1「绝不引用先前 chat」）。`validateSubmittedProposal`
会二次校验目录匹配 + value schema + visibility/strength 兼容性。

## Handler 语义

1. `tripBrief.destinationCandidates` 为空时返回 `{proposals:[]}`；
2. 否则由上游对话层产生的候选数组经过目录 schema 解析；
3. 任一字段不在目录、value 不匹配 schema、visibility/strength 组合不被允许
   → 调用 `parseConstraintField` 抛 `ConstraintFieldCatalogError`（HTTP 422）；
4. `safeRationale.length > 280` → 抛 `Error`。

注：本 skill 在 Phase 5 不直接调用 LLM；以 deterministic gate 形式存在，
LLM 驱动的 proposal 抽取作为 Phase 6 的 hardening 步骤接入。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `allowedTools` 必须落在 `personal` allow-list 内（无 `snapshot:read`/`plan:write:propose`） | `agents/skill-registry.ts:9-13` | 注册期抛 `SkillError('TOOL_NOT_ALLOWED')` |
| `version` 是可固定的契约版本 | registry `expectedVersion` | 不匹配时 `SKILL_VERSION_MISMATCH` |
| `input` 必须匹配 Zod schema | registry `input.parse` | `SkillError('INPUT_INVALID')` |
| `output` 必须匹配 Zod schema | registry `output.parse` | `SkillError('OUTPUT_INVALID')` |
| `validateSubmittedProposal` 强制字段目录白名单 | `trip-constraint-propose-skill.ts:validateSubmittedProposal` | 抛 `ConstraintFieldCatalogError`，上游取消落库 |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `INPUT_INVALID` | `question`/`tripId`/`threadContext` 任一不满足 Zod | 400 | 否（修正请求） |
| `OUTPUT_INVALID` | 输出 schema 违规 | 422 | 否（修正 Skill 输出） |
| `TIMEOUT` | handler 超过 1500ms | 504 | 是（同 payload） |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `personal` scope | 403 | 否（修正 Skill 定义） |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — `Skill<I,O>` 形态
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — 重复调用与 expected-version 契约
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md) — 错误码全集
- [../../policy/constraint-field-catalog.md](../../policy/constraint-field-catalog.md) — 唯一权威字段白名单
- [../../../../docs/team-agent-orchestration-implementation.md](../../../../docs/team-agent-orchestration-implementation.md) §5.1

## Verification

- `npm run typecheck` — Skill 类型 + 接口一致
- `npm run docs:verify` — 本文件存在性 + 文档/代码对齐
- `npx vitest run tests/team-orchestration/` — 上层服务联动测试（来自 Phase 2）
