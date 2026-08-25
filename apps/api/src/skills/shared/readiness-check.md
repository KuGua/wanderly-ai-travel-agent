---
name: shared.readiness.check
source-of-truth: ./readiness-skill.ts
agent: shared
status: implemented
---

# `shared.readiness.check` Skill

每位成员入境/签证准备的受控检查。**不调用 LLM**；没有可靠签证数据源时仅返回官方核验下一步与缺口，不输出资格或法律结论。

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `readiness.check` | `Skill.name` |
| `agent` | `shared` | `AgentKind` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `["readiness:read", "snapshot:read"]` | `shared` allow-list |
| `timeoutMs` | `2000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## 输入 Schema

[源：[./readiness-skill.ts:4-7](./readiness-skill.ts)]

```ts
const readinessInputSchema = z.object({
  destination: z.string().min(1),
  memberIds: z.array(z.string().uuid()).min(1),
}).strict();
```

## 输出 Schema

[源：[./readiness-skill.ts:9-15](./readiness-skill.ts)]

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

1. 把每个 `memberId` 映射为
   `{ memberId, status: "PENDING", note: "Readiness pending — verify with official government sources" }`。
2. 返回该数组。

Handler 不调 LLM、不查 snapshot 的 `authorizedData`、不查真实签证规则。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| `agent === "shared"` 必须有 `ctx.snapshot` | `agents/skill-registry.ts:67-69` | `SkillError('SNAPSHOT_REQUIRED')` |
| `allowedTools` 落在 `shared` allow-list | registry | 注册期抛 `SkillError('TOOL_NOT_ALLOWED')` |
| `version` 在同一进程内只允许 invoke 一次 | `lastUsedVersion` 严格去重 | `SkillError('OUTPUT_INVALID', 'stale_version_reuse')` |

## 失败模式

| code | 触发条件 | HTTP 状态 | 客户端可重试? |
| --- | --- | --- | --- |
| `SNAPSHOT_REQUIRED` | `ctx.snapshot` 缺失 | 400 | 否（注入 snapshot） |
| `INPUT_INVALID` | 空 `memberIds`、非 UUID、空 `destination` | 400 | 否 |
| `OUTPUT_INVALID` | 输出 schema 违规；或 `stale_version_reuse` | 422 | 否 |
| `TIMEOUT` | handler 超过 2000ms | 504 | 是 |
| `TOOL_NOT_ALLOWED` | 仅注册期 — `allowedTools` 含非 `shared` scope | 403 | 否 |

## 关联文档

- [../../agents/CONTRACT.md](../agents/CONTRACT.md)
- [../../agents/REGISTRY.md](../agents/REGISTRY.md)
- [../../agents/ERROR-CODES.md](../agents/ERROR-CODES.md)
- [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md) — 兄弟 validator
- （未来可接入经审查的签证数据 provider；仍须保持 snapshot 字段授权。）

## Verification

- `npx vitest run tests/skill-registry.test.ts`
- `npx vitest run tests/skill-allowlist.test.ts`
- `npx vitest run tests/skill-integration.test.ts`
- `npm run docs:verify`
