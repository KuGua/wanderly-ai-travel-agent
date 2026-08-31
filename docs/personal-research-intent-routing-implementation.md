# Personal Research Intent Routing 实施规范

**状态：** 已确认，待实施  
**适用范围：** Personal Agent 私有对话、owner-confirmed Research command、Shared Trip Orchestrator  
**事实来源：** 本文、`TECH_STACK.md`、`docs/PRD.md`、`docs/backlog.md`、`docs/test-scenarios.md`

## 1. 目标与完成条件

本规范补齐私有聊天到受控旅行研究之间的断链。用户以中文或英文在 Personal Agent 私聊中提出酒店、活动、地点或路线查询时，系统只生成一个不可执行的研究草案；只有当前 owner 显式确认后，服务端才创建 snapshot 和 `RESEARCH` task，并由 Shared Trip Orchestrator 调用 typed provider adapter。

完成后，以下链路成立：

```text
owner private thread
  -> server-side personal research intent classifier
  -> persisted, non-executable research draft + SSE event
  -> owner confirmation card
  -> POST /trips/:tripId/research
  -> immutable constraint_snapshot + durable RESEARCH task
  -> Shared Trip Orchestrator + Shared Skills
  -> provider evidence or UNAVAILABLE
```

完成不包含让 Personal Agent 直接调用 provider、让模型自动确认任务、真实预订、支付、签证结论，或用 fixture/Demo data 填充 provider 缺口。

## 2. 固定技术决策

1. **职责分层。** 自然语言识别仅属于 Personal Agent 入口；`hotel.search`、`navigation.route` 等外部能力仍仅由 Shared Worker 执行。两层复用同一 capability schema、前置条件校验与 error code，但不共享私聊正文。
2. **规则优先且高精度。** MVP 使用服务端、版本化的中英文本规则识别明确的研究动作；不使用浏览器传入的 `intent` 字段作为业务意图，也不让 LLM function call 决定工具执行。低置信度表达继续作为普通对话或确定性澄清。
3. **草案不具执行权。** classifier 的输出是受 Zod 约束的 `PersonalResearchIntent`，不带坐标、日期、人数、币种、provider、place ID、身份或 tool-call ID；前端不得从草案直接发起 provider 请求。
4. **确认后重新推导权威输入。** 现有 `POST /trips/:tripId/research` 是唯一的研究接受入口。它继续在事务中验证成员资格、Trip 状态、brief、search preferences、hotel provider binding 与授权，并创建 immutable snapshot 和 durable task。
5. **草案可恢复。** 待确认草案是用户可见的交互状态，必须服务端持久化并可由 `GET /agent-runs/:runId` 恢复；SSE 仅用于即时显示，刷新或断线不能令草案消失。
6. **路线分阶段。** 原始自然语言路线请求不能直接调用 `navigation.route`。该 Skill 只接受两个已采用的、非私有的 `ACTIVE trip_place` ID；端点不完整或歧义时必须进入地点选择/采用流程。

## 3. 当前实现基线

### 3.1 已复用模块

| 模块 | 当前职责 | 本方案的使用方式 |
| --- | --- | --- |
| `routes/chat-threads.ts` + `tasks/task-repository.ts` | 接受私聊 turn，持久化 `CONVERSATION` task | 保持为唯一私聊入口；不增加浏览器直连工具 API |
| `tasks/handlers/conversation-task-handler.ts` | 构建同 thread context、执行安全 gate、持久化最终 assistant message | 增加分类、草案持久化及 `research.intent_extracted` 发布 |
| `skills/personal/travel-conversation-skill.ts` | Personal 对话和安全边界 | 接收 server-derived classification；对 research proposal 返回确定性确认文案，不调用模型/provider |
| `routes/research.ts` | owner-confirmed Research command | 原样复用为唯一执行接受路径 |
| `tasks/personal-trip-orchestrator-service.ts` | 在 Shared policy 下按 capability 调度研究 | 原样复用；只接收已确认 capability list |
| `skills/shared/*.ts` | Hotel、Place、Navigation、Mobility 等 typed skills | 原样复用，继续依赖 snapshot/run binding |
| `ResearchConfirmationCard` + `TravelAgentChat` | 显示确认卡、消费 SSE | 增加草案恢复与缺口状态展示 |

### 3.2 必须修改的模块

| 模块 | 修改 |
| --- | --- |
| `types/schemas.ts` | 扩展 conversation output、agent-run response 和 stream contract；新增草案状态/缺口 schema |
| `db/schema.ts`、迁移 | 在 `agent_task_runs` 增加安全的 `research_intent_draft` JSON 与 `research_intent_state`；禁止保存原始问题 |
| `tasks/task-repository.ts` | 增加 lease-guarded 草案写入及 owner-safe run DTO 读取 |
| `conversation-task-handler.ts` | 在模型调用前分类，写入并发布草案；在草案分支跳过普通 LLM 文本生成 |
| `travel-conversation-skill.ts`、`conversation-safety.ts` | 区分“请求研究草案”和“要求直接给出实时事实”；扩展中文安全规则但不把有效 research proposal 拦截为 refusal |
| `TravelAgentChat` | 恢复 persisted draft；渲染 setup/place-selection card；确认后使用现有 mutation |
| `agent-run` route/query contracts | 返回当前 owner 的安全草案，使刷新恢复确认卡 |

### 3.3 必须新增的模块

| 模块 | 责任 |
| --- | --- |
| `services/personal-research-intent-classifier.ts` | 纯函数、版本化的中英高精度规则分类 |
| `services/personal-research-readiness-service.ts` | 只读取 server-owned Trip/feature/authorization 状态，决定草案可确认、需补资料或需地点选择 |
| `services/personal-route-place-proposal-service.ts` | 第二阶段路线端点解析、候选展示与 owner adoption；仅在路线实施阶段创建 |
| `tests/services/personal-research-intent-classifier.test.ts` | 规则、语言、歧义和回归覆盖 |

## 4. 数据模型与契约

### 4.1 草案模型

复用现有 `PersonalResearchCapability` 与 `PersonalResearchKind`。MVP 草案不使用当前 schema 中未被 research endpoint 消费的 `destinationCandidates` 字段。

```ts
type PersistedResearchIntentDraft = {
  schemaVersion: 1;
  kind: "RESEARCH_ONLY" | "PROPOSE_PLAN";
  requestedCapabilities: Array<
    "flight" | "accommodation" | "hotel" | "activities" |
    "places" | "navigation" | "mobility" | "readiness"
  >;
  classifierVersion: string;
  readiness: "READY" | "NEEDS_SETUP" | "NEEDS_PLACE_SELECTION";
  missing: Array<
    "TRIP_NOT_ACTIVE" | "DESTINATION_NOT_CONFIGURED" | "DATES_MISSING" |
    "FLIGHT_PREFERENCES_MISSING" | "STAY_PREFERENCES_MISSING" |
    "HOTEL_PROVIDER_NOT_APPROVED" | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING" |
    "ROUTE_ENDPOINTS_UNCONFIRMED"
  >;
};
```

`agent_task_runs.research_intent_draft` 只保存上述 JSON；`research_intent_state` 为 `PROPOSED | DISMISSED | CONFIRMED | SUPERSEDED`。确认产生新 `RESEARCH` run 后，将 originating conversation run 标记 `CONFIRMED`；草案本身从不作为研究任务的输入权威。

新增 migration 必须有 `CHECK` 或应用层 Zod 双重校验。不得复用既有 `agent_task_runs.intent` 文本列：该列保存的是浏览器 UI intent（`auto_intro | user_typed`），语义不同。

### 4.2 对外 API 与 SSE

不新增直接工具 API，保留：

```http
POST /api/v1/threads/:threadId/turns
POST /api/v1/trips/:tripId/research
GET  /api/v1/agent-runs/:runId
GET  /api/v1/agent-runs/:runId/stream
```

`GET /agent-runs/:runId` 的 owner-safe DTO 增加可选字段：

```json
{
  "researchIntentDraft": {
    "kind": "RESEARCH_ONLY",
    "requestedCapabilities": ["hotel"],
    "readiness": "READY",
    "missing": []
  }
}
```

新增或扩展 SSE 事件：

```json
{
  "event": "research.intent_extracted",
  "runId": "uuid",
  "generationAttempt": 1,
  "intent": { "kind": "RESEARCH_ONLY", "requestedCapabilities": ["hotel"] },
  "readiness": "READY",
  "missing": []
}
```

事件不包含用户原文、地点自由文本、Profile、snapshot、provider 请求或结果。既有 `research.stage` 继续仅用于确认后的 Research run。

## 5. 分类、readiness 与数据流

### 5.1 Classifier 输入与输出

Classifier 输入是当前 `question` 的 NFKC 规范化文本和受信任的 `tripId` 上下文；不接收浏览器 history。规则以动词 + 旅行对象为基础，必须支持中文简繁与英文：

| 高精度表达类别 | 输出 |
| --- | --- |
| `查/搜/找/搜索/查询` + `酒店/住宿/饭店`，或英文 `search/find` + `hotel/stay` | `RESEARCH_ONLY: [hotel]` |
| `规划/安排行程/比较方案`，或英文 `plan/compare itinerary` | `PROPOSE_PLAN`，仅使用产品定义的全能力组合 |
| `查/找` + `景点/活动/餐厅` | `RESEARCH_ONLY: [activities]` 或 `[places]` |
| `怎么走/路线/导航/从 A 到 B`，或英文 directions/route | `RESEARCH_ONLY: [navigation]`，并要求地点选择 |
| `介绍/推荐区域/感觉如何/哪里适合住` | `CONVERSATION` |

规则只能在命中明确动作时提案；否定表达、假设讨论、没有旅行对象、多个相互冲突 capability 或低置信度文本均返回 `CONVERSATION`。分类输出不得推导目的地、日期、人数或身份。

### 5.2 Readiness 判定

`personal-research-readiness-service` 在草案落库前执行：

1. Trip 必须存在，当前 owner 必须是 active required member，且 Trip 为 `PLANNING` 或允许 research 的 `STALE` 状态；`DRAFT` 返回 `TRIP_NOT_ACTIVE`。
2. Hotel 必须有 destination、日期、已确认 stay preferences，且 `PLAN_ENABLE_HOTEL=true`；若任务绑定 Nuitee，还必须有当前有效的 quote-nationality authorization。
3. Flight、activities、mobility 按现有 `/research` route 的 confirmed flight preferences 门禁处理。
4. Navigation 或 mobility 必须存在两个 owner 已确认、非私有、`ACTIVE` 的 `trip_place`。否则只产生 `NEEDS_PLACE_SELECTION`，绝不以任意两个旧地点替代。
5. 任意缺口都返回稳定 code 和 UI 可显示的下一步，且不创建 snapshot、RESEARCH task 或 provider request。

### 5.3 Conversation Worker 流程

```text
acceptConversationTask
  -> buildConversationContext (existing)
  -> classify(question)
  -> evaluateReadiness(tripId, owner, draft)
  -> persist draft conditionally on current lease
  -> publish research.intent_extracted
  -> deterministic confirmation/setup/place-selection response
  -> final safety gate
  -> persist assistant message + complete conversation task
```

普通对话继续走现有 `travel.conversation -> ModelGateway` 流程。对于可提案研究请求，禁止先把问题送至普通模型生成“无法查询”的回答；对于直接要求实时事实但无法提案的情况，保留 `SAFE_REFUSAL`。

### 5.4 确认后的执行流程

```text
ResearchConfirmationCard
  -> owner clicks confirm
  -> POST /trips/:tripId/research { requestId, outputMode, requestedCapabilities }
  -> existing acceptance transaction validates fresh authority
  -> constraint_snapshot + RESEARCH task
  -> Shared Worker invokes enabled Skills
  -> LIVE evidence or COMPLETED_WITH_GAPS / UNAVAILABLE
```

确认时必须重新读取所有前置条件；草案产生后发生的授权撤回、偏好变化、Trip stale 或 feature flag 关闭都必须阻止接受或产生 `UNAVAILABLE`，不能复用草案时的旧判断。

## 6. 路线端点选择子流程

路线请求与酒店研究不共用直接确认卡。路线第一阶段仅提供“需要确认出发地和目的地”的卡片；它不调用 `navigation.route`。

后续 `personal-route-place-proposal-service` 按下列流程交付：

1. owner 在 UI 中选择或搜索两个地点；地点搜索使用 server-controlled destination/reference context，返回候选和来源；
2. owner 明确采用候选，创建/激活 `trip_place`，并记录审计事件；
3. 仅当两个端点均为同一 Trip 的 `ACTIVE`、非 `OWNER_PRIVATE` place 后，显示路线 research 确认卡；
4. 确认后的 `RESEARCH` 才调用 `navigation.route`。默认交通模式必须由用户选择，不能把“机场到市区”静默设为步行；公共交通实时班次若 provider 未交付，显示 `UNAVAILABLE`。

`西园町` 等名称可能歧义，必须展示候选及来源而非按模型猜测。此子流程在路线 provider 可用前不得承诺实时公交时刻。

## 7. 实施阶段与依赖

### Phase 0 - Contract 与迁移

1. 更新 Zod/OpenAPI/Web contracts，新增 persisted draft/readiness schema。
2. 添加 versioned DB migration 和 `agent_task_runs` repository 读写方法。
3. 更新 PRD、backlog、test scenarios 与本规范。

**依赖：** 无。  
**完成标准：** migration 可重复执行；无原文或敏感字段进入草案列。

### Phase 1 - Personal Intent Proposal

1. 实现 classifier、readiness service 和中文/英文规则测试。
2. 修改 conversation handler，使研究草案分支跳过普通 LLM，持久化草案、发布 SSE 和确定性 assistant response。
3. 将 `conversation-safety` 改为先允许有效草案、再拦截未可执行的实时事实请求。

**依赖：** Phase 0。  
**完成标准：** 酒店、活动、完整规划、普通聊天和低置信度请求分流可测试；没有 provider 调用。

### Phase 2 - Web Confirmation 与恢复

1. 扩展 agent-run query，刷新后恢复未处理草案。
2. 更新 `ResearchConfirmationCard` 显示 capability、setup 缺口或路线地点选择下一步。
3. 确认仅调用既有 research mutation；dismiss 更新草案状态且不创建 task。

**依赖：** Phase 0、Phase 1。  
**完成标准：** SSE 断线、刷新和重复点击均不丢失或重复执行研究。

### Phase 3 - Hotel End-to-End 验收

1. 使用现有 `hotel.search` capability 验证 `READY` → confirmed `RESEARCH` → evidence/`UNAVAILABLE`。
2. 覆盖 Nuitee authorization、provider binding、feature flag、缺 dates/preference 的行为。

**依赖：** Phase 2、已配置的 Hotel provider。  
**完成标准：** 不可用时只显示有来源的 gap，绝不使用 fixture fallback。

### Phase 4 - Route Endpoint Selection

1. 实现 place proposal/search/adoption UX 与服务端边界。
2. 仅在两个 ACTIVE place 成立后开放 navigation confirmation。
3. 增加路线 evidence、歧义和 stale 测试。

**依赖：** Phase 2、Place/Navigation provider 可用。  
**完成标准：** 不能因为任意已有地点或模型猜测而产生错误路线。

## 8. 测试、可观测性与验收

### 8.1 自动化测试

- 中文/繁体中文/英文酒店研究词触发 hotel 草案；“桃园住宿区域推荐”不触发。
- 草案生成、dismiss、刷新恢复、SSE 重放和重复确认均不产生重复 Research task。
- `DRAFT`、无日期、无 stay preferences、provider disabled、Nuitee nationality authorization 缺失均不调用 hotel provider。
- 研究接受时重新验证授权和 preferences；草案生成后撤回授权必定拒绝或作废。
- 直接路线文本在端点未采用时不调用 `navigation.route`；端点歧义要求选择；模式未选择不默认步行。
- Provider timeout/no results/invalid response 持久化 `UNAVAILABLE`/`COMPLETED_WITH_GAPS`，无模型编造回退。
- 用户原文、地点自由文本、身份和 provider raw payload 不进入 draft、audit、logs、metrics、traces 或 SSE。

### 8.2 可观测性

新增低基数指标：

- `personal_research_intent_total{capability,disposition}`；
- `personal_research_intent_confirmation_total{outcome}`；
- `personal_research_readiness_total{capability,outcome}`。

新增安全结构化日志/trace event：`personal_research_intent.classified`、`personal_research_intent.confirmed`、`personal_research_intent.dismissed`。可携带 `trip_id`、`run_id`、`classifier_version` 于 log/trace context，但不得作为 metric label，且不得记录 question 或地点原文。

## 9. 风险与禁止项

- classifier 的误判风险以高精度优先处理：宁可回落普通对话或澄清，也不自动发起外部 research。
- Research draft 永远不是权限、snapshot 或 provider 参数来源；确认时所有权威字段必须重建。
- 不能把 `PLAN_ENABLE_HOTEL` 或 provider selection 启动日志当成实际 provider 调用证据；必须以 tool dispatch/provider evidence/audit 记录验证。
- 不得扩展 Personal Agent 为直接 Shared Skill caller，不得新建自由 multi-agent、Redis、Temporal 或 WebSocket。
- fixture 只能用于测试和 adapter contract；运行时缺数据必须 `UNAVAILABLE`。

