---
source-of-truth: ./constraint-field-catalog.ts
name: constraint-field-catalog
status: implemented
---

# Constraint Field Catalog

Team Agent 协作编排（见 [../../../../docs/team-agent-orchestration-implementation.md](../../../../docs/team-agent-orchestration-implementation.md) §4）下，Trip 约束字段的**唯一**白名单。

服务端是写入路径上唯一可以校验 `fieldKey + value + visibility + strength` 的位置。Personal Agent、Owner 表单、Shared planning prompt 都不能创建或替换目录条目；它们只能选择 `fieldKey` + `value` 并提交 visibility / strength 决策，由本目录解析后才能落库。

## 初始目录条目

| key | strength 范围 | visibility 范围 | proposalEligible | residualInferenceWarningToken | safePublicExplanationTokens | profileConsentRequired |
| --- | --- | --- | --- | --- | --- | --- |
| `departure_city` | `HARD` | `TEAM_VISIBLE` | true | — | `MATCHES_BRIEF_DEPARTURE` | false |
| `travel_date_window` | `HARD` | `TEAM_VISIBLE` | true | — | `MATCHES_BRIEF_WINDOW` | false |
| `budget_max` | `HARD`,`SOFT` | `TEAM_VISIBLE`,`ORCHESTRATOR_CONFIDENTIAL` | true | `BUDGET_RESIDUAL_INFERENCE` | `OPTIMIZED_FOR_BUDGET`,`SATISFIES_ALL_PRIVATE_CONSTRAINTS` | true |
| `accessibility_need` | `HARD`,`SOFT` | `TEAM_VISIBLE`,`ORCHESTRATOR_CONFIDENTIAL` | true | `ACCESSIBILITY_RESIDUAL_INFERENCE` | `ACCESSIBILITY_AWARE_SELECTION`,`SATISFIES_ALL_PRIVATE_CONSTRAINTS` | true |
| `special_schedule_limit` | `HARD`,`SOFT` | `TEAM_VISIBLE`,`ORCHESTRATOR_CONFIDENTIAL` | true | `SCHEDULE_RESIDUAL_INFERENCE` | `SCHEDULE_AWARE_SELECTION`,`SATISFIES_ALL_PRIVATE_CONSTRAINTS` | false |
| `no_red_eye` | `HARD`,`SOFT` | `TEAM_VISIBLE`,`ORCHESTRATOR_CONFIDENTIAL` | true | — | `AVOIDS_RED_EYE` | false |
| `accommodation_style` | `SOFT` | `TEAM_VISIBLE`,`ORCHESTRATOR_CONFIDENTIAL` | true | `STYLE_RESIDUAL_INFERENCE` | `MATCHES_STYLE_PREFERENCE` | true |
| `travel_pace` | `SOFT` | `TEAM_VISIBLE`,`ORCHESTRATOR_CONFIDENTIAL` | true | `PACE_RESIDUAL_INFERENCE` | `MATCHES_PACE_PREFERENCE` | true |
| `interests` | `SOFT` | `TEAM_VISIBLE` | true | — | `MATCHES_INTERESTS` | true |

## 非可提议条目

- **nationality / travel document** — 仅 `consent_grants` 的 `PROFILE_NATIONALITY` / `PROFILE_DOCUMENTS` scope 受理，未列入本目录。Personal Agent 不能填；只通过 `apps/api/src/routes/profiles.ts` 的表单受理，且不与 `trip_constraint_facts` 共享同一持久化路径。

## 强制约束

| 约束 | 实现位置 | 失败表现 |
| --- | --- | --- |
| 所有写入路径必须先调用 `parseConstraintField` | `policy/constraint-field-catalog.ts:parseConstraintField` | `ConstraintFieldCatalogError(code)`；HTTP 422 |
| `value` 必须匹配 `valueSchema` | 同上 | `code = VALUE_INVALID` |
| `visibility` 必须在 `allowedVisibilities` 内 | 同上 | `code = VISIBILITY_NOT_ALLOWED` |
| `strength` 必须在 `allowedStrengths` 内 | 同上 | `code = STRENGTH_NOT_ALLOWED` |
| 不在目录内的 `fieldKey` 一律拒绝 | 同上 | `code = UNKNOWN_FIELD` |
| `profileConsentRequired` 时必须验证 `consent_grants`（Phase 1+） | `services/consent-service.ts#getActiveConsents` | policy gate 拒绝 |

## 残余推断风险

`residualInferenceWarningToken` 不为 `null` 的字段，**确认 UI 必须在 owner 选 confidential 时渲染**「存在残余推断风险」提示（参见 user confirmed decision 与 web `trips.residualInferenceWarning`）。服务端不能保证模型/方案选择完全不可推断 — 这是规范的明示残余风险。

## 关联文档

- [../../../../docs/team-agent-orchestration-implementation.md](../../../../docs/team-agent-orchestration-implementation.md) §1, §4, §10.2
- [./snapshot-policy.ts](./snapshot-policy.ts) — Snapshot 字段授权（现行 `authorizedData` 形状；Phase 1 升级为 v2）
- [./plan-output-validator.ts](./plan-output-validator.ts) — Plan 输出校验（Phase 3 追加 `assertConfidentialFree`）
- [../../services/consent-service.ts](../../services/consent-service.ts) — `buildAuthorizedData` 数据源
- [../../agents/contracts.ts](../../agents/contracts.ts) — Skill 工具与权限（默认 personal skill 仅 `profile:read` / `consent:read`；不可持有 `snapshot:read`、`plan:write:propose`）

## Verification

- `npm run typecheck` — 目录 TS 通过
- `npm run docs:verify` — 本文件存在性 + `source-of-truth` 解析得到
- `tests/team-orchestration/catalog.test.ts` — 在 Phase 1 起补全
