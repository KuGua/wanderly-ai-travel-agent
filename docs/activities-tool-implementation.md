# Activities LLM Tool 实施方案

**状态：** 待实施
**范围：** 接入 Amadeus Self-Service Tours & Activities，并以 `activities.search` Skill 同时提供给 Shared Agent（PLAN/REPLAN 主路径）与 Personal Agent（私有 conversation 上下文）调用。
**不在范围：** 真实预订、支付、第三方活动供应商、Tours & Activities 之外的 POI/活动品类、MCP server、fixture/Demo data 产品回退、第二套 Amadeus OAuth client。
**关联事实来源：** [TECH_STACK.md](../TECH_STACK.md) · [PRD.md](PRD.md) · [backlog.md](backlog.md) · [test-scenarios.md](test-scenarios.md) · [agent-architecture.md](agent-architecture.md) · [flight-llm-tool-implementation.md](flight-llm-tool-implementation.md) · [runtime-data-policy.md](runtime-data-policy.md)

---

## 1. 实施约束（事实边界）

1. 运行时只有已配置、可验证的 provider 数据可成为活动事实；provider 无数据、超时、限流、认证失败、字段不完整或结果过期时，统一返回 `UNAVAILABLE`。不得创建替代活动 offer、plan、source evidence 或 booking reference。
2. Amadeus Test 仅用于本地与 CI 的 adapter 集成验证；Production 查询结果用于产品展示；Production 未配置或启动校验不通过时 `activities.search` 不可调用。
3. Shared `activities.search` 绑定 `SkillContext.snapshot` 与 authenticated request context；Personal `activities.search` 绑定 `PersonalActivitiesSearchContext`（owner profile + this_trip override + 当前 conversation 关联的 tripId 可选），不得伪造 snapshot。
4. Personal Agent 的查询结果仅进入当前 conversation 的服务端上下文；不直接修改 `itinerary_plans` 或 `constraint_snapshots`，不触发 STALE/replan；但允许被后续 Shared turn 引用为 conversation-derived 输入（不进入 plan 字段深比较）。
5. Flight 与 Activities 是两个完全独立的可调度模块：独立 typed port、独立 provider adapter、独立覆盖矩阵、独立 stale 触发器、独立 evidence 写入；同一 PLAN/REPLAN durable task 内作为并列子阶段，由 task scheduler 配置驱动独立启用/禁用、独立并发与失败语义；共享 Amadeus OAuth client-credentials 与请求 deadline，服务端层 per-endpoint TPS 限流隔离分配。
6. 不依赖 OpenAI 或 OpenAI Agents SDK；通过现有 `ModelGateway` 支持具备 function-calling 能力的 OpenAI-compatible LLM；每种新模型必须先完成 function-tool 兼容性 spike。
7. 不引入 Redis、Temporal、Step Functions、MCP knowledge server、向量库、embedding、自动扣款、真实预订。

---

## 2. 现有架构与目标架构

### 2.1 复用现有能力

| 现有模块 | 在本方案中的作用 |
|---|---|
| `apps/api/src/agents/{contracts,skill-registry,policy-gate,errors}.ts` | `activities:search` scope、Skill 注册、Zod 校验、timeout、AbortSignal、`SKILL_INVOKE` 审计 |
| `apps/api/src/providers/{types,llm-gateway,model-gateway,gateway-factory}.ts` | typed port、ProviderResult 二元语义、anti-corruption layer；`generateStructuredPlanWithTools` 暴露 tool loop |
| `apps/api/src/providers/live-provider-factory.ts` | 注册 `ActivitiesProvider`；未配置时返回 `UnavailableActivitiesProvider` |
| `apps/api/src/providers/amadeus-flight-provider.ts` | 复用 OAuth client-credentials 缓存、请求 deadline、限流 wrapper；Activities 端点共用 token 端点 |
| `apps/api/src/services/{flight-search-service,flight-research-matrix-service,planning-service}.ts` | 镜像为 `activities-search-service.ts` 与 `activities-research-matrix-service.ts`；不修改 flight 现有实现 |
| `apps/api/src/tasks/{task-repository,handlers/planning-task-handler,workers/agent-task-worker}.ts` | 配置驱动的并列子阶段注册；task scheduler 支持独立启用/禁用 |
| `apps/api/src/policy/{snapshot-policy,plan-output-validator}.ts` | `plan-output-validator` 扩展 `activities evidence ID` 深比较；readiness 文案可引用但受校验 |
| `apps/api/src/observability/*`、`services/audit-service.ts` | Tool/provider 生命周期 trace、低基数 metric、safe audit summary whitelist |
| `apps/api/src/db/{schema,database}` + Drizzle migrations | 扩展 `provider_search_runs` 与 `provider_offers` 列；新增 `trip_activity_search_preferences` 与 `personal_activity_search_runs`（可选） |
| `apps/api/src/location-reference/airport-reference.ts` | 不复用；活动目的地由受控的 `destinationCandidates` + `trip activity search preferences` 提供 |

### 2.2 目标调用链（Shared）

```text
Authenticated user
  → persistent PLAN / REPLAN task
  → create immutable constraint_snapshot
  → task scheduler 解析配置（flight_enabled / activities_enabled）
  → if activities_enabled:
      → activities stage (并行于 flight stage)
      → model requests activities.search (structured arguments, snapshot-bound)
      → server validates snapshot-bound arguments and coverage
      → Amadeus Tours & Activities (OAuth 复用)
      → per-endpoint TPS limiter 分配独立配额
      → normalize + Zod validate + persist provider_search_runs(category='activity_shared', requester_kind='shared')
      → model receives normalized evidence only
  → plan-output-validator (含 activities evidence 引用校验)
  → transactionally persist ACTIVE plan, offers and source evidence
  → safe SSE terminal event / GET task result
```

### 2.3 目标调用链（Personal）

```text
Authenticated owner
  → persistent personal conversation task
  → travel.conversation Skill 装载 owner profile + this_trip override + tripId?
  → model requests activities.search with PersonalActivitiesSearchContext
      ({ ownerUserId, locale, sourceDestinationIds: string[], searchPreferences })
  → server validates context (Zod parse; profile/override 已确认)
  → Amadeus Tours & Activities (同一 OAuth client)
  → persist provider_search_runs(category='activity_personal', requester_kind='personal', owner_user_id, no snapshot_id)
  → model receives normalized evidence
  → result 嵌入当前 conversation turn 回复
  → 不写 itinerary_plans / constraint_snapshots / audit(user content)
  → 写 audit(ACTIVITIES_SEARCH_PERSONAL) 仅 owner/action/timestamp
  → 后续 Shared turn 可经 conversation memory projection 引用文本（非 evidence ID）
```

---

## 3. 技术栈与关键依赖

| 领域 | 选型 | 实施要求 |
|---|---|---|
| API / Worker | Node.js LTS、TypeScript、Fastify、PostgreSQL durable task worker（现有） | 复用；不引入新服务 |
| LLM | 现有 `ModelGateway` + OpenAI-compatible function-calling | 复用 `generateStructuredPlanWithTools`；新增 `activities.search` 工具定义 |
| Activities provider | Amadeus Self-Service Tours & Activities | OAuth client-credentials 复用 flight adapter 的 token 缓存；独立 endpoint；有限 transient retry；Zod schema |
| 数据 | PostgreSQL + Drizzle + SQL migration | 扩展 `provider_search_runs`；新增活动相关表/列 |
| 安全 | Zod、Skill policy gate、snapshot policy、plan-output-validator | Tool 输入、Tool 输出、模型最终输出均需独立校验 |
| 可观测性 | OpenTelemetry、Pino、现有 metrics/audit | 低基数 provider/outcome/errorCategory 指标；关联 ID 仅 trace/log |

---

## 4. 模块改动

### 4.1 新增模块

| 路径 | 责任 |
|---|---|
| `src/providers/amadeus-activities-provider.ts` | 调用 Amadeus Tours & Activities；token 复用；处理 deadline/429/5xx；归一化返回 |
| `src/providers/amadeus-activities-schemas.ts` | Amadeus 请求/响应最小 Zod schema；未验证 raw payload 不入模型 |
| `src/skills/shared/activities-search-skill.ts` | `activities.search`（Shared）输入/输出 schema、scope、timeout、handler |
| `src/skills/personal/activities-search-skill.ts` | `activities.search`（Personal）输入/输出 schema、scope、timeout、handler |
| `src/skills/shared/activities-search.md` | Skill 文档（与 `flight-search.md` 同构） |
| `src/skills/personal/activities-search.md` | Personal Skill 文档 |
| `src/services/activities-search-service.ts` | snapshot-bound 校验（Shared）/ Personal context 校验、目的地 allow-list、覆盖写入、`UNAVAILABLE` 映射 |
| `src/services/activities-research-matrix-service.ts` | 与 `flight-research-matrix-service.ts` 同构，独立 category |
| `src/services/activities-search-preferences-service.ts` | 用户确认的活动搜索偏好；版本化；变更触发 STALE |
| `src/providers/per-endpoint-rate-limiter.ts` | 共享 OAuth 但 endpoint 维度 TPS 隔离；in-process token bucket；可注入 |
| `migrations/0021_activity_search_foundation.sql` | `trip_activity_search_preferences` + `provider_search_runs` `category`/`requester_kind`/`owner_user_id` 列 + `provider_offers` 扩展 |
| `migrations/0022_activities_research_matrix.sql` | activities research matrix 表（如需独立）或复用 flight 表新增 category 列 |

### 4.2 修改模块

| 路径 | 改动 |
|---|---|
| `providers/types.ts` | 新增 `ActivitiesProvider.searchActivities()` 与 `ActivityEvidence`；保持 `ProviderResult<T>` 不变；新增 `ActivityUnavailableCode`（复用 8 码 `FlightUnavailableCode`） |
| `agents/contracts.ts` | 新增 `activities:search` scope；新增 `PersonalActivitiesSearchContext` 接口；`SkillContext.flightSearch` 旁加 `activitiesSearch`（Shared） |
| `agents/policy-gate.ts` | `personal` 默认白名单追加 `activities:search`（保留 `bookings`/`plan:write:propose` 黑名单）；`shared` 默认白名单追加 `activities:search` |
| `agents/skill-registry.ts` | 不修改核心逻辑；新增测试覆盖 Personal 注册 + 越权拒绝 |
| `agents/personal-travel-agent.ts` | 注册 Personal `activities.search` |
| `agents/shared-trip-agent.ts` | 注册 Shared `activities.search` |
| `providers/live-provider-factory.ts` | 注册 `activitiesProvider`；未配置时返回 `UnavailableActivitiesProvider` |
| `providers/model-gateway.ts` | `generateStructuredPlanWithTools.tools` 包含 `activities.search` 定义；dispatcher 通过 registry 派发 |
| `tasks/handlers/planning-task-handler.ts` | 引入 task scheduler 配置项 `PLAN_ENABLE_ACTIVITIES`；activities 作为独立子阶段；flight × activities 并列可调度 |
| `policy/plan-output-validator.ts` | 扩展校验集合：readiness 文案引用 `activities evidence ID` 受 `isDeepStrictEqual`；拒绝引用 `requester_kind='personal'` 的 run |
| `observability/metrics.ts` | 新增 `activities_tool_invocations_total`、`activities_provider_requests_total`、`activities_provider_latency_ms`、`activities_offer_staleness_total` |
| `services/audit-service.ts` | 新增 action `ACTIVITIES_SEARCH_REQUESTED`（Shared）、`ACTIVITIES_SEARCH_PERSONAL`（Personal，仅 owner/action/timestamp） |
| `routes/planning.ts`、`routes/agent-runs.ts` | 不变；新增 `POST /api/v1/trips/:tripId/activity-search-preferences`（保存用户确认的活动搜索偏好） |
| `apps/api/.env.example` | 新增 `AMADEUS_ACTIVITIES_TIMEOUT_MS`、`PLAN_ENABLE_ACTIVITIES=true`、`ACTIVITIES_PER_ENDPOINT_TPS=2` |
| `docs/PRD.md`、`docs/backlog.md`、`docs/test-scenarios.md`、`docs/runtime-data-policy.md`、`TECH_STACK.md`、`docs/agent-architecture.md` | 已在本变更中更新 |

### 4.3 不修改模块

- `apps/api/src/agents/{contracts skill-registry errors}.ts` 的核心 schema/timeout/audit 框架；只扩字段与 scope。
- 现有 flight path：`flight-search-service.ts` / `flight-research-matrix-service.ts` / `flight-search-skill.ts` / `flight-search-preferences-service.ts` 不改实现。
- 现有 Personal 5 Skills 不改实现；仅在 `personal-travel-agent.ts` 中追加注册。
- 现有 readiness Skill 实现保持不变；扩展点仅在 `plan-output-validator` 接受其引用 activities evidence ID。

---

## 5. Tool、LLM 与接口契约

### 5.1 `activities.search` Tool（Shared）

```ts
type ActivitiesSearchInput = {
  snapshotId: string;
  destinationId: string;     // 必须属于 snapshot.destinationCandidates
  category?: string;         // 可选过滤；不传则返回受控全分类
  locale: "en" | "zh";
};

type ActivitiesSearchOutput =
  | { outcome: "LIVE"; queryId: string; activities: ActivityEvidence[] }
  | { outcome: "UNAVAILABLE"; code: ActivityUnavailableCode };
```

`ActivityUnavailableCode` 复用现有 8 码：`NOT_CONFIGURED` / `SEARCH_CONSTRAINTS_INCOMPLETE` / `NO_RESULTS` / `RATE_LIMITED` / `UPSTREAM_TIMEOUT` / `UPSTREAM_FAILURE` / `INVALID_PROVIDER_RESPONSE` / `PROVIDER_NOT_APPROVED`。不新增 `AUTH_FAILED`（OAuth 过期归 `UPSTREAM_FAILURE` 并触发现有 token 刷新）。

### 5.2 `activities.search` Tool（Personal）

```ts
type PersonalActivitiesSearchInput = {
  ownerUserId: string;       // 来自 authenticated context，不接受客户端传入
  tripId?: string;           // 可选；不传则只用 owner profile
  destinationIds: string[];  // 受控子集，来自用户当前已确认的 candidate 列表
  category?: string;
  locale: "en" | "zh";
};
type PersonalActivitiesSearchOutput = ActivitiesSearchOutput;
```

Personal 调用**不**含 `snapshotId`；不写 `itinerary_plans`；不触发 STALE；`requester_kind='personal'` 行可被后续 Shared turn 引用为 conversation-derived 输入（不参与 plan 字段深比较）。

### 5.3 Skill 注册与 scope

```ts
// skills/shared/activities-search-skill.ts
export const activitiesSearchSkill = createActivitiesSearchSkill(provider);
// allowedTools: ["snapshot:read", "activities:search"], timeoutMs: 12_000, agent: "shared"

// skills/personal/activities-search-skill.ts
export const personalActivitiesSearchSkill = createPersonalActivitiesSearchSkill(provider);
// allowedTools: ["profile:read", "activities:search"], timeoutMs: 12_000, agent: "personal"
```

Personal 注册期黑名单 `bookings`/`plan:write:propose` 不变；新增 `activities:search` 通过 `requireScope`。

### 5.4 完整性与参数门禁

服务端在 Tool handler 内强制：

1. Shared：`snapshotId` 必须是当前 task 的 immutable snapshot；`destinationId` 必须属于 `snapshot.destinationCandidates`；`locale` 必须为 `en|zh`；不接受模型自行决定的日期范围或货币（活动通常按 destination 与 locale 寻址）。
2. Personal：`ownerUserId` 来自 authenticated context；`destinationIds` 必须属于 owner 当前已确认的 candidate 列表；profile/override 已确认；不接受 `snapshotId`。
3. Provider 返回的文本、分类、价格、tagline 等都是数据，不是模型指令。
4. 初始模型回合可选择并调用 Tool；最终 plan-generation 回合前检查 research matrix。任何必需 `destination × category`（如启用类别筛选）未成功时失败为 `UNAVAILABLE`。

### 5.5 API 变化

| HTTP API | 变化 |
|---|---|
| `POST /api/v1/trips/:tripId/activity-search-preferences` | **新增**。保存经用户确认的活动搜索偏好；版本化；变更使依赖旧 snapshot 的 plan/confirmation `STALE` |
| `POST /api/v1/planning/generate` | 不变；服务端通过 `PLAN_ENABLE_ACTIVITIES` 与配置决定是否启用 activities 子阶段 |
| `GET /api/v1/agent-runs/:runId` | 返回 run 状态、最终 plan ID、稳定错误码；不返回 raw Tool payload |
| `GET /api/v1/agent-runs/:runId/events` | planning 仅发布安全 phase 与 terminal event；不得流式发送 Tool 参数、raw provider response、模型推理或未持久化 offer |

---

## 6. 数据模型与状态

### 6.1 新增或扩展的数据

| 实体 | 关键字段 | 约束 |
|---|---|---|
| `trip_activity_search_preferences` | `trip_id`、`version`、`category_filter`、`locale`、`confirmed_by` | 仅保存用户确认的值；每次变更递增版本并使 plan stale |
| `provider_search_runs` 扩展 | `category` (`flight`/`activity`/`stay`/`ground`/`visa`)、`requester_kind` (`shared`/`personal`)、`owner_user_id` (Personal 时非空)、`trip_id` (Shared 时非空)、`agent_task_run_id` | 不保存 raw provider request/response、凭据、敏感 profile 字段 |
| `provider_offers` 扩展 | `search_run_id` (FK)、`provider_offer_id`、`currency`、`expires_at`、`category='activity'`、`requester_kind`、`owner_user_id` | 仅 `LIVE` 且 schema-valid offer 可写入；`requester_kind='personal'` 的 offer 不进入 plan |
| `itinerary_plans` / `plan_data` 扩展 | 引用 selected activity offer 的 expiry 和 search run | 任一活动 offer 过期即不可确认 |

### 6.2 不可写清单

Personal `activities.search` 调用**绝不**写入以下表：

- `itinerary_plans` / `itinerary_plan_data`
- `constraint_snapshots` / `constraint_snapshot_data`
- `trip_activity_search_preferences`（仅 Shared path 写入）
- `member_confirmations`
- `booking_executions`
- `audit_events` 中除 `ACTIVITIES_SEARCH_PERSONAL` 之外的 action
- 私聊正文、profile 字段、override 字段

### 6.3 状态规则

```text
Shared path:
  ActivitiesSearchPreferencesProposal
    → user confirms → trip_activity_search_preferences(version n)
    → constraint_snapshot(version n)
    → provider_search_run(category='activity_shared', requester_kind='shared', outcome=LIVE|UNAVAILABLE)
    → validated itinerary_plan(ACTIVE)
    → activity offer expiry / preference edit / consent revocation
    → itinerary_plan(STALE), confirmations(STALE)

Personal path:
  PersonalActivitiesSearchContext
    → provider_search_run(category='activity_personal', requester_kind='personal', outcome=LIVE|UNAVAILABLE)
    → result 嵌入当前 conversation turn 回复
    → 不写 plan / snapshot / preference table
    → 后续 Shared turn 可经 conversation memory projection 引用文本
```

---

## 7. 配置与启动校验

新增或修改环境变量（同步更新 `apps/api/.env.example`）：

```dotenv
# Amadeus Self-Service Tours & Activities. 共用 OAuth client.
AMADEUS_ACTIVITIES_ENABLED=false
AMADEUS_ACTIVITIES_TIMEOUT_MS=8000
ACTIVITIES_PER_ENDPOINT_TPS=2
ACTIVITIES_PER_ENDPOINT_BURST=4

# Planning task scheduler
PLAN_ENABLE_ACTIVITIES=true
PLAN_ACTIVITIES_STAGE_CONCURRENCY=1

# 仅目标 LLM 通过 function-tool 兼容性 spike 后启用
MODEL_GATEWAY_TOOL_CALLING_ENABLED=false
MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS=8
```

启动规则：

- `AMADEUS_ACTIVITIES_ENABLED=true` 时必须有 Amadeus client ID/secret 与合理 timeout；否则启动失败。
- `ACTIVITIES_PER_ENDPOINT_TPS` 与 `ACTIVITIES_PER_ENDPOINT_BURST` 必须在 `ACTIVITIES_PER_ENDPOINT_TPS >= 1` 且 `BURST >= TPS` 范围内；否则启动失败。
- `PLAN_ENABLE_ACTIVITIES=false` 时 activities 子阶段不进入 task scheduler；planning 行为等价于 v0；`activities.search` Skill 仍可被注册但 plan 主路径不调用。
- Tool-calling 开关仅在目标 LLM 通过兼容性 spike 后启用；未启用时 planning 保持 server-orchestrated research + model explanation。

---

## 8. 可观测性与审计

### Metrics（label 白名单）

- `activities_tool_invocations_total{outcome,provider,error_category,requester_kind}`
- `activities_provider_requests_total{outcome,provider,error_category}`
- `activities_provider_latency_ms{provider,outcome}`
- `activities_offer_staleness_total{reason}`
- `activities_research_coverage_total{outcome}`
- `activities_personal_invocations_total{outcome}`（独立 counter，避免与 shared 路径混算）

标签仅限固定 allow-list；不得把 `tripId` / `snapshotId` / `runId` / `ownerUserId` / `placeId` / `destinationId` / 自由文本作为 metric label。

### Audit / traces / logs

- Shared：记录 `ACTIVITIES_SEARCH_REQUESTED` / `ACTIVITIES_SEARCH_COMPLETED` / `ACTIVITIES_SEARCH_UNAVAILABLE` / `ACTIVITIES_OFFER_EXPIRED`；含 tripId、agentTaskRunId、provider、稳定结果码、耗时。
- Personal：记录 `ACTIVITIES_SEARCH_PERSONAL`；summary 仅 `ownerUserId`、`action`、`timestamp`；不含 destinationId、conversationId、prompt、模型 reasoning、护照/国籍。
- 关联 ID 仅 trace/log；`requester_kind` 是允许的 label。
- trace 覆盖 API → durable task → Tool → provider → evidence persistence → validation。

### Forbidden keys

`FORBIDDEN_SPAN_ATTRIBUTE_KEYS` 不变；新增 activities 相关 span 时严格遵循；不增加 `destinationName`/`category`/`activityName`/`price`/`freeText`。

---

## 9. 实施阶段与依赖

| 阶段 | 交付物 | 前置 | 完成条件（必须可验证） |
|---|---|---|---|
| **0. 文档与契约** | 本文档；PRD/backlog/test/runtime policy/TECH_STACK/agent-architecture 对齐 | 无 | 不存在 fixture/Demo fallback 的运行时承诺 |
| **1. 数据与配置** | migration、SearchPreferences API、`.env.example`、`provider_search_runs` 列扩展 | 0 | 用户确认的搜索约束版本化可触发 stale；migration 双向回滚脚本 |
| **2. Provider adapter** | `AmadeusActivitiesProvider`、Zod schema、token 复用、per-endpoint 限流、不可用码映射、spike report | 1 | Test 集成过；Production 未配置 fail closed；限流隔离独立 |
| **3. Shared Activities Tool** | `activities.search` Shared Skill、scope、policy、evidence service、audit、metrics | 2 | 仅 Shared Agent 能调；越权/失败路径受控 |
| **4. Personal Activities Tool** | `activities.search` Personal Skill、Personal context、scope、audit、metrics | 2 | 仅 Personal Agent 能调；不写 snapshot/plan/preference；audit 仅 owner/action/timestamp |
| **5. Task scheduler 与覆盖矩阵** | planning-task-handler 配置驱动并列子阶段；activities-research-matrix-service；plan-output-validator 扩展 readiness evidence 校验 | 3, 4 | `PLAN_ENABLE_ACTIVITIES` 切换不破坏 flight 路径；任一阶段独立失败有明确语义 |
| **6. LLM function-calling** | ModelGateway tool loop + Amadeus provider 兼容性 spike + feature flag | 5 | LLM 可请求 Tool；服务端仍强制授权与覆盖 |
| **7. Staleness / E2E** | expiry recheck、replan、前端 unavailable UX、完整 E2E、文档验收 | 6 | 过期 offer 或 provider 失败不能进入确认/booking |

阶段 2、3、4 的 test-only contract testing 可并行；阶段 5 必须在阶段 3、4 后开始；任何阶段发现 provider 条款或事实边界不满足，保持 `UNAVAILABLE`，不得以伪造或静态价格绕过。

---

## 10. 关键技术决策与边界条件

1. **Flight 与 Activities 共享 OAuth、独立 endpoint 限流**：复用同一 token 缓存，但 `per-endpoint-rate-limiter` 强制独立 bucket，避免活动流量挤占 flight 配额。429 触发 `RATE_LIMITED` 并仅计入 activities 维度。
2. **Personal 调用禁止伪造 snapshot**：`PersonalActivitiesSearchContext` 是新的轻量上下文；不允许把 owner profile 包装成 snapshot 走 Shared 路径，避免污染事实边界。
3. **Personal 调用不写 plan / preference table**：仅写 `provider_search_runs`（`requester_kind='personal'`）与 `audit_events`（`ACTIVITIES_SEARCH_PERSONAL`，owner/action/timestamp）；`plan-output-validator` 拒绝引用 personal run。
4. **Personal 调用可被 Shared turn 引用为文本**：conversation memory projection 可携带 Personal turn 的服务端构造内容（不含 raw provider payload）；Shared plan 字段不直接 deep-equal personal run row。
5. **Flight × Activities 独立调度**：在 `planning-task-handler.ts` 引入 task scheduler；activities 子阶段可独立启用/禁用；任一阶段独立失败有明确语义（plan 缺 services 不等于 plan 失败，仅该 cell `UNAVAILABLE`）。
6. **Readiness 引用 activities evidence**：`plan-output-validator` 扩展接受 `activities evidence ID` 引用，但必须满足同 run、`isDeepStrictEqual`、`requester_kind='shared'`、`expires_at > NOW()`；personal run 永远不通过。
7. **不引入新的不可用码**：OAuth 过期归 `UPSTREAM_FAILURE`（触发现有 token 刷新）；`AUTH_FAILED` 暂不新增。
8. **TPS 限流实现**：in-process token bucket；不依赖 Redis；Worker 进程与 API 进程各自持有独立 bucket；后续如需跨实例共享再评估迁移。
9. **Audit whitelist**：Personal 调用 audit summary 仅 `ownerUserId` + `action` + `timestamp`；不携带 destination/category/locale/conversation；与 FR-7 §4 一致。
10. **Forbidden attribute keys**：activities 新增 span 不允许携带 `destinationName`/`activityName`/`category`/`price` 等高基数或敏感字段；与 `FORBIDDEN_SPAN_ATTRIBUTE_KEYS` 静态测试保持一致。

---

## 11. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| vendor 配额与 flight 共享，活动流量挤占 flight | per-endpoint 限流独立 bucket；429 单独计入 activities；监控 `activities_provider_requests_total{outcome=rate_limited}` |
| Personal 调用结果被误用为 plan 事实 | `plan-output-validator` 拒绝引用 `requester_kind='personal'`；Shared 文案仅引用 conversation memory projection，不引用 personal run ID |
| Task scheduler 误把 activities 失败传染给 plan | 任一子阶段独立计入 matrix；plan 在 matrix 不完整时 fail closed，但 report 明确指出哪个 category 缺失 |
| OAuth token 过期触发大量 `AUTH_FAILED` | 归 `UPSTREAM_FAILURE` 触发现有刷新；spike 报告覆盖 token 过期路径 |
| Readiness 文案引用过期 evidence | `plan-output-validator` 强校验 `expires_at > NOW()`；过期触发 STALE |
| `requester_kind` 列被未来代码忽略 | 新增静态测试 `tests/provider-search-runs-requester-kind.test.ts`：扫描所有 SELECT，禁止出现不带 `requester_kind` 过滤的 Shared 路径读取 |
| Activities schema 膨胀撑大 evidence 表 | 输出 Zod schema 严格限制字段集合；vendor 字段白名单在 `amadeus-activities-schemas.ts` 集中维护 |
| LLM function-calling 兼容性未通过 | feature flag 默认关闭；未启用时 activities 走 server-orchestrated research + model explanation（与 flight 现状一致） |

---

## 12. 测试与验收

必须新增或更新（覆盖 `TS-ACTIVITIES-TOOL-1/2/3`，并补全 flight × activities 独立调度相关测试）：

1. **Amadeus adapter contract tests**：OAuth 复用、有效归一化、无结果、429、5xx、超时、畸形 payload、取消。
2. **Tool policy tests**：Personal/Shared Agent 调用被对方拒绝；scope 黑名单仍生效；越权 destination/locale/owner 被拒。
3. **Coverage tests**：Shared 路径每个 `destinationId × (category?)` 全部成功才可生成 plan；任一 `UNAVAILABLE` 时不产生 plan/offer/evidence；关闭 activities 子阶段时 plan 仅缺 services 但 flight 路径可正常 finalize。
4. **Independent scheduling tests**：`PLAN_ENABLE_ACTIVITIES=false` 时 activities 子阶段不调度；flight 路径无回归。`PLAN_ENABLE_ACTIVITIES=true` 时 activities 失败不阻断 flight；反之亦然。
5. **Evidence tests**：模型伪造 activity、改价、改币种、改 expiry、引用旧 search run、引用 personal run、引用跨 run evidence 都被 validator 拒绝。
6. **Stale tests**：activities offer 过期、preference 更新、授权撤回均使 plan/confirmation stale；确认前 expiry recheck 阻止 sandbox。
7. **Audit tests**：Personal audit summary 仅 owner/action/timestamp；禁止携带 destination/category/locale/conversation；Forbidden attribute keys 静态扫描通过。
8. **TPS tests**：429 仅计入 activities bucket；flight 配额未受影响；burst 与稳态行为符合配置。
9. **Compatibility tests**：每个目标 OpenAI-compatible provider 的 function-call、tool ID、多轮、abort、超时、错误 envelope。
10. **Security/observability tests**：日志、audit、metric、SSE payload 均不含 raw provider payload、密钥、私人聊天、Personal run 引用或未授权数据。

---

## 13. 回滚与不变量

- **回滚**：删除 `PLAN_ENABLE_ACTIVITIES` 开关即可禁用 activities 子阶段；`activities.search` Skill 仍可注册但 plan 主路径不再调用；migration 双向脚本保留；不影响 flight 路径与 Personal Agent 现有行为。
- **不变量**：
  - flight 与 activities 互相不读取对方的 `provider_search_runs` 行；
  - Personal run 行不被任何 Shared 路径读取；
  - `plan-output-validator` 不接受 personal run evidence；
  - readiness 引用必须通过 `isDeepStrictEqual` 与 `requester_kind='shared'` 双重闸门。
