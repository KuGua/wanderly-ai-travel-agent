---
name: shared.plan.comparison
source-of-truth: ./plan-comparison-skill.ts
agent: shared
status: implemented
---

# `shared.plan.comparison` Skill

Shared planning 中调用 LLM 的 Skill。结合约束快照中已授权的成员偏好与当前 provider evidence，生成结构化候选方案；通过 validator 校验后再返回。provider 或模型不可用时失败关闭，不生成替代方案。Personal Agent 私有问答由独立的 `travel.conversation` Skill 处理。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `plan.comparison` | `Skill.name` |
| `agent` | `shared` | `AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["plan:write:propose", "snapshot:read"]` | `shared` allow-list |
| `timeoutMs` | `10000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./plan-comparison-skill.ts:7-13](./plan-comparison-skill.ts)]

```ts
const planComparisonInputSchema = z.object({
  destination: z.string().min(1),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  memberPreferences: z.record(z.string(), z.unknown()).default({}),
}).strict();
```

`flights/stays/ground` 在生产中已强转为 `FlightOffer[]` 等；schema 接受 `unknown[]` 是为了 validator 能与原始 provider 证据做 deep-strict-equal。

`memberPreferences` 是 snapshot 的 `authorizedData` 投影，已经过 `consent-service.buildAuthorizedData` 过滤——`passportNumber`/`documentNumber`/`nationality`/`dateOfBirth` 默认缺席，除非该成员显式授权对应 scope。

## 输出 Schema

[源：[./plan-comparison-skill.ts:15-21](./plan-comparison-skill.ts)]

```ts
const planComparisonOutputSchema = z.object({
  destination: z.string(),
  flights: z.array(z.unknown()),
  stays: z.array(z.unknown()),
  ground: z.array(z.unknown()),
  generatedAt: z.string().optional(),
}).strict();
```

Skill 实际返回的是经过 validator 校验的 `planOutputSchema`（见 [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md)）——逐字段 `.strict()` 的 Zod，含 `id / origin / destination / priceUsd / isRedEye` 等。

## Handler 语义

1. 要求 `ctx.snapshot`（shared Skill 不变量）。
2. 从 `providers/gateway-factory.ts` 获取 `modelGateway()`。
3. 调用 `gateway.generateStructuredPlan({ destination, flights, stays, ground, memberPreferences, signal, ctx: ctx.ctx })`。Gateway 只返回经过结构校验的真实模型响应；provider、超时或 schema 失败时抛受控错误。
4. 调用 `validatePlanOutput({ planData: candidatePlanData, snapshot, evidence: { flights, stays, ground } })`。
5. 通过则返回 validated plan；任意 violation 抛 `SkillError('PLAN_VALIDATION_FAILED', 422, violations)`。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| Shared Skill 必须有 `ctx.snapshot` | `agents/skill-registry.ts:67-69` | `SkillError('SNAPSHOT_REQUIRED')` |
| Validator 失败即关闭（fail closed） | `policy/plan-output-validator.ts` 永远 throw | `SkillError('PLAN_VALIDATION_FAILED', 422, violations)` |
| LLM 失败关闭 | `providers/llm-gateway.ts` | client load、retry 耗尽、timeout 或 schema parse 失败时记录安全元数据并抛 `ModelGatewayError` |
| 敏感字段禁止出现在输出 | `policy/plan-output-validator.ts:STRUCTURE_INVALID`；[../../services/AUDIT.md](../../services/AUDIT.md) 负责日志脱敏 | 方案被拒 / audit 被拒 |
| 可选 expected version 固定契约 | `agents/skill-registry.ts` | 不匹配时 `SkillError('SKILL_VERSION_MISMATCH')`；同版本可重复调用 |

## LLM 约束面

LLM Gateway 详见 [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md)：

- OpenAI Chat Completions `client.beta.chat.completions.parse(...)`，`response_format: { type: "json_object" }`，带 `signal`。
- System prompt：

  > "You are the Shared Trip planning skill. Return one JSON object with exactly one top-level plan field. The plan must contain destination, flights, stays, ground, and generatedAt. Never include PII, passport numbers, or fields outside the supplied snapshot."

- `parsedCompletionSchema`（Zod）在 TS 层二次校验模型响应。
- 模型成功或受控失败都会写入不含 prompt/output 正文的 `agent_runs`；生产路径不使用本地/mock fallback。

Validator 进一步强制 deep-strict-equal 证据匹配、snapshot 字段白名单、来源溯源字段。LLM 在价格、时间、来源、成员字段上**不被信任**。

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `SNAPSHOT_REQUIRED` | `ctx.snapshot` 缺失 | 400 | 否（注入 snapshot） |
| `INPUT_INVALID` | 输入 Zod 失败 | 400 | 否 |
| `OUTPUT_INVALID` | 输出 Zod 失败 | 422 | 否 |
| `SKILL_VERSION_MISMATCH` | 调用方固定的版本与注册版本不同 | 409 | 否（升级调用契约） |
| `PLAN_VALIDATION_FAILED` | `validatePlanOutput` 抛出任何 violation | 422 | 否（修复快照或证据） |
| `TIMEOUT` | handler 超过 10000ms（LLM 调用） | 504 | 是 |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `shared` scope | 403 | 否 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md) — Skill 形态
- [../../agents/REGISTRY.md](../agents/REGISTRY.md) — 去重 + audit
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md) — `PLAN_VALIDATION_FAILED` 语义
- [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md) — `validatePlanOutput` 检查项
- [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md) — fallback 触发与 `recordAgentRun`
- [../../services/AUDIT.md](../../services/AUDIT.md) — `whitelistSummary` 严格校验
- [../../observability/README.md](../../observability/README.md) — `provider_fallback_total` 与 `agent_runs`

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
- `npx vitest run tests/skill-integration.test.ts` — 全路径 + violation
- `npx vitest run tests/llm-gateway.test.ts` — controlled failure + success
- `npx vitest run tests/plan-output-validator.test.ts` 与 `tests/plan-validator.test.ts` — 11 类 violation
- `npm run docs:verify`
