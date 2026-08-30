# 单人行程编排实施规范

**状态：** 已确认；研究命令的事务、快照与运行状态契约已落地，剩余对话确认卡与完整 Shared tool 编排按阶段实施。
**范围：** 让 Personal Agent 在单成员 Trip 中发起完整、证据化的个人旅行研究与规划；复用现有 Shared planning 能力和所有 Shared tools。  
**事实来源：** [TECH_STACK.md](../TECH_STACK.md)、[PRD.md](PRD.md)、[backlog.md](backlog.md)、[test-scenarios.md](test-scenarios.md)。
**实施计划：** [plans/linear-hugging-simon.md](../plans/linear-hugging-simon.md)（按 0–6 阶段推进）。  
**API 契约：** [apps/api/docs/contracts/research-command.md](../apps/api/docs/contracts/research-command.md)。  
**Phase 0 owner：** TBD。

## 1. 固定决策与不变量

1. 单人旅行使用已有 `shared_trips` 与 `trip_members`：Trip 恰有一个 `is_required=true` 的成员即可进入单人模式；不创建第二套个人行程表、snapshot 或 provider evidence store。
2. Draft 仅用于私有探索。用户必须显式激活一个完整的单人 Trip，才可运行任何 provider/tool；Draft 不创建 snapshot、research、plan、confirmation 或 booking。
3. 单人成员 Trip 的 `destinationCandidates` 允许 `1..5`；含多个 required members 的 Trip 保持 `2..3`。出发地、日期和各工具所需确认偏好仍是服务端门禁。
4. Personal Agent 是私聊入口和受控命令发起者；它不直接拥有数据库、HTTP、MCP、provider 或 Shared Skill scope。实际工具调用始终由持久 Worker 在 immutable snapshot、task lease 与 run binding 下完成。
5. 单人和多人复用相同的工具集合与证据路径：`flight.search`、`accommodation.discover`、`hotel.search`、`activities.search`、`places.search`、`places.adopt`、`navigation.route`、`mobility.search`、`readiness.check` 和 `plan.comparison`。其中住宿 discovery 与酒店 adapter 仍按现有实施规范交付；未配置或不可信的 provider 必须返回 `UNAVAILABLE`。
6. 个人研究可自动生成一版 `PROPOSED` plan 供 owner 查看；不能自动成为 `ACTIVE`、不能自动确认、更不能触发 booking。owner 明确 `ACCEPT` 后才激活；单成员 quorum 为该 owner 一票。
7. 所有价格、路线、活动、酒店和 readiness 输出继续绑定 `source`、`capturedAt`、适用时 `expiresAt`；fixture 只限测试。provider 失败、缺配置、过期或证据不可信时 fail closed 为 `UNAVAILABLE` / `COMPLETED_WITH_GAPS`。

## 2. 目标架构

```text
owner private thread
  -> Personal Agent conversation (intent extraction / missing-input questions)
  -> owner-confirmed Trip Research Command
  -> Fastify acceptance transaction
       -> constraint snapshot + durable agent_task_run
  -> Personal Trip Orchestrator (Worker execution mode)
       -> existing Shared Skill Registry + policy gate
       -> typed provider adapters
       -> normalized run/snapshot-bound evidence
       -> deterministic plan/evidence validator
  -> PROPOSED plan + safe research summary + SSE status
  -> owner adoption vote -> ACTIVE plan
```

`Personal Trip Orchestrator` 是执行模式，不是拥有 Shared 数据权限的新自由 Agent。其调用 Shared Skill 时，身份仍是 server-controlled `shared` policy gate，输入只来自本次单人 Trip 的 snapshot 和 task row。它不得读取聊天原文以外的 Personal 数据，也不得将聊天原文写入 snapshot、tool arguments、provider request、evidence、日志或遥测。

## 3. 生命周期与状态

### 3.1 Trip 模式

服务端根据当前 required-member 数量导出模式，不新增持久化 `trip_mode`：

| 条件 | 模式 | 候选目的地 | adoption quorum |
| --- | --- | --- | --- |
| 1 位 required member | `SOLO` | 1–5 | owner `ACCEPT` |
| 2+ 位 required members | `TEAM` | 2–3 | 所有 required members `ACCEPT` |

成员资格变化必须与既有 stale cascade 一起处理；不得在已有 `ACTIVE` / `PROPOSED` plan 上静默改变 quorum。

### 3.2 单人研究与计划状态

```text
DRAFT --(owner activates complete solo brief)--> PLANNING
PLANNING --(owner accepts research command)--> RESEARCH task QUEUED
RESEARCH --(valid evidence and synthesis)--> PROPOSED plan
PROPOSED --(owner ACCEPT)--> ACTIVE
ACTIVE --(input/evidence/member change)--> STALE --(REPLAN)--> PROPOSED
ACTIVE --(owner booking confirmation)--> sandbox eligible
```

研究命令可指定 `outputMode`：

- `RESEARCH_ONLY`：持久化当前 run 的 safe research summary 与 evidence；不创建 plan。
- `PROPOSE_PLAN`：完成所有配置候选和启用 capability 的覆盖后，自动创建 `PROPOSED` plan。

UI 的“帮我规划”默认使用 `PROPOSE_PLAN`；“查东京活动”等单项问题使用 `RESEARCH_ONLY`。两类结果均不可被当作 booking authority。

## 4. API 与任务合同

### 4.1 Conversation intent（内部合同）

`travel.conversation` 的结构化输出增加可选、不可直接执行的命令草案：

```ts
type PersonalResearchIntent = {
  kind: 'RESEARCH_ONLY' | 'PROPOSE_PLAN';
  requestedCapabilities: Array<
    'flight' | 'accommodation' | 'hotel' | 'activities' | 'places' | 'navigation' | 'mobility' | 'readiness'
  >;
  destinationCandidates?: string[]; // only a proposal; server validates against Trip
};
```

模型不能返回 snapshotId、provider、坐标、地址、日期、旅客数量、币种、placeId、tool call ID 或任何身份字段。前端只把草案显示为确认卡，不能将其当成已接受任务。

### 4.2 Research command

新增：`POST /api/v1/trips/:tripId/research`。

```json
{
  "requestId": "uuid",
  "outputMode": "RESEARCH_ONLY | PROPOSE_PLAN",
  "requestedCapabilities": ["activities", "places"]
}
```

服务端必须：

1. 校验 owner 为 active required member，Trip 为 `PLANNING` 或 `STALE`，且 Solo/Team brief 均符合相应候选数规则；
2. 检查 capability 所需的已确认 search preferences、consent 和 TripPlace 状态；缺失时返回稳定 `422` 缺口，不接受任务；
3. 在同一事务中创建 immutable snapshot、接受 `agent_task_runs` 行、写 outbox 与无敏感 audit；
4. 返回 `202 { runId, operation: 'RESEARCH' | 'PLAN', snapshotId, status: 'QUEUED' }`；相同 `requestId` 返回同一结果；
5. 禁止客户端传入 snapshot、工具参数、provider 字段、模型结果或 owner ID。

当前实现补充：命令处理会锁定 Trip 行，并在创建 snapshot 前查询 `(trip_id, request_id)` 的既有任务；重试直接返回既有资源。新的 snapshot、RESEARCH task、outbox 和审计事件在同一事务中写入。快照的出发地、目的地与日期只取自 Trip；缺少任一必填 brief 字段时返回 `422`，不创建持久资源。

`POST /planning/generate` 保留为兼容入口，但内部委托同一 command service，默认 `PROPOSE_PLAN` 和全 capability 集。新 Web 客户端只调用 `/trips/:tripId/research`。

### 4.3 Task 与 SSE

将 `agent_task_runs.operation` 和 API schema 增加 `RESEARCH`。任务行必须保存 `research_mode` 与受控 capability allow-list；其余 authority 与现有 `PLAN/REPLAN` 一致：`tripId`、`snapshotId`、lease、requestId、trace context 和偏好版本均由服务端写入。

SSE 只发送安全阶段：`SNAPSHOT_CREATED`、`RESEARCHING`、`VALIDATING`、`PERSISTING`、`COMPLETED`、`COMPLETED_WITH_GAPS`、`FAILED`、`STALE`。最终资源从 `GET /agent-runs/:runId` 和研究/plan REST DTO 重新获取，事件不得携带 raw provider payload、snapshot 值、未验证文本或聊天内容。

## 5. 执行和工具调度

### 5.1 统一 dispatcher

新增 `personal-trip-orchestrator-service.ts`，由 planning task handler 按 task operation/mode 调用。它复用 `generatePlan` 的受限 model tool loop、`SkillContext` execution context、`invokeSkill`、provider-search persistence、coverage matrix 和 `plan-output-validator`。

不在 Personal registry 中重复注册同名 Shared Skill，也不新增 `PersonalActivitiesSearchContext` 或 `personal_provider_search_runs`。工具的全局唯一 registry 名称继续成立；dispatcher 以 `DefaultPolicyGate('shared')` 调用已注册的 Shared Skill，并注入本 task 的 server-derived snapshot/run context。

### 5.2 Capability 规则

| Capability | 复用模块 | 单人额外门禁 |
| --- | --- | --- |
| Flight | `flight-search-service`、confirmed preferences、覆盖矩阵 | 出发地、日期、trip type/adults/cabin/currency 已确认。 |
| Accommodation / hotel | `accommodation-discovery-service`、`hotel-search-service`（待实现） | discovery 只返回非价格候选；酒店报价要求住宿偏好、日期、单房住客数和币种已确认。 |
| Activities | `activities-search-service`、Viator adapter | snapshot destination 和 feature flags 已启用；无价格/link 透传。 |
| Places / adopt | `place-search-service`、`trip-place-service` | 仅本 task 的候选与本 Trip active place；owner 可见性不得绕过。 |
| Navigation / mobility | 现有 route / mobility services | 仅 server-owned active `placeId` 与 snapshot-bound context；路线不生成商业 authority。 |
| Readiness | `visa-service` / `ReadinessSkill` | 只使用当前 owner 明确授权的国籍字段；结果仅 owner 可见。 |

启用全部 capability 代表功能路径可调用，不代表每个生产 provider 已可用。Feature flag、商业准入和 adapter contract 未满足时，保留 `UNAVAILABLE`，绝不以模型或 fixture 补全。

### 5.3 自动生成首版

对 `PROPOSE_PLAN`，Worker 对完整候选和所请求的 capability matrix 进行研究后，使用当前 `plan.comparison` 和 validator 生成 `PROPOSED`。对 `RESEARCH_ONLY`，只写 `planning_research_results` / evidence DTO，不调用 plan persistence。任何 `UNAVAILABLE` 必须保留安全 gap；`MISSING`、越权参数、旧 snapshot、丢失 lease、过期 preference 或 validator failure 均阻止 plan 写入。

## 6. 模块改动

| 处置 | 路径 / 模块 | 实施内容 |
| --- | --- | --- |
| 复用 | `shared_trips`、`trip_members`、`constraint_snapshots` | 单人成员同样构建 immutable snapshot；不复制数据模型。 |
| 复用 | `task-repository.ts`、Worker、outbox、SSE | 用同一租约、重试、幂等和结果恢复机制承载 `RESEARCH`。 |
| 复用 | Shared Skill registry、provider adapters、evidence 表、validator | 所有工具继续只由受控 dispatcher 调用，保留 source/freshness/run binding。 |
| 修改 | `types/schemas.ts`、Trip activation/create service | 依据 required-member 数验证候选数；增加 research request/response、intent 和 task operation schema。 |
| 修改 | `trip-status-guard.ts`、planning routes/services | Draft 仍拒绝；激活后的单人 Trip 允许 research；旧 generate endpoint 委托新 command。 |
| 修改 | `task-repository.ts`、`agent-task-worker.ts`、planning handler | 接受、领取、执行和终结 `RESEARCH`，写 safe result reference。 |
| 修改 | `planning-service.ts`、coverage matrix | 支持按 capability allow-list 执行；允许单候选研究；`PROPOSE_PLAN` 保持全候选确定性校验。 |
| 修改 | `travel-conversation-skill.ts`、ModelGateway contract | 输出不可执行 intent；新增确认后的 tool-loop final-message path，保留 delta gate。 |
| 新增 | `personal-trip-orchestrator-service.ts`、research command service/route | 聚合 server-side checks、snapshot/task acceptance 和 Shared dispatcher。 |
| 新增 | Web research confirmation/result cards | TanStack Query 管理 trip/run/research/plan server state；不在 Zustand/localStorage 放业务真相。 |

## 7. 数据模型、失效与权限

### 7.1 Migration

新增 versioned migration：

- `agent_task_operation` 增加 `RESEARCH`；
- `agent_task_runs.research_mode`（`RESEARCH_ONLY | PROPOSE_PLAN`）和 `requested_capabilities`（受控 enum array/JSON）；
- 可选 `research_result_id` 指向已有或新增的安全研究摘要记录；
- 为 `(trip_id, request_id, created_by_user_id)` 保留/验证唯一幂等约束；
- 更新 Trip brief validation 的数据库约束/trigger，使它可根据 required-member count 校验 Solo 1–5、Team 2–3。

不要保存 provider raw response、聊天正文、私有 snapshot 值或敏感 profile 到任务参数、研究摘要或新列。

### 7.2 Stale 规则

当前 Solo snapshot 的授权字段、Trip brief、search preference、TripPlace、成员资格、价格/库存、readiness 或 offer expiry 变化时，必须在来源变更的同一事务中：

1. 将依赖 `ACTIVE` 与 `PROPOSED` plan、confirmation、未完成 research/plan run 标记为 `STALE` / 安全取消；
2. 不再让旧 evidence 进入后续 plan；
3. 对可完整重建输入的 `PROPOSE_PLAN` enqueue 一次 idempotent `REPLAN`；单项 `RESEARCH_ONLY` 不自动重新查询，只显示已过期并要求 owner 重试。

Solo 不能绕过 profile consent：需要 profile 数据的 Shared Skill 只能消费本次 snapshot 中 owner 已授权的最小字段。私有对话不构成 consent，也不进入 snapshot。

## 8. Web 行为

1. Draft workspace 显示私有聊天和可编辑 brief，但隐藏/禁用 research command；激活前说明不会查询外部 provider。
2. Solo activation 表单允许一个目的地候选；Team 表单保持至少两个。前端只作 UX 校验，服务端为权威校验。
3. Personal chat 将意图显示为确认卡，展示所需缺口和预计将查询的 capability，不发送模型自由文本作为工具参数。
4. owner 确认后显示 durable run 阶段；断线后轮询并从 REST 恢复。
5. `PROPOSED` 首版显示 evidence freshness、source、`UNAVAILABLE` gaps 和“采纳此方案”按钮。owner `ACCEPT` 后才显示 `ACTIVE`；booking 仍需要已有显式确认动作。
6. 单人 readiness、私有 thread 和私有约束只能 owner 查看；任何后来加入的成员都不能读取过往私有 conversation 或未授权字段。

## 9. 实施阶段与依赖

| 阶段 | 工作项 | 前置依赖 | 完成标准 |
| --- | --- | --- | --- |
| 0 | 文档、OpenAPI/Zod contract、测试矩阵 | 本规范 | 事实来源同步且 Solo/Team 规则无冲突。 |
| 1 | Trip mode validator、migration、task `RESEARCH` 基础 | 0 | 单人一个候选可激活；Draft 仍不能研究；升级/干净库 migration 可运行。 |
| 2 | Research command、task repository、Worker dispatch | 1 | owner 确认命令返回幂等 `202`，断线不取消，越权/Draft/缺输入 fail closed。 |
| 3 | Unified dispatcher、flight/activities/places/navigation/mobility/readiness 接入 | 2 + 各 capability adapter | 所有已启用 Shared tools 在 Solo snapshot/run 下可执行；无独立 Personal evidence store。 |
| 4 | `PROPOSE_PLAN` synthesis、solo adoption、stale/replan | 2–3 | 自动产出首版 `PROPOSED`，单 owner accept 才 ACTIVE；失效不会激活旧版。 |
| 5 | Hotel capability | hotel implementation spec 的 provider/preference 阶段 | 复用同一 dispatcher、coverage、gap 和 validator 路径。 |
| 6 | Web confirmation/result UX、observability、安全/E2E | 1–5 | UI 无 client-side authority；全部安全、失败、并发和回归测试通过。 |

## 10. 必测场景

1. Draft 用户请求“查东京活动”只得到激活引导；不产生 snapshot、provider request 或 task。
2. Solo owner 激活一个候选的完整 brief 后，对相同 `requestId` 并发提交 research，只创建一个 snapshot/task/outbox event。
3. 任何 active Trip 缺少出发地、日期或该 capability 所需的已确认 preference 时，research 返回 `422` 且不创建 snapshot/task/outbox。`COMPLETED_WITH_GAPS` 必须可通过 run 查询接口返回。
3. 非 member、非 owner、非 required member、Team 少于两个候选以及客户端传 snapshot/provider/coordinates 均被拒绝。
4. 对每个启用 capability 验证 Shared Skill 收到的是当前 Solo snapshot/run context；它无法读取聊天原文、其他 Trip、其他用户或 raw profile。
5. `PROPOSE_PLAN` 自动创建 `PROPOSED`；owner accept 仅激活该 version。`RESEARCH_ONLY` 绝不产生 plan/booking authority。
6. `UNAVAILABLE`、429、timeout、schema drift、缺失偏好、过期 offer、provider outage 和 feature-disabled 均呈现受控 gap；无 fixture/demo fallback。
7. consent、brief、preference、place、成员或 evidence 变化会原子 stale 旧结果；旧 run 丢失 lease 后不得写 plan。
8. 私有 thread、snapshot、provider payload、国籍/证件、tool args 与价格不得出现在非 owner API、SSE、logs、metrics 或 audit；IDs 不得做 metric labels。
9. 单人研究、多人 planning、既有 adoption/confirmation、booking callback、conversation cancellation 和 worker retry 回归保持通过。

## 11. 风险与实施注意事项

| 风险 | 控制措施 |
| --- | --- |
| 将聊天理解直接等同于外部执行 | intent 仅为草案；owner 确认后的 HTTP command 才接受 durable task。 |
| 为 Personal 复制 provider/tool 实现 | 只新增统一 dispatcher；Skill、adapter、evidence、validator 均复用。 |
| 全工具启用被误解为全 provider 可用 | 每项保持 feature flag、production approval、deadline、contract test 与 `UNAVAILABLE`。 |
| 流式文本与多轮工具调用混合导致不安全 partial output | 工具执行与最终消息分段；通过现有 delta gate 后才流式最终安全文本。 |
| 单人成员变为多人后旧私有结果泄漏或 quorum 变化 | 成员变更 stale 当前结果；重新创建 snapshot；私有 thread/evidence 不向新成员公开。 |
| Research 与 plan 权威混淆 | `RESEARCH_ONLY` 和 `PROPOSE_PLAN` 采用不同持久化终态；只有 validated `ACTIVE` plan 可进入确认/booking。 |

## 12. 验证命令

实施每阶段至少运行：

```text
cd apps/api
npm run typecheck
npm run lint
npm test
npm run docs:verify
```

涉及 Web 时还需运行 `apps/web` 的 typecheck、lint 和 Vitest。CI 不依赖 live provider；live smoke 只使用合成地点/日期且不含用户、Trip 或私聊数据。
