# Flight LLM Tool 实施方案

**状态：** Shared durable planning、`flight.search` 和最小 Web task/plan surface 已实施；FlightAPI 与 SerpAPI live contract 仍需完成受控 E2E 验证。
**范围：** 通过 provider abstraction 接入 Amadeus Self-Service Flight Offers Search、FlightAPI.io Flight Price API 或 SerpAPI Google Flights，并以受限的 `flight.search` Tool 提供给配置的 OpenAI-compatible LLM 调用。
**不在范围：** 真实订票、支付、机票锁价、外部通用 MCP server、多供应商路由、fixture/Demo data 产品回退。

## 1. 实施约束

1. 运行时只有已配置、可验证的 provider 数据可成为报价事实；provider 无数据、超时、限流、认证失败、字段不完整或结果过期时，统一返回 `UNAVAILABLE`。不得创建替代 offer、plan、source evidence 或 booking reference。
2. Amadeus Test 仅用于本地和 CI 的 adapter 集成验证；它的有限数据不得作为产品运行路径的实时结果。FlightAPI.io 与 SerpAPI Google Flights 都是可显式选择的 local/prototype live provider，使用真实 credits；自动化测试必须 mock HTTP。产品环境只在被 `FLIGHT_PROVIDER` 显式选择、其凭据已配置且启动校验通过的 provider 上启用机票查询。
3. LLM 可以请求 `flight.search`，但不拥有 HTTP、数据库、密钥、授权或持久化权限。模型面对的 function 参数仅为受控 `originId` 和 `destinationId`；服务端从不可变 snapshot 和已确认 preference version 绑定日期、往返类型、乘客、舱等、币种与 snapshot ID，再以完整 Skill 契约校验、调用 provider、归一化和持久化。这样模型不能覆盖规划约束。
4. 模型从当前会话中提炼的航班偏好只产生 `SearchPreferencesProposal`；用户必须确认或编辑后，才可以写入 trip override 并进入新的 `constraint_snapshot`。
5. 不依赖 OpenAI 或 OpenAI Agents SDK。通过现有 `ModelGateway` 支持具备 function-calling 能力的 OpenAI-compatible LLM；每种新模型必须先完成兼容性验证。

## 2. 现有架构与目标架构

### 2.1 复用的现有能力

| 现有模块 | 当前责任 | 在本方案中的作用 |
|---|---|---|
| `apps/api/src/providers/types.ts` | `FlightProvider` typed port 和 `ProviderResult` | 扩展 Flight 搜索参数、结果和不可用原因的唯一 provider 契约。 |
| `apps/api/src/providers/live-provider-factory.ts` | 构建 production provider | 按配置构建 Amadeus adapter；未配置时保持 `UNAVAILABLE`。 |
| `apps/api/src/agents/contracts.ts`、`skill-registry.ts`、`policy-gate.ts` | Skill 输入输出、scope、timeout、审计 | 承载 `flight.search` 的 server-side Tool 许可与 Zod 契约。 |
| `apps/api/src/providers/model-gateway.ts`、`llm-gateway.ts`、`gateway-factory.ts` | 模型 anti-corruption layer | 新增受限 Tool-call loop，保持 OpenAI-compatible provider 可替换。 |
| `apps/api/src/services/planning-service.ts`、`policy/plan-output-validator.ts` | snapshot、evidence、plan 校验和事务写入 | 只接收已规范化且已持久化的 flight evidence；继续以精确对象匹配拦截模型伪造。 |
| `apps/api/src/tasks/*`、`workers/agent-task-worker.ts` | durable task、租约、取消、SSE、trace continuity | 承载 PLAN/REPLAN 的研究与 Tool 执行，替换当前同步 planning route 的长调用。 |
| `apps/api/src/observability/*`、`services/audit-service.ts` | traces、metrics、结构化日志和 audit | 记录安全的 Tool/provider 生命周期，不记录 prompt、原始 provider payload 或敏感字段。 |

### 2.2 目标调用链

```text
Authenticated user
  → durable task (RESEARCH, PROPOSE_PLAN output mode; the legacy PLAN/REPLAN
    label is preserved on the public POST /planning/generate response for
    backward compatibility — see §5.3)
  → create immutable constraint_snapshot
  → model requests flight.search (structured arguments)
  → server validates snapshot-bound arguments and coverage
  → selected FlightProvider (Amadeus / FlightAPI / SerpAPI)
  → normalize + validate + persist provider query/evidence
  → model receives normalized evidence only
  → deterministic plan output validation
  → transactionally persist PROPOSED plan, offers and source evidence
  → member adoption (solo accept-solo, or team unanimous adoption-votes)
    revalidates offer freshness and transitions PROPOSED → ACTIVE
  → safe SSE terminal event / GET task result
```

模型调用 Tool 不等于模型拥有自由搜索权限。LLM 必须真实请求已注册的 `flight.search`，不能由服务端预取数据后伪造 Tool 调用。对于一次候选比较，服务端必须在**最终方案生成**前确保每个 `destinationCandidate × departureCity` 的 Flight 查询均已获得成功 evidence；任一必需查询为 `UNAVAILABLE` 时，该轮 planning 失败关闭，不生成部分 PROPOSED plan。

生成的 plan 并不会直接进入 `ACTIVE`：`generatePlan` 默认写入 `PROPOSED`，必须经由成员采纳（单人 trip 走 `POST /plans/:planId/accept-solo`，多人 trip 走全员一致的 `POST /plans/:planId/adoption-votes`）才会转为 `ACTIVE`。采纳本身不重新校验 Flight offer 新鲜度；随后的确认（`POST /confirmations`，仅 `CONFIRMED` 决定触发）与 booking sandbox 执行才会各自独立、原子地重新校验所选 Flight offer 的新鲜度（§6.2）。

## 3. 技术栈与关键依赖

| 领域 | 选型 | 实施要求 |
|---|---|---|
| API / Worker | Node.js LTS、TypeScript、Fastify、PostgreSQL durable task worker | 使用现有 API/Worker 双入口；不引入新服务、Redis、Temporal 或 Step Functions。 |
| LLM | 当前 `ModelGateway` + OpenAI-compatible Chat Completions/function-calling 协议 | 加入 provider capability probe；禁止把某一厂商 SDK 作为业务控制平面。 |
| Flight provider | Amadeus Self-Service、FlightAPI.io 或 SerpAPI Google Flights | 由 `FLIGHT_PROVIDER` 显式选择；请求 deadline、严格请求/响应 schema validation、失败关闭。FlightAPI Key 位于 URL path；SerpAPI Key 位于 query parameter；两者的完整 URL 都不得进入 logs、trace、error、持久化或 Tool 输出。FlightAPI 与 Google Flights 的航班时间可为无 offset 的机场当地 wall-clock 值；系统保留其当地时间语义，不得擅自补成 UTC。 |
| 数据 | PostgreSQL + Drizzle + SQL migration | snapshot、query evidence、offer、plan 与 audit 均可关联。 |
| 安全 | Zod、Skill policy gate、snapshot policy、plan output validator | Tool 输入、Tool 输出、模型最终输出均需独立校验。 |
| 可观测性 | OpenTelemetry、Pino、现有 metrics/audit | 低基数 provider/outcome/errorCategory 指标；关联 ID 仅 trace/log。 |

## 4. 模块改动

### 4.1 新增模块

| 路径 | 责任 |
|---|---|
| `src/providers/amadeus-flight-provider.ts` | 取得 OAuth token、调用 Flight Offers Search、处理 deadline/429/5xx、归一化 provider 返回；`expiresAt` 优先取真实的 `lastTicketingDate`，缺失时回退为 `capturedAt+15min` 的本地启发式。 |
| `src/providers/amadeus-flight-schemas.ts` | Amadeus 外部请求/响应的最小 Zod schema；不得把未验证 raw payload 传入模型。 |
| `src/providers/flightapi-flight-provider.ts` | FlightAPI.io Flight Price API adapter；与 SerpAPI 同为可显式选择的 local/prototype live provider，`expiresAt` 始终是 `capturedAt+15min` 的本地启发式（该供应商不提供任何票价保留/开票截止日期字段）。 |
| `src/providers/serpapi-flight-provider.ts`、`serpapi-flight-schemas.ts` | SerpAPI Google Flights adapter；`expiresAt` 同样始终是 `capturedAt+15min` 的本地启发式，Google Flights 结果本身没有票价保留概念。 |
| `src/skills/shared/flight-search-skill.ts` | `flight.search` 的输入/输出 schema、scope、timeout、handler。 |
| `src/services/flight-search-service.ts` | snapshot 参数解析、机场/IATA allow-list、搜索覆盖、evidence 写入与 `UNAVAILABLE` 映射。 |
| `src/services/flight-offer-freshness-service.ts` | `validateSelectedFlightOffersFresh` — 确认（仅 `CONFIRMED` 决定）与 booking sandbox 执行前，对计划已选中的 Flight offer 重新校验新鲜度（§6.2）；不在采纳（`activateProposedPlan`）时调用。判定依据是持久化的 `expiry_provenance`（`PROVIDER_VERIFIED`/`SYNTHETIC`/`NULL`），非 `PROVIDER_VERIFIED` 一律按 `UNVERIFIABLE_EXPIRY` fail closed，从不从 `provider_name` 推断。 |
| `src/providers/llm-gateway.ts` | 已实现为并入方案：`generateStructuredPlanWithTools` 承载 OpenAI-compatible 多轮 function-tool loop 与 provider capability 校验，未拆分为独立的 `tool-calling-gateway.ts`。 |
| `src/location-reference/airport-reference.ts` | 版本化、受控的城市/IATA 映射；不得复用非权威地图坐标解析器作为机票事实来源。 |
| `migrations/*_flight_search_evidence.sql` | 新增 query-evidence、offer expiry 和 snapshot/plan 关联字段。 |

### 4.2 修改模块

| 路径 | 改动 |
|---|---|
| `providers/types.ts` | 将 `FlightProvider.searchFlights()` 输入升级为 IATA、行程类型、日期、旅客数、舱等、币种和 `snapshotId`；`ProviderResult` 明确仅 `LIVE | UNAVAILABLE`。 |
| `types/domain.ts` | 扩展 `FlightOffer`：总价/币种、segments、总时长、cabin、旅客数、退改/行李摘要、`offerExpiresAt`、provider offer ID；另新增 `expiryProvenance: "PROVIDER_VERIFIED" \| "SYNTHETIC"` 字段，由三个 Flight provider adapter 各自显式填写，`provider_offers.expiry_provenance`（迁移 `0043`）持久化该值。 |
| `agents/contracts.ts`、`policy-gate.ts` | 新增 `flight:search` scope，仅加入 shared Agent allow-list。 |
| `agents/shared-trip-agent.ts` | 注册 `flight.search`，但不赋予 Personal/Review Agent。 |
| `providers/live-provider-factory.ts` | 根据完整 Amadeus 配置返回 adapter；否则返回 unavailable provider。 |
| `providers/model-gateway.ts` | 新增执行受限 Tool-call turn 的应用接口；不可暴露任意 Tool 名、URL 或 credentials。 |
| `services/planning-service.ts`、planning task handler | 将 Flight research 置入 PLAN/REPLAN durable task；在调用模型前持久化成功 evidence。 |
| `policy/plan-output-validator.ts` | 校验扩展 offer 字段、currency、expiry 与本轮 evidence 的精确匹配。 |
| `routes/planning.ts`、`routes/agent-runs.ts` | planning 命令创建 `202` durable task；客户端从 run 状态和 SSE 安全阶段读取结果。 |
| `observability/metrics.ts`、`services/audit-service.ts` | 加入 Tool/provider outcome 的 allow-list 指标和安全审计 action。 |

## 5. Tool、LLM 与接口契约

### 5.1 `flight.search` Tool

Tool 只由 `ModelGateway` 提供给 Shared PLAN/REPLAN turn。Personal Agent 私有聊天不得获得实时航班查询能力；文中“chat 的航班请求”仅指经授权的 Shared trip planning/replanning 体验。请求执行时必须绑定 `SkillContext.snapshot` 和 authenticated request context。

```ts
type FlightSearchInput = {
  snapshotId: string;
  originId: string;          // 受控 airport/city reference ID，不接受自由文本
  destinationId: string;     // 必须属于 snapshot.destinationCandidates
  tripType: "ONE_WAY" | "ROUND_TRIP";
  departureDate: "YYYY-MM-DD";
  returnDate?: "YYYY-MM-DD";
  adults: number;            // 1..9
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  currency: string;          // ISO 4217 allow-list
};

type FlightSearchOutput =
  | { outcome: "LIVE"; queryId: string; offers: NormalizedFlightOffer[] }
  | { outcome: "UNAVAILABLE"; code: FlightUnavailableCode };
```

`FlightUnavailableCode` 初始 allow-list：`NOT_CONFIGURED`、`SEARCH_CONSTRAINTS_INCOMPLETE`、`NO_RESULTS`、`RATE_LIMITED`、`UPSTREAM_TIMEOUT`、`UPSTREAM_FAILURE`、`INVALID_PROVIDER_RESPONSE`、`PROVIDER_NOT_APPROVED`。

### 5.2 完整性与参数门禁

服务端必须在 Tool handler 内验证，而非依赖模型 prompt：

1. `snapshotId` 必须是当前 task 的 immutable snapshot。
2. origin/destination 必须映射到受控 IATA reference，且 destination 位于 snapshot 候选集。
3. 日期必须匹配用户确认后进入 snapshot 的行程日期；往返必须具备有效 `returnDate`。
4. adults、cabin、currency 必须来自用户确认的 `SearchPreferences`，不是 LLM 从自然语言推断的未确认值。
5. 初始模型回合可选择并调用 Tool；在最终 plan-generation 模型回合前检查 research matrix。任何必需 `origin × candidate` 未成功时失败为 `UNAVAILABLE`。
6. Provider 返回的文本、航司名称、fare rules 等均是数据，不是模型指令。

### 5.3 API 变化

| HTTP API | 变化 |
|---|---|
| `POST /api/v1/planning/generate` | 实际创建的是 `operation=RESEARCH`、`outputMode=PROPOSE_PLAN` 的 Personal Trip Orchestrator durable task（`acceptResearchTask`），响应体的 `operation` 字段被重写为 `"PLAN"` 以维持外部契约向后兼容；仍返回 `202 { runId, status: "QUEUED" }`，不在 HTTP request 内完成 provider/LLM 调用。 |
| `POST /api/v1/change-events` | 生成 `REPLAN` task；沿用 stale-first 语义。 |
| `POST /api/v1/plans/:planId/accept-solo`（新增） | 单人（SOLO）trip 的采纳：校验调用者是唯一必需成员、plan 为 `PROPOSED`，原子地转为 `ACTIVE`。不重新校验 Flight offer 新鲜度（该校验在确认/booking 时进行，见 §6.2）。 |
| `POST /api/v1/plans/:planId/adoption-votes`（新增） | 多人（TEAM）trip 的采纳投票：任一必需成员 `NEEDS_CHANGES` 即阻塞；全员一致 `ACCEPT` 时在同一事务内转为 `ACTIVE`。不重新校验 Flight offer 新鲜度（该校验在确认/booking 时进行，见 §6.2）。 |
| `GET /api/v1/agent-runs/:runId` | 返回 planning run 的状态、最终 plan ID 或稳定错误码；不返回原始 Tool payload。 |
| `GET /api/v1/planning/:tripId/run/latest` | 仅能恢复 `operation IN (PLAN, REPLAN)` 的 durable 状态；由于 `/planning/generate` 现在创建的是 `RESEARCH` 任务，此便捷端点当前无法用它恢复最近一次通过 `/planning/generate` 发起的运行 —— 客户端应改用创建响应中拿到的 `runId` 调用 `GET /api/v1/agent-runs/:runId`。 |
| `GET /api/v1/planning/:tripId/latest` | 仅返回已经 `ACTIVE`（即已完成采纳）的 plan；`PROPOSED` 计划需通过 `run/latest` 或 `agent-runs/:runId` 的 `resultPlanId` 获知。Web 只展示其中已校验的归一化 offer 和 provenance。 |

Web 工作台必须先确认 bounded flight search preferences，再发起 `POST /planning/generate`。它只显示服务端的 task status 和 ACTIVE plan；不显示 Tool 参数、snapshot、provider 原始 payload、完整 URL 或 credential。
| `GET /api/v1/agent-runs/:runId/events` | planning 仅发布安全 phase 与 terminal event；不得流式发送 Tool 参数、raw provider response、模型推理或未持久化 offer。 |
| `POST /api/v1/trips/:tripId/search-preferences`（新增） | 保存经用户确认的本次搜索偏好；写入后使依赖旧 snapshot 的 plan/confirmation `STALE`。 |

## 6. 数据模型与状态

### 6.1 新增或扩展的数据

| 实体 | 关键字段 | 约束 |
|---|---|---|
| `trip_search_preferences` | `trip_id`、`version`、`trip_type`、`currency`、`adults`、`cabin`、`offer_freshness_minutes`、`confirmed_by` | 仅保存用户确认的值；每次变更递增版本并使 plan stale。 |
| `provider_search_runs` | `id`、`snapshot_id`、`agent_task_run_id`、`category=flight`、`provider_name`、`request_fingerprint`、`outcome`、`error_code`、`captured_at` | 不保存 raw provider request/response、凭据或敏感 profile 字段。 |
| `provider_offers` 扩展 | `search_run_id`、`provider_offer_id`、`currency`、`expires_at` | 仅 `LIVE` 且 schema-valid offer 可写入。 |
| `itinerary_plans` / `plan_data` 扩展 | 引用 selected offer 的 expiry 和 search run | 当前 plan 中任一必需 offer 过期即不可确认。 |

原始 Amadeus payload 不持久化，不写日志、不进入 prompt；如需排障，仅保留请求指纹、provider request ID（若安全）和稳定错误码。

### 6.2 状态规则

```text
SearchPreferencesProposal
  → user confirms → trip_search_preferences(version n)
  → constraint_snapshot(version n)
  → provider_search_run(LIVE | UNAVAILABLE)
  → validated itinerary_plan(PROPOSED)
  → member adoption (accept-solo / unanimous adoption-votes)
    → itinerary_plan(ACTIVE)
  → offer expiry / change / consent revocation / preference edit
  → itinerary_plan(STALE), confirmations(STALE)
```

确认与 booking sandbox 前必须重新检查所有 selected flight offer 的 `expires_at`。过期、缺失或无法复验即拒绝并返回 `STALE` / `UNAVAILABLE`，绝不自动刷新或静默替换价格。采纳（`PROPOSED → ACTIVE`）本身不做该项复验——`ACTIVE` 表达的是"这是本次 trip 选定的行程"，而非"这份报价当前仍可预订"；后者由确认与 booking 各自独立、原子地把关。

**已实现**（`flight-offer-freshness-service.ts` / `validateSelectedFlightOffersFresh`）：确认（`setConfirmation`，仅当决定为 `CONFIRMED` 时触发；`NEEDS_CHANGES` 不受影响，成员始终可以记录该决定）与 booking sandbox 前都会独立地重新检查该 plan 已选中的每个 Flight offer 的 `provider_offers.expires_at`；确认时机在 `confirmation-service.ts` 内、与 `member_confirmations` 的写入同一事务原子执行，booking 时机在 `submitBooking` 内、与 `booking_executions` 写入同一事务原子执行——确认时新鲜不代表 booking 时仍然新鲜，两处各自独立复验，从不信任更早一次检查的结果。采纳（`activateProposedPlan`）不调用该校验。

三种拒绝原因（`FlightOfferStalenessReason`）：
- `EXPIRED`——`expires_at` 已早于服务器当前时间（409）。
- `MISSING_EXPIRY`——`expires_at` 为 `NULL`（422）。
- `UNVERIFIABLE_EXPIRY`——offer 的到期语义无法向供应商验证（422）。判定依据是持久化在 `provider_offers.expiry_provenance` 列的显式 provenance 值（`PROVIDER_VERIFIED` | `SYNTHETIC` | `NULL`），**从不从 `provider_name` 推断**：SerpAPI 与 FlightAPI 的 adapter 永远写入 `SYNTHETIC`（两者的 `expires_at` 都只是自行发明的 `capturedAt+15min` 缓存新鲜度启发式，不是供应商保证）；Amadeus 的 adapter 在响应含真实 `lastTicketingDate` 时写入 `PROVIDER_VERIFIED`，缺失时同样写入 `SYNTHETIC`——因此同一 provider_name 下的两种情形现在被显式区分，不再是"持久化后无法区分"的已知限制。历史行（早于 `0043_flight_offer_expiry_provenance.sql` 迁移）的该列为 `NULL`，与 `SYNTHETIC` 同等对待、一律 fail closed，永不追溯性地升级为可信。**在当前 `.env` 默认选择 SerpAPI 的情况下，这意味着任何依赖 Flight Tool 产出的 plan 都能正常完成生成与采纳（PROPOSED → ACTIVE，Web 可展示 grounded 的 Flight evidence），但 member 确认（`CONFIRMED`）与 booking sandbox 都无法通过新鲜度校验**——这是按规范要求的 fail-closed 行为，不是缺陷；要让确认与 booking 真正跑通，需要切换到 Amadeus 且该次查询返回的报价确实带有 `lastTicketingDate`。

绝不自动刷新或静默替换价格：拒绝后唯一的补救路径是重新发起 `flight.search`（REPLAN）产生新的、经过持久化的 evidence。

## 7. 配置与启动校验

新增环境变量并同步 `.env.example`：

```dotenv
# Select exactly one flight provider. Unknown/missing configuration fails closed.
FLIGHT_PROVIDER=disabled # disabled | amadeus | flightapi | serpapi

# Required only to enable Amadeus Flight Offers Search.
AMADEUS_ENVIRONMENT=disabled # disabled | test | production
AMADEUS_CLIENT_ID=
AMADEUS_CLIENT_SECRET=
AMADEUS_FLIGHT_TIMEOUT_MS=8000

# Required only when FLIGHT_PROVIDER=serpapi. The private key is sent only
# server-to-server as a query parameter and must not appear in source, logs,
# trace attributes, test fixtures, or tracked env files.
SERPAPI_API_KEY=
SERPAPI_FLIGHT_TIMEOUT_MS=15000
SERPAPI_GOOGLE_FLIGHTS_GL=us
SERPAPI_GOOGLE_FLIGHTS_HL=en

# Enables only providers that pass the tool-calling compatibility spike.
MODEL_GATEWAY_TOOL_CALLING_ENABLED=false
MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS=8
```

生产启动规则：

- `FLIGHT_PROVIDER=serpapi` 时必须有 SerpAPI key、两位 `gl`/`hl` 值和合理 timeout；adapter 保留 provider 默认 cache，不发送 `no_cache=true`，避免无谓的 live-credit 消耗。
- `AMADEUS_ENVIRONMENT=production` 时必须有 client ID/secret、受控 base URL 和合理 timeout。
- `test` 仅允许 development/test；任何 production-like 环境必须拒绝启动。
- Tool-calling 开关仅在目标 LLM 的 schema、tool ID、多轮、deadline、abort 和错误 envelope 验证通过后启用。
- 关闭或未通过时，模型不得请求 Tool；planning 保持 server-orchestrated research + model explanation，仍使用同一 evidence/validator 边界。

## 8. 可观测性与审计

### Metrics

- `flight_tool_invocations_total{outcome,provider,error_category}`
- `flight_provider_requests_total{outcome,provider,error_category}`
- `flight_provider_latency_ms{provider,outcome}`
- `flight_offer_staleness_total{reason}`（**已实现** — `flight-offer-freshness-service.ts`，`reason ∈ {expired, missing_expiry, unverifiable_expiry}`）
- ~~`planning_research_coverage_total{outcome}`~~ **已被后续架构取代**：Personal Trip Orchestrator 引入后，研究阶段的覆盖度/结果由 `research_stage_total{stage,outcome}`（`personal-trip-orchestrator-service.ts`）在相同的编排边界记录；不再单独实现这个指标名，避免重复打点。

标签仅限固定 allow-list；不得把 `tripId`、snapshot、run ID、provider request ID、机场、目的地、用户、报价或自由文本作为 metric label。

### Audit / traces / logs

记录 `FLIGHT_SEARCH_REQUESTED`、`FLIGHT_SEARCH_COMPLETED`、`FLIGHT_SEARCH_UNAVAILABLE`、`FLIGHT_OFFER_EXPIRED`（**已实现**）、`PLAN_STALE`。记录关联 ID、provider、稳定结果码和耗时；不得记录 prompt、模型 reasoning、护照/国籍、原始 provider request/response 或 credentials。trace 覆盖 API → durable task → Tool → provider → evidence persistence → validation。

## 9. 测试与验收

必须新增或更新：

1. Amadeus adapter contract tests：OAuth、有效归一化、无结果、429、5xx、超时、畸形 payload、取消。
2. Tool policy tests：Personal/Review Agent 调用被拒绝；Shared Agent 无 snapshot、越权 origin/destination、自由日期、未确认偏好均被拒绝。
3. Coverage tests：两个出发地 × 两到三个候选全部成功才可生成 plan；任一 `UNAVAILABLE` 时不产生 plan、offer 或 evidence。
4. Evidence tests：模型伪造 offer、改价、改币种、改 expiry、引用旧 search run 都被 validator 拒绝。
5. State tests：偏好更新、报价过期、价格/库存变化、授权撤回均使 plan 和 confirmation stale；确认前 expiry recheck 会阻止 sandbox。
6. Compatibility tests：每个目标 OpenAI-compatible provider 的 function-call 请求、Tool result、tool-call ID、多轮调用、abort、超时和错误 envelope。
7. Security/observability tests：日志、audit、metric、SSE payload 均不含 raw provider payload、密钥、私人聊天或未授权数据。

## 10. 实施阶段与依赖

| 阶段 | 交付物 | 前置依赖 | 完成条件 |
|---|---|---|---|
| 0. 文档与契约 | 本文档、PRD/backlog/test/runtime policy 对齐 | 无 | 不再存在 provider fixture/Demo fallback 的运行时承诺。 |
| 1. 数据与配置 | migration、SearchPreferences API、环境变量、机场/IATA reference | 阶段 0 | 用户确认的搜索约束可版本化并触发 stale。 |
| 2. Provider adapter | Amadeus adapter、token、schema、unavailable mapping、spike report | 阶段 1 | Test 集成通过；Production 未配置时 fail closed。 |
| 3. Flight Tool | `flight.search` Skill、scope、policy、evidence service、审计和 metrics | 阶段 2 | 仅 Shared Agent 能调用，所有越权/失败路径受控。 |
| 4. Planning integration | PLAN/REPLAN durable task、coverage matrix、validator、SSE 状态 | 阶段 3 | HTTP 不再同步运行长规划；不完整 research 不产生 ACTIVE plan。 |
| 5. LLM function-calling | ModelGateway tool loop、目标 provider compatibility spike、feature flag | 阶段 4 | LLM 可请求 Tool，服务端仍强制授权与覆盖。 |
| 6. Staleness / E2E | expiry recheck、replan、前端 unavailable UX、完整 E2E | 阶段 5 | 过期 offer 或 provider 失败不能进入确认/booking。 |

阶段 2 与阶段 1 的 test-only contract testing 可并行；阶段 5 必须在阶段 3、4 后开始。任何阶段发现 provider 条款、路线覆盖或 Tool-calling 兼容性不满足，都保持 `UNAVAILABLE`，不得以伪造或静态价格绕过。
