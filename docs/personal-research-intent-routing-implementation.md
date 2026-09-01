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

### 4.1.1 已实现的确认与路线绑定

`POST /trips/:tripId/research` 可选接收 `originatingIntentRunId`。该字段存在时，服务端在同一事务中锁定来源 `CONVERSATION` run，校验 owner、Trip、`PROPOSED` 状态和能力集合，创建 `RESEARCH` run 后才迁移来源草稿到 `CONFIRMED`。相同 `requestId` 返回既有 run；不同请求不得重复确认同一草稿。

路线选择持久化在 `research_route_selections`，以 intent run 为一对一键，保存两个非私有 `ACTIVE` TripPlace 和用户明确选择的 `WALK | DRIVE | CYCLE`。浏览器只能采纳服务端返回的 `trip_place:<id>` 候选标识，不能提交坐标、来源或置信度；Worker 通过 RESEARCH run 的 `originating_intent_run_id` 读取该选择，缺失或失效即 fail closed，不回退到任意旧地点或默认步行。

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

### 5.2 Readiness 判定（两层模型 — Phase 2）

`personal-research-readiness-service` 在草案落库前执行：

**Hard blockers（必须解决才能发起研究）**——research plan 不能在缺失这些项时构建，调用方拿到 `NEEDS_SETUP`：

| Code | 触发条件 |
|---|---|
| `DESTINATION_NOT_CONFIGURED` | `trip.destinationCandidates` 为空 |
| `DATES_MISSING` | `travelDateStart` 或 `travelDateEnd` 为空 |
| `HOTEL_PROVIDER_NOT_APPROVED` | `hotel` capability + `PLAN_ENABLE_HOTEL !== "true"` |
| `QUOTE_NATIONALITY_AUTHORIZATION_MISSING` | 酒店供应商绑定 Nuitee 且当前 owner 没有 active quote-nationality authorization |
| `ROUTE_ENDPOINTS_UNCONFIRMED` / `MODE_NOT_CHOSEN` | navigation/mobility 需要且 endpoint 选择未就绪 |

**Soft warnings（可降级，研究可启动）**——call 站点拿到 `READY_WITH_WARNINGS`，按钮可点：

| Code | 触发条件 |
|---|---|
| `TRIP_NOT_ACTIVE` | Trip 状态非 `PLANNING / CONFIRMED / BOOKED`（即 `DRAFT / STALE / CANCELLED`）——所有状态都研究可选 |
| `FLIGHT_PREFERENCES_MISSING` | flight / activities / mobility capability + 无最新 `tripSearchPreferences` 行——使用默认值 |
| `STAY_PREFERENCES_MISSING` | hotel capability + `PLAN_ENABLE_HOTEL=true` + 无最新 `tripStaySearchPreferences` 行——使用默认值 |

**Readiness 状态扩展**——原 `READY | NEEDS_SETUP | NEEDS_PLACE_SELECTION` 增加 `"READY_WITH_WARNINGS"`，表示无 blocker 但有 warning；`READY` 与 `READY_WITH_WARNINGS` 都能触发 `POST /trips/:tripId/research`。

**Trip 生命周期闸门移除**——`requireResearchEligible` 不再因 `DRAFT / STALE / CANCELLED` 拒绝 research；只有 membership 与 brief-mode 校验仍 409/422。`requireActiveTrip`（用于 planning / consent / booking 等非 research 操作）继续对 `DRAFT` 严格拒绝。详见 §5.3 的两闸门对比。

**Wire 形态**——服务响应：

```ts
{
  readiness: "READY" | "READY_WITH_WARNINGS" | "NEEDS_SETUP" | "NEEDS_PLACE_SELECTION",
  blockers: ResearchMissingCode[],   // hard
  warnings: ResearchMissingCode[],    // soft
  missing: ResearchMissingCode[],    // 保留：= blockers ∪ warnings，向后兼容
}
```

`missing[]` 是 `blockers ∪ warnings` 的稳定联合，确保旧客户端按原契约读取即可。`categorize()` 是分类的 single source of truth。

### 5.3 Capability 二次确认弹窗（Phase 2）

真实供应商调用的客户端二次确认。所有 6 个外部 capability 命中时弹窗：

- `flight` —— Amadeus / FlightAPI / SerpApi（付费/限速）
- `hotel` —— Nuitee LiteAPI / SerpApi（付费/限速）
- `accommodation` —— OpenTripMap（外部 HTTP）
- `places` —— ORS（外部 HTTP）
- `mobility` —— Amadeus Transfer（外部 HTTP）
- `navigation` —— ORS Directions（外部 HTTP）

行为契约：

- `ResearchConfirmationCard`（Path A：直接 `POST /trips/:tripId/research`）与 `ConversationalSetupCard`（Path B：`POST /agent-runs/:runId/research-setup/confirm-and-search`）的确认按钮都套这道闸。
- 弹窗为 `apps/web/src/components/ui/confirm-dialog.tsx`——固定位置遮罩、`role="dialog"`、amber 警告文案、必勾选 acknowledgement 复选框（未勾选时确认按钮 disabled）。
- 用户确认后写入 `sessionStorage` 的 `research.realProviderAcked.<capabilities-hash>`，key 是按 capability 排序后拼接的稳定字符串。换 session / 清浏览器存储会重新弹。
- 取消发射 `recordUiDiagnostic("research.real_provider_declined", { capabilities })`，确认发射 `recordUiDiagnostic("research.real_provider_acknowledged", { capabilities })`——可观测拒绝率/确认率。

服务端不做这道闸——服务端的 `requireResearchEligible` 已不再因 DRAFT 拒绝；服务端再叠闸门会让服务端成为策略与客户端 UX 双源真理，违反 §4.1 的「draft is non-executable JSON envelope」原则。

### 5.4 Conversation Worker 流程

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

## 10. Conversational Setup (§9) — owner 补全研究意图缺失字段

`NEEDS_SETUP` 不再只是死路；服务端在 conversation worker 命中研究意图分类器后立即打开 `personal_research_setup_sessions` 行，驱动 owner-only 临时设置会话，并由一次受 gate 约束的 LLM 调用产出单条追问。Owner 在对话或卡片内填齐后，必须显式点击「确认并搜索」；服务端在单一事务中写 trip-level 字段、偏好 slot、`stale cascade`、审计、迁移草稿、`acceptResearchTask` 并 publish `SNAPSHOT_CREATED`。

### 10.1 设计原则

- **Slot-based 表结构**：每个 capability 占一列 JSON slot；新增 capability 只需 `ALTER TABLE ADD COLUMN jsonb` + 新 Zod schema + 新 widget，不必重写 session 表。
- **Server 重组 `missing[]`**：客户端从不写入；每次 `applyAnswer` 服务端按 trip / preferences / slots 现状重算。
- **乐观版本**：`applyAnswer` 需要 `expectedVersion`；`cancel` 与 `confirmAndSearch` 在事务里 `SELECT ... FOR UPDATE`。
- **懒过期**：无后台 worker；`applyAnswer` / `confirmAndSearch` 在 `now > expiresAt` 时机会式 `OPEN → EXPIRED` 后返 `410 Gone`。
- **不写作者内容**：原始问题、profile、snapshot、place 原文、PII 永不入库；审计 summary 仅 `{ sessionVersion, fieldsFilled }`。
- **首版范围**：Solo Trip + 已激活 + 酒店 / 机票 / 行程级 slots；预算、活动、共享行程显式延后。

### 10.2 Schema 与索引

迁移：`apps/api/migrations/0042_personal_research_setup_sessions.sql`

```sql
CREATE TYPE personal_research_setup_status AS ENUM
  ('OPEN', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED');

CREATE TABLE personal_research_setup_sessions (
  intent_run_id UUID PRIMARY KEY
    REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  trip_id UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  departure_city VARCHAR(64),
  travel_date_start DATE,
  travel_date_end DATE,
  stay_preferences JSONB,
  flight_preferences JSONB,
  missing JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  status personal_research_setup_status NOT NULL DEFAULT 'OPEN',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prs_dates_pair_chk CHECK (
    (travel_date_start IS NULL AND travel_date_end IS NULL)
    OR (travel_date_start IS NOT NULL
        AND travel_date_end IS NOT NULL
        AND travel_date_end > travel_date_start)
  ),
);

CREATE UNIQUE INDEX personal_research_setup_sessions_one_open_per_trip_owner
  ON personal_research_setup_sessions(trip_id, owner_user_id)
  WHERE status = 'OPEN';
```

CHECK 仅覆盖 date pair；OPEN 会话必须允许从空 slot 开始，完整性在确认事务中按原始 intent 的 capabilities 重新校验。slot JSON 形状由 Zod 在服务边界校验。Slot 字段可空，所以添加新 capability 仅需 `ALTER TABLE ADD COLUMN jsonb` + 同步 Drizzle 类型。

### 10.3 服务层（`personal-research-setup-service.ts`）

- `getOrOpenSession({ runId, ownerUserId, tripId, requestedCapabilities })`：先通过 `requireResearchEligible`，只有 `PLANNING` / `STALE` 的 required member 才能 upsert 一行 OPEN 会话，`expires_at = now + 15min`；用 `partial unique index` 处理同一 `(trip, owner)` 多会话场景。`missing[]` 由 `computeMissingForSetup(trip, slots, capabilities)` 服务端重算。DRAFT 仅显示 `TRIP_NOT_ACTIVE`，不创建可编辑会话。
- `applyAnswer({ runId, ownerUserId, expectedVersion, patch })`：`SELECT FOR UPDATE`，Zod 解析 `patch`（discriminated union over `field ∈ {departureCity | travelDates | stayPreferences | flightPreferences}`）；`travelDates` 在一个版本更新中提交 `{ start, end }`，校验 `end > start`，按该 intent 的真实 capabilities 重算 `missing[]`，`version+1`；opportunistic `OPEN → EXPIRED` 在 `expiresAt < now` 时触发。`422 / 409 / 410` 各自明确。
- `cancelSession({ runId, ownerUserId })`：`status = CANCELLED`，幂等。
- `confirmAndSearch({ runId, ownerUserId, tripId, requestId })`：单事务按以下顺序（顺序固定以满足 `agent_task_runs_one_active_planning` 部分唯一索引）：
  1. `SELECT setup FOR UPDATE`，校验 owner / trip / `status=OPEN` / 未过期。
  2. `findResearchTaskByRequestId`：命中即标记 CONFIRMED 并返既有 202 envelope（幂等）。
  3. `SELECT agentTaskRuns FOR UPDATE`，重读 `researchIntentState='PROPOSED'` 与 `operation='CONVERSATION'`。
  4. `requireResearchEligible(tripId, owner, destinations, tx)`。
  5. `resolvePersistedHotelProviderName` + `loadActiveQuoteNationality`（Nuitee 时）。
  6. 正则校验日期、`superRefine` 校验 stay / flight preferences。
  7. `UPDATE sharedTrips` 写 `travel_date_start` / `travel_date_end` / `departure_cities`（变更时）。
  8. `saveConfirmedStaySearchPreferences({ tx })` 与 `saveConfirmedSearchPreferences({ tx })`：两个 service 均已加 `tx?: Tx` 参数以支持嵌套事务。
  9. **stale-cascade 先于 accept**：`stalePlansAndConfirmationsForTrip` 把既有 RUNNING / QUEUED 改为 STALE，腾出部分唯一索引槽。
  10. `createConstraintSnapshot` 用更新后的 trip-level 字段。
  11. `recordAudit({ action: "PERSONAL_RESEARCH_SETUP_CONFIRMED", summary: { sessionVersion, fieldsFilled } })`。
  12. 标记 `setup_sessions.status = CONFIRMED`、`transitionResearchIntentState PROPOSED → CONFIRMED`。
  13. `acceptResearchTask({ originatingIntentRunId: runId, requestId, tx, ... })`；其内部 `findResearchTaskByRequestId` 处理重复。
  14. 事务提交后通过 `queueMicrotask` publish `research.stage SNAPSHOT_CREATED`。
- 所有失败路径必须保持：未写偏好、未建 task、未改 intent state、仅审计失败行（`whitelistSummary` 只允许 `sessionVersion` / `fieldsFilled` / 其它低基数枚举键）。

### 10.4 LLM 追问（`setup-followup-generator.ts` + `LLMGateway.generateSetupFollowup`）

- 输入：缺哪几个 code、locale、已填字段名（**不含值**）、服务端 `missingCodeLabels` 表。
- 输出 schema：`{ questionCode: researchMissingCodeSchema, promptText: string ≤ 280 }`。
- 安全门：
  - 输入侧：`missing[]` 为空直接返 `null`（不进 LLM）。
  - 输出侧：`setupFollowupOutputSchema.safeParse` 失败 → fallback `reason=schema`；`questionCode ∉ missing[]` → fallback `reason=invalid_code`；PII / 价格 / 实时词正则命中（passport / long-digit ID / phone / `¥ $ € £ + 数字` / currency codes / today/tonight/right now 等中英文实时词）→ fallback `reason=pii`；超长 → fallback `reason=length`。
  - 模型抛出 → fallback `reason=model_error`。
- Fallback 走 `deterministicFallback(missing, locale)`，返回 `MISSING_COPY` 风格的简短模板，按 locale 选择中文/英文。
- 全程 `try/catch`，**永不抛**；失败 fallback 也仅写 `recordAudit({ action: "PERSONAL_RESEARCH_SETUP_FOLLOWUP_FELLBACK", summary: { reason, missingCount } })`。
- 度量：`personal_research_setup_followup_total{outcome ∈ model | fallback, reason ∈ model | empty | no_gateway | schema | invalid_code | pii | length | model_error}`。

### 10.5 Conversation Worker 集成（`conversation-task-handler.ts#handleClassifiedResearchRequest`）

当 `readiness === 'NEEDS_SETUP'`：
1. `getOrOpenSession({ requestedCapabilities: classifiedIntent.requestedCapabilities })`（独立 try/catch，失败仅计数 `open_failed`，不阻塞草稿）。
2. `generateSetupFollowup({ requestedMissing: readiness.missing, locale: "zh-CN", filledFieldNames: [] })`。
3. publish `research.setup.followup { runId, followup: { questionCode, promptText }, source: "model" | "fallback" }`。
4. 把追问文本拼到现有 templated `buildClassifiedResearchReply` 末尾一起走 `message.delta` → `completeConversationTask` → ASSISTANT message 持久化路径。

### 10.6 Web 集成（`apps/web`）

- `agentRunResponseSchema.researchSetupSession`：仅当 `OPEN + 未过期` 时投影；前端 refresh 时直接 hydrate，无需再次调 `GET`。
- `agentStreamEventSchema` 新增 `research.setup.followup` 变体；`travel-agent-chat.tsx` 内置 `setupFollowup` 状态，渲染为 inline 气泡（`data-testid="setup-followup-bubble"`）。
- `ResearchSetupCard` 改为两段：`setupSession` 缺失或 missing code 越界 → 既有只读 fallback；否则挂载 `ConversationalSetupCard` 渲染日期 / 房间数 / 成人 / 币种 widget。`disabled` 状态由 `useMemo` 本地校验，日期以单个 `travelDates` patch 保存；一次确认尝试复用同一个 `requestId`，并以同步 ref 锁住完整的“保存 slot → 确认”生命周期，避免重复点击产生版本冲突。失败在卡片内显示并刷新 run session，绝不留下未处理 Promise rejection。
- Hooks：`useOpenResearchSetup`、`useSaveResearchSetupAnswer`、`useCancelResearchSetup`、`useConfirmResearchSetup`；mutation 成功后 `setQueryData` 写回 `["agent-runs", runId]` 缓存，避免再次 `refetch` 闪烁。可选 transport 方法必须经由 `api.method(...)` 调用，不能先解构再调用，否则 `HttpTravelApi` 会失去 `this.client` 绑定。
- UI diagnostics：`setup.session_open` / `setup.field_update` / `setup.confirm` / `setup.cancel` / `setup.followup_received`。

### 10.7 取舍

- **不直接复用 `researchIntentDraft` 的 JSON 列**：draft 明确禁止携带 dates / adults / currency；混用会让 schema 与审计语义同时被破坏。
- **不引入后台 worker**：MVP 没有跨进程调度，过期检查放在最热的 mutation 路径上；后续真要后台清理时再加 worker。
- **机票 widget 暂不实现**：首版只渲染 `DATES_MISSING` + `STAY_PREFERENCES_MISSING`；`FLIGHT_PREFERENCES_MISSING` 保持只读提示，等专门的机票偏好卡片就绪，避免把住宿输入误写为航班偏好。
- **不预先加 `DEPARTURE_CITY_MISSING` 到 readiness schema**：现有 readiness service 不产出该 code；服务层依旧接受 `departureCity` 字段写入，但缺失时不暴露在 `missing[]`，避免 readiness 测试改动。

### 10.8 实施产物（落地文件）

- `apps/api/migrations/0042_personal_research_setup_sessions.sql`（新增）
- `apps/api/src/db/schema.ts`：`personalResearchSetupStatusEnum` + `personalResearchSetupSessions` 表
- `apps/api/src/services/audit-service.ts`：新增 7 个 `PERSONAL_RESEARCH_SETUP_*` action
- `apps/api/src/services/stay-search-preferences-service.ts`、`flight-search-preferences-service.ts`：加 `tx?: Tx` 参数（`saveConfirmedStaySearchPreferences`、`saveConfirmedSearchPreferences`）
- `apps/api/src/services/personal-research-setup-service.ts`（新增）
- `apps/api/src/services/setup-followup-generator.ts`、`setup-followup-types.ts`（新增）
- `apps/api/src/providers/setup-followup-prompts.ts`、`setup-followup-schema.ts`（新增）
- `apps/api/src/providers/model-gateway.ts`、`llm-gateway.ts`：新增 `generateSetupFollowup` 方法
- `apps/api/src/observability/metrics.ts`：新增 `personal_research_setup_session_total` + `personal_research_setup_followup_total` 计数器
- `apps/api/src/types/schemas.ts`：新增 `personalResearchSetup*` schema、`setupFollowupEventSchema`、在 `agentStreamEventSchema` 与 `agentRunResponseSchema` 增加对应分支
- `apps/api/src/tasks/task-repository.ts`：`toRunResponse` 投影 `researchSetupSession`；`getAuthorizedAgentRun` 同步加载
- `apps/api/src/tasks/handlers/conversation-task-handler.ts`：`handleClassifiedResearchRequest` 在 NEEDS_SETUP 分支调用 `getOrOpenSession` + `generateSetupFollowup` + publish followup SSE
- `apps/api/src/routes/personal-research-setup.ts`（新增 4 个 owner-only 路由）
- `apps/api/src/app.ts`：注册新路由
- `apps/web/src/lib/api/contracts.ts`：新增 `ResearchSetupSessionResponse` / `setupFollowupEventSchema` / 4 个新 schema；在 `agentRunResponseSchema` 与 `agentStreamEventSchema` 投影
- `apps/web/src/lib/api/travel-api.ts`、`http-travel-api.ts`：4 个新方法
- `apps/web/src/lib/query/hooks.ts`：4 个新 hook + UI diagnostic emit
- `apps/web/src/lib/observability/ui-diagnostics.ts`：5 个新 action
- `apps/web/src/lib/api/contracts.ts`：新增 `tripStaySearchPreferencesInputSchema` 与 `tripSearchPreferencesInputSchema` 镜像
- `apps/web/src/components/trips/personal-research/research-setup-card.tsx`：两段渲染，只读 fallback + conversational
- `apps/web/src/components/explore/travel-agent-chat.tsx`：rehydrate `researchSetupSession`、渲染 followup bubble、wire `setupSession` 传入 card
- 单元 / 集成测试：`tests/services/setup-followup-generator.test.ts`（9 用例）、`tests/contracts/agent-run-response-schema.test.ts`（fixture 增加 `researchSetupSession: null`）

### 10.9 测试矩阵（与 `docs/test-scenarios.md` 同步）

- 单元：`generateSetupFollowup` 模型成功 / `questionCode ∉ missing` / PII / 价格 / 模型抛 / 空 missing / 工厂注入。
- 集成（需要 DB）：`personal-research-setup.test.ts` 覆盖 18 个场景（open / partial answer / 422 invalid format / 422 rooms mismatch / 422 flight invalid / 409 version mismatch / 202 happy / 幂等 / provider disabled / Nuitee auth missing / 410 cancel / 410 expired / 403 cross-user / 409 DRAFT / 409 non-CONVERSATION / 204+204 cancel idempotent / 410 cancel-then-confirm / 422 partial fill）。
- Schema：`agent-run-response-schema` 加 `researchSetupSession: null` fixture。
- 现有回归：`personal-research-readiness-service`、`personal-research-intent-classifier`、`personal-research-intent-draft` 行为不变；新增的 setup session 列不破坏 readiness 输出。

### 10.10 验收

- 用户在已有 Solo Trip 中说「搜西门町附近酒店」后，不再只看到「去补设置」的死路；可以在对话和卡片内补齐资料，明确确认一次后立即开始真实研究。
- 缺失或不可信的 live provider 数据仍只显示 `UNAVAILABLE`，绝不返回 Demo data；Nuitee nationality authorization 缺失时 confirm 直接 `422`，**不**调用 provider。
- 取消、过期、跨用户、共享 trip、非 CONVERSATION intent run、DRAFT trip 全部 fail closed。
- LLM 追问失败永远回退到模板；setup row 不含原文 / PII / 抽取内容；audit summary 仅 `{ sessionVersion, fieldsFilled }`。
- 推荐先做这一版；不把航班、路线、活动的补全同时纳入；它们涉及更多授权与状态边界。
