# 规划证据槽位校正与无方案终态实施方案

**状态：** Implemented — contract migration verification pending  
**范围：** Shared `PROPOSE_PLAN` / replan 合成、其安全降级结果、以及 Shared Plan 的终态呈现。  
**不在范围：** 不改变团队约束的隐私模型；不重跑历史行程；不新增 provider、环境变量或运行时 fixture；不将私聊/个人研究内容展示给其他成员。

## 1. 问题与完成标准

2026-09-06 的一次重新规划已收集酒店、活动与住宿证据，却没有生成 `itinerary_plans`。根因是已无运行时 producer 的遗留 `stays[]` 仍被放入模型输入、输出 schema 和 evidence catalog；模型因此把酒店的紧凑 `{id}` 放入该槽位。`stays` 没有对应证据，绑定器保留该引用，严格输出校验随后失败，修复预算耗尽后安全写入 `PLAN_SCHEMA_UNMET` summary。

同一终态还暴露两个呈现/契约缺陷：

- 无 plan 的 run 因 `serviceGaps=[]` 被标成 `COMPLETED`；Shared Plan 仅把 `COMPLETED_WITH_GAPS` 视为无方案终态，因此空页面仍显示“方案已就绪”。
- `researchResultResponseSchema` 已定义 `summaryReason`，但 `GET /trips/:tripId/research/latest` 的实际 DTO 漏传该字段，前端无法解释为何没有 plan。

完成后必须满足：正确槽位的目录 ID 能在一次合成或一次有界 repair 后生成并原子持久化 `PROPOSED itinerary_plan`；错槽位绝不被静默转换；所有“终态且没有 `resultPlanId`”均如实呈现为无方案结果而不是“已就绪”。

## 2. 固定决策

### 2.1 新写入只使用两类住宿证据

新方案的住宿契约只有两个不可互换的槽位：`hotels[]` 是带价格与有效期的酒店报价，`accommodations[]` 是不带报价的住宿发现。紧凑选择 `{id}` 只能引用同名 `availableEvidence` 类别中的 ID；可选类别没有证据时省略该字段。`stays` 已退役，模型不得输出，新的 catalog 也不得携带它。

历史 `itinerary_plan` 的 `stays[]` 保持只读兼容：API validator 和 Web 卡片仍可解析/渲染它，但任何新规划不会生成或复写该字段。

服务端在 evidence binding 前做纯确定性的 category preflight：

| 输入 | 结果 |
|---|---|
| ID 属于当前槽位 | 允许进入绑定 |
| ID 仅属于另一槽位 | `EVIDENCE_SLOT_MISMATCH`，进入 repair |
| ID 不属于任何目录 | `EVIDENCE_NOT_FOUND`，进入 repair |
| 非紧凑对象或捏造完整对象 | 保持现有严格 provenance/schema 校验，失败关闭 |

preflight 只报告稳定 code 与字段路径（如 `hotels.0`），不得把 ID、供应商正文、snapshot 或私有输入放入 critique、日志、指标标签或响应。它不做跨槽位搬运；这是防止把报价与非报价发现混成事实的必要边界。

### 2.2 让模型得到可执行且可修复的契约

保留现有有界 `availableEvidence` catalog，并在最终合成指令中明确两个住宿类别的边界及 `stays` 退役规则。gateway 的严格 completion schema 不接受 `stays`，所以错误会在模型输出边界进入有界修复，而不是在持久化前才暴露。每轮 repair 仅返回稳定 code 与字段路径，不回传实际 ID。

`PlanCritiqueCode` 增加 `EVIDENCE_SLOT_MISMATCH`，并将该 code 映射为低敏的计划校验失败遥测/日志结果，不再归因为 `UPSTREAM_FAILURE`。完整输出校验和持久化前复验继续保留，不能只依赖 gateway repair。

`generatedAt` 只能从最终**同类且成功绑定**的服务端 evidence 导出；错槽位 ID 不得贡献时间戳。

### 2.3 无 plan 是明确终态，而非 completed plan

当 `PROPOSE_PLAN` / `REPLAN` 走 research-summary 分支（包括 `PLAN_SCHEMA_UNMET`）时，run 必须为 `COMPLETED_WITH_GAPS`，即使 `serviceGaps` 为空；`resultPlanId` 必须为 `NULL`，且不写 `itinerary_plans`。这表达的是“安全完成了研究/诊断，但没有可采用的方案”，而不是 provider 可用性的断言。

`GET /trips/:tripId/research/latest` 必须透传持久化的 nullable `summaryReason`。没有 reason 的历史行保持 `null`，UI 使用“本轮未记录具体原因”的通用安全文案，绝不补猜原因。

Shared Plan 的“可用方案”判定必须依赖已读取的 plan 列表或非空 `resultPlanId`，不能仅依赖 `run.status === COMPLETED`。空 plan + terminal run + `resultPlanId === null` 显示无方案面板；其 reason 只在该 summary 的 `agentTaskRunId` 与最新共享规划 run 相同、且该 run 是 member-scoped `RESEARCH`/`PROPOSE_PLAN` 结果时显示。`COMPLETED` 无 plan 的历史坏数据也必须显示通用无方案状态，以免再次显示“方案已就绪”。

这个匹配必须先在服务端成立：`GET /trips/:tripId/research/latest` 查询须 join/筛选其 `agent_task_runs`，只返回当前调用者有权读取的共享规划 summary；不得仅按 `trip_id` 取最新一行后交给前端过滤。owner-private Personal Research 对其他成员必须在读取边界 fail closed（可返回 `result: null`），不能先进入响应体。

### 2.4 团队约束空态不改

“尚未达成任何团队约束”在没有 `TEAM_VISIBLE` confirmed facts 时是正确的。Trip brief、私聊、owner-only Personal Research、待确认候选均不应填入该面板。本修复不修改 `TeamConstraintsPanel` 或其数据授权；若未来需要 trip 概览，应另立需求与成员可见性审查，且不能伪装为团队约束。

## 3. 实施分解

| 层 | 文件 | 落地内容 |
|---|---|---|
| 模型契约迁移 | `apps/api/src/providers/shared-planning-prompts.ts`、`apps/api/src/providers/llm-gateway.ts`、`apps/api/src/services/planning-service.ts` | 新模型输入、输出 schema、repair 提示与 evidence catalog 均不再传递 `stays`；只允许 `hotels` 与 `accommodations` 表达住宿。 |
| 类别预检 | `apps/api/src/services/plan-evidence-binding.ts` | 导出不变更输入的 compact-selection category 检查；新计划的有效类别建立 ID 索引并返回稳定 violation。历史 `stays` 仅留给读兼容校验。 |
| 校验边界 | `apps/api/src/services/planning-service.ts`、`apps/api/src/policy/plan-output-validator.ts` | 在 binding 前调用预检，统一转换为 `PlanValidationError`；在 gateway callback 与落库前复验均执行。 |
| repair/提示 | `apps/api/src/services/plan-critique.ts`、`apps/api/src/providers/shared-planning-prompts.ts`、`apps/api/src/providers/llm-gateway.ts` | 增加闭合 critique code 和固定提示；最终提示写明 category-to-slot 契约；修复 `errorCodeForRepair` 对计划校验错误的归因。 |
| 终态持久化 | `apps/api/src/services/planning-service.ts`、`apps/api/src/tasks/*` | 无 `resultPlanId` 的 synthesis summary 一律完成为 `COMPLETED_WITH_GAPS`；保留 `PLAN_SCHEMA_UNMET`，不回填或篡改历史行。 |
| 读取 DTO | `apps/api/src/routes/research.ts`、`apps/api/src/services/planning-research-result-service.ts`、`apps/api/src/types/schemas.ts` | latest 路由先按关联 run 的授权范围过滤 owner-private Personal Research，再复用 `toResearchResultDto` 或逐字段补齐 `summaryReason`；API/Web schema、run detail 和 latest 响应逐字段一致。无需新端点或迁移（`0079` 已有列与 CHECK）。 |
| Shared UI | `apps/web/src/components/trips/shared-plan/shared-plan-view.tsx`、`shared-plan-status-bar.tsx`、`apps/web/messages/{en,zh}.json` | 以 `hasPlan` / planless terminal state 驱动 status；显示本地化安全 reason 和详情链接；不得把 `COMPLETED` 单独翻译为“已就绪”而忽略 plan。 |

建议按“API category preflight → API summary/DTO → Web status”顺序提交，每一步均保持旧行可读。

## 4. 测试与验收

新增或扩展下列测试；所有测试 ID、私有内容和原始 provider payload 均使用合成值。

1. gateway 单测：包含 `stays` 的新模型 completion 被严格 schema 拒绝并进入有界 repair；无 `stays`、使用 `hotels[]` 的 completion 正常通过 gateway 边界。
2. `plan-evidence-binding` 单测：hotel ID 放入 `accommodations[]` 返回 `EVIDENCE_SLOT_MISMATCH`，原 candidate 不变；同 ID 在 `hotels[]` 被完整绑定；未知 ID 为 `EVIDENCE_NOT_FOUND`；没有跨类自动映射。
3. gateway/service 集成：模型首答退役字段或错槽位、repair 后改为正确 `hotels[]`，断言写出一个 `PROPOSED itinerary_plan`、`resultPlanId` 非空、没有 summary；且不再次调用已完成的一次性 provider tool。
4. repair 耗尽：持续输出退役字段或错槽位时不写 plan，写 `summaryReason=PLAN_SCHEMA_UNMET`，run 为 `COMPLETED_WITH_GAPS`、`resultPlanId=NULL`，日志/critique 不含 ID 或原始异常正文。
4. route 契约：latest 与 run-detail 都返回 `summaryReason`；历史 `NULL` 仍能通过 `.strict()` Web schema。
5. Web：`COMPLETED + no plan + matching PLAN_SCHEMA_UNMET` 与 `COMPLETED_WITH_GAPS + no plan` 都显示无方案，不显示“方案已就绪”；有 plan 的 completed run 正常显示 ready；非匹配/owner-private research summary 不显示。
6. 回归隐私：无 `TEAM_VISIBLE` facts 时团队约束仍为空，不渲染 brief、私聊或个人研究内容；对非创建成员，latest route 不返回 owner-private Personal Research；非成员读取继续 `403`。

验收命令至少覆盖 API 相关 Vitest、Web Shared Plan 组件测试、两端 typecheck/lint 和 production build。完整套件若存在既有失败，须按既有失败基线单列，不能把它归因于本修复。

## 5. 兼容性、可观测性与回滚

- **兼容性：** 不新增表/列/环境变量。既有 `COMPLETED` 且无 plan 的脏终态在 UI 中安全降级为通用无方案文案；不批量改写历史 run。
- **可观测性：** `plan_validation_failures_total` 使用有限 `validationResult=EVIDENCE_SLOT_MISMATCH`（或现有闭合等价值）；结构化日志只含 run 关联 ID、code、field path、repair attempt 和 outcome。不得将上述高基数 run ID 放到指标标签。
- **回滚：** 代码回滚不影响已有 `summary_reason` 列；已写 summary 仍按 nullable reason 读取。若只回滚 Web，服务端仍 fail closed；不得以回滚恢复跨槽位自动绑定。

## 6. 不需要同步变更的产品文档

`TECH_STACK.md`、`docs/PRD.md` 和 `docs/backlog.md` 已要求服务端状态为权威、无证据不得编造方案、私有/团队约束隔离。本方案是在修正实现与读取契约，不改变产品边界或优先级，故不修改它们。
