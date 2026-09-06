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

### 2.1 新写入只使用一个住宿槽位

新方案的住宿契约只有 `hotels[]`：它承载带价格、来源、采集时间和有效期的酒店报价。`stays[]` 与 `accommodations[]` 均已从最终 plan 契约退役；OpenTripMap `accommodation.discover` 仅作为运行内覆盖率、gap 归因和排障证据，不作为可选方案项。新的 `availableEvidence` 只向模型暴露可进入方案的 `flights`、`activities` 和 `hotels`。

历史 `itinerary_plan` 中的 `stays[]` / `accommodations[]` 不做批量改写，读取时不会使页面崩溃；但共享方案主卡不再展示第二个“住宿”区块，以免把无价格 discovery 误当成与酒店并列的选择。

服务端在 evidence binding 前做纯确定性的 category preflight：

| 输入 | 结果 |
|---|---|
| ID 属于当前槽位 | 允许进入绑定 |
| ID 仅属于另一槽位 | `EVIDENCE_SLOT_MISMATCH`，进入 repair |
| ID 不属于任何目录 | `EVIDENCE_NOT_FOUND`，进入 repair |
| 非紧凑对象或捏造完整对象 | 保持现有严格 provenance/schema 校验，失败关闭 |

preflight 只报告稳定 code 与字段路径（如 `hotels.0`），不得把 ID、供应商正文、snapshot 或私有输入放入 critique、日志、指标标签或响应。它不做跨槽位搬运；这是防止把报价与非报价发现混成事实的必要边界。

### 2.2 让模型得到可执行且可修复的契约

保留现有有界 `availableEvidence` catalog，并在最终合成指令中明确 `hotels` 是唯一可选住宿类别，`stays` / `accommodations` 均已退役。gateway 的严格 completion schema 不接受这两个字段，所以错误会在模型输出边界进入有界修复，而不是在持久化前才暴露。每轮 repair 仅返回稳定 code 与字段路径，不回传实际 ID。

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
| 模型契约迁移 | `apps/api/src/providers/shared-planning-prompts.ts`、`apps/api/src/providers/llm-gateway.ts`、`apps/api/src/services/planning-service.ts` | 新模型输出 schema、repair 提示与 selectable evidence catalog 均不再传递 `stays` / `accommodations`；仅允许 `hotels` 表达最终住宿选择。 |
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
2. `plan-evidence-binding` 单测：hotel ID 放入退役槽位返回稳定错误，原 candidate 不变；同 ID 在 `hotels[]` 被完整绑定；未知 ID 为 `EVIDENCE_NOT_FOUND`；没有跨类自动映射。
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

## 6. 产品与技术文档同步

`docs/PRD.md` 与 `docs/backlog.md` 已同步最终住宿只使用 `hotels`、逐日建议和 tool-free synthesis / repair 的验收约束。`TECH_STACK.md` 的服务端权威状态、无证据不得编造、隐私隔离和 provider 边界均未变化，因此无需修改。本文和 `docs/test-scenarios.md` 记录具体实现、故障模式与回归方式。

## 7. 逐日行程建议（2026-09-06）

Shared Agent 在完成并绑定航班、酒店和活动证据选择后，使用第二个无工具的模型调用生成 `dailyItinerary`。该调用只接收已验证 plan 的无价格投影、服务端日序与短证据别名，不能改变选择、调用 provider 或取得 catalog 中未选的项目。模型只拥有 `dayKey`、时间、标题、类型和 nullable `evidenceKey`；真实日期、`destination_local`、验证级别与 provider evidence ID 均由服务端确定性补全。

- `FLIGHT`、`BOOKED_ACTIVITY` 必须引用已选 evidence ID，并标为 `PROVIDER_BACKED`；
- `SUGGESTED_STOP`、`FREE_TIME`、`RETURN_TO_HOTEL` 必须标为 `SUGGESTED`，且不得带 evidence ID、价格、营业时间、路线、交通耗时、地址或预订承诺；
- 服务端拒绝日期不完整、时间倒置/重叠、伪造引用和把建议标为 provider-backed 的输出。当前时间统一标为目的地本地时间，模型不能声明 IANA 时区；
- 页面按天折叠展示，首日默认展开，并用文字标签区分“已验证”和“建议，需核验”。历史 plan 没有该字段时保持可读。
- `travelDateStart` 与 `travelDateEnd` 均是行程日，每日建议必须按升序完整覆盖首尾日期。模型可增加不在 provider Activities 选择中的景点/停留，但只能标为 `SUGGESTED`，不得附会 provider 事实。

## 8. 已启动行程的 brief 变更与 REPLAN（2026-09-06）

`pending_brief_proposal` 同时承载 DRAFT brief 和已启动行程的候选变更；它始终是候选，聊天模型不得将其称为已保存。`PATCH /trips/:tripId/draft-brief` 对 `PLANNING` 行程由创建者确认候选后，在同一事务中更新权威日期/天数、使现有 plan 与 confirmations 进入 `STALE`、创建新 snapshot 并接受一个 `REPLAN`。响应只在该路径携带 `replan.runId`。

界面必须把该路径明确表述为“确认并重新生成”，而不是普通保存；确认前保持旧 plan 可读，确认后显示服务端返回的运行状态。无法确认、缺少 search preferences 或 hotel nationality 授权时，事务回滚，旧日期与 plan 均不变。

## 9. 每日建议的降级边界（2026-09-06）

`dailyItinerary` 是已验证共享方案的可选呈现增强，不是方案选择或证据绑定的一部分。主 plan 完成证据校验后，每日建议模型不可用、JSON/schema 无效或时间校验失败时，服务端保留主 plan，并分别以低基数 `daily_itinerary_attempt_total`、`daily_itinerary_run_total`、`daily_itinerary_duration_ms` 和安全关联日志记录实际调用、唯一终态与耗时；不得使 `PLAN`、`REPLAN` 或 `RESEARCH/PROPOSE_PLAN` 变为 `INTERNAL`。

失败提示不得从任务失败反推“行程没有任何改动”。固定 UI 文案只说明新共享方案是否产生，并明确已确认的 brief 变更不会回退；这避免与服务端已写入的日期、`STALE` 状态相矛盾。

实际 v3 复测发现每日建议并未请求到 Gemini：planning service 把
`modelGateway.generateDailyItinerary` 解构成裸函数后调用，而 `LLMGateway` 需要通过 `this`
读取配置并加载客户端，因此在 `this.loadClient()` 处立即抛错。修复后必须以 gateway 实例作为
receiver 直接调用；服务层回归测试使用依赖 `this` 的 gateway，断言三天结果进入持久化的
`plan_data.dailyItinerary`，防止仅直接测试 gateway 方法而遗漏编排调用方式。

错误归因使用闭合集合：模型 schema、日期覆盖、时间顺序、证据引用、provider contract 拒绝、
临时不可用、修复耗尽、能力未配置和本地错误分别记录；HTTP 400 不得归入内容修复或显示为已重试，
429/超时/临时上游失败也不得消耗内容修复预算。取消信号必须继续向上抛出，不得伪装成可选能力降级。

v4/v5 在请求实际到达模型后连续产生 `VALIDATION_FAILED`；v6 进一步确认 `json_object` 只保证合法 JSON，不能约束 Gemini 遵守 item、timezone 与 evidenceRef 结构。v7 又确认把完整 canonical schema 直接交给 provider 会被 Gemini 拒绝外层嵌套 `maxItems`。每日行程因此使用 provider-compatible wire schema 与独立 canonical Zod schema 两层契约，以及一次生成加最多两次
tool-free 修复：服务端传入完整日期数组及去除价格、来源、真实 evidence ID 和原始 payload 的精简已选证据，以 `day_1`、`flight_1`、`activity_1` 等 run-local 别名交接；修复反馈
只含闭合错误码、最多 16 个 schema path 和对应闭合规则。服务端严格拒绝未知/跨类别别名，并在模型输出通过后注入真实日期、固定本地时区标记、验证级别和真实 evidence 引用。日期覆盖、时间顺序、证据引用和 JSON schema 分别归因，
provider 或本地调用错误不进入内容修复。结果以服务端拥有的 `dailyItineraryOutcome` 判别联合持久化：
成功时 `READY` 必须含 canonical days；失败时 `UNAVAILABLE` 必须含闭合 reason、retryable、attempts
与 checkedAt，且不能含 days。页面按原因准确显示；历史 `dailyItinerary` / `dailyItineraryStatus` 只读
兼容，新旧状态同时存在时服务端拒绝。

## 10. Places 候选交接与最终成稿预算（2026-09-06）

运行 `995ff516-580e-4490-ba36-48abaad7dc53` 的 provider 查询实际取得了航班、活动、住宿发现和地点候选，但最终以 `TOOL_BUDGET_EXHAUSTED` 结束。直接根因是规划 dispatcher 把 `places.search` 的 Skill 输出当成内部 service 结果读取：它查找 `data[]`，而公开 Skill 契约返回 `candidates[]`。因此本轮候选索引始终为空，后续 `places.propose` 使用刚返回的 `candidateId` 仍被判定为非本轮候选；模型再次搜索、再次失败，最终没有进入成稿。

修复后的边界如下：

- dispatcher 使用 `PlaceSearchOutput` 的严格 schema 读取 `LIVE.candidates`，并以 `candidateId` 建立仅限当前 run 的内存索引；`UNAVAILABLE` 不产生候选。模型提供的名称、坐标和来源仍不能替代该服务端索引。
- 同一个 places 工具连续两次发生 `SKILL_CONTRACT_VIOLATION` 时，一并撤下 `places.search`、三个 mutation 工具和依赖已采纳地点的 `navigation.route`。该能力作为 gap 结束，但不能阻塞航班、酒店和活动证据的最终方案。
- `maxTurns` 的最后一个正常模型调用固定保留给最终合成。该调用以及所有 repair 调用均不再提供 tools；模型若仍返回 tool call，gateway 本地关闭调用且不触达 provider，只能使用 repair 回合重新输出 JSON。
- `repairBudget` 只用于已经进入合成后的 schema/确定性校验修复，不能扩充普通检索回合。这样即使某一非必需能力未收敛，系统也至少执行一次明确的最终合成请求。
- 持久化 research summary 前按 `(capability, code, destinationId)` 去重完全相同的 gap，保留首个顺序；原始输入仍先受 32 条上限和严格 schema 约束。

本修复不放宽 flight matrix、evidence binding、snapshot 或无证据 fail-closed 门禁；如果强制成稿时必需矩阵仍缺失，`beforeFinal` 仍以 `RESEARCH_MATRIX_INCOMPLETE` 终止。无需数据库迁移、环境变量或 provider 配置变更。
