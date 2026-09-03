# 住宿发现与酒店实时报价实施方案

**状态：** Phase 1 已实施，待完整回归与发布门禁
**后续 provider 演进：** 本文记录已实施的 SerpApi Phase 1 基线。Nuitee Connect / LiteAPI 作为默认报价源、以及与 SerpApi 的 task-bound 可切换设计，以 [Nuitee Connect / LiteAPI 与 SerpApi Google Hotels 可切换报价实施规范](nuitee-serpapi-hotel-provider-switching-implementation.md) 为准；后续开发不得以本文的“首发 SerpApi”描述替代该规范。
**范围：** 在现有 Shared PLAN/REPLAN durable task 中接入 provider-neutral `accommodation.discover` 与 `hotel.search`。前者用 OpenTripMap 建立无价格的住宿规划骨架；后者只在用户确认入住日期、房间、住客数和币种后，用 SerpApi 查询实时价格。
**不在范围：** 真实预订、支付、供应商订单创建、供应商 booking/deep link 对 LLM 的透传、浏览器直连供应商、使用 fixture 或 sandbox 库存作为产品运行时数据。

**2026-09-03 sandbox 调用策略：** “确认入住日期、房间、住客数和币种”指
结构化住宿偏好已经由用户确认并版本化，不等同于每次 Tool 调用再确认一次。
当前 sandbox 中，参数齐全的只读 `hotel.search` 自动执行，不显示第二个
Search/Cancel 卡片；它仍不授予预订、支付或 provider-only 身份字段权限。
Nuitee 报价国籍授权继续作为独立的显式边界。

## 1. 实施边界与完成标准

### 1.1 强制约束

1. 酒店能力只提供**实时搜索和方案比较**。任何供应商的创建订单、付款、住客证件/卡信息、确认号和回调均不接入本功能。
2. 无生产可用、可验证的 supplier 数据，或 supplier 超时、限流、无结果、返回 schema 异常、报价过期时，统一返回 `UNAVAILABLE`；不生成替代报价、Demo data 或可确认酒店选择。
3. 模型只能调用已注册的 `hotel.search`，不得选择 provider、构造地点坐标/地址、设置日期、住客/房间数、币种、价格或原始房型 ID。所有搜索参数由服务端的 task、snapshot 和已确认搜索偏好推导。
4. 模型可以在 private conversation 中询问缺少的住宿搜索信息；回答只能形成 `StaySearchPreferences` **提案**。用户显式确认后，服务端才版本化保存，且相应 Trip 的旧 plan/confirmation 必须进入 `STALE`。
5. 酒店卡同时展示总价与每晚价；供应商未返回完整税费或强制费用时，固定显示“可能另计”。不得从 base price 推断 all-in price。
6. 原始 supplier payload、认证 token、booking URL、供应商 request URL、住客资料和未授权 Profile 字段不得进入模型、前端持久化、日志、metric label、trace attribute 或 audit summary。

### 1.2 完成标准

- Shared PLAN/REPLAN Worker 可针对 snapshot 中每个 destination candidate 调用一次 `hotel.search`，并持久化同一 run/snapshot 的规范化结果或安全缺口。
- Shared PLAN/REPLAN Worker 可在没有报价偏好时调用 `accommodation.discover`；返回结果只表达名称、类别、坐标、距离、来源和归因，绝不表达实时价格、库存或可预订性。
- LLM 只接收规范化 hotel offers，最终 plan 只能引用当前 run 的同一完整 evidence 对象。
- 报价、日期、住客/房间配置、偏好或授权变化，以及 `expiresAt` 到期，均能使相关 plan 进入 `STALE` 并通过现有 replan 控制面重新研究。
- 所有新增行为有 adapter、skill、服务、planning、stale、权限、失败和回归测试；新增酒店文档须被文档校验器覆盖。当前仓库既有非酒店文档校验债务应在实施 PR 中一并清零。

## 2. 现有架构接缝

| 现有模块 | 当前事实 | 本功能的处理 |
|---|---|---|
| `src/providers/types.ts` | 已有 `StayProvider.searchStays` 与过于简化的 `StayOffer` | 以兼容方式演进为 hotel 专用 port 和可验证报价模型；不新建通用 HTTP client。 |
| `src/providers/live-provider-factory.ts` | `stayProvider` 始终为 `UnavailableStayProvider` | 通过独立 provider-neutral `HotelProvider` 注册 SerpApi Google Hotels adapter；未配置 key 时保持 `UNAVAILABLE/NOT_CONFIGURED`。 |
| `src/agents/*` | Registry、scope gate、Zod Skill、timeout 和 `SKILL_INVOKE` audit 已可用 | 新增 Shared-only `hotel:search` scope、execution context 和 `hotel.search` Skill。 |
| `src/services/flight-search-*` | 已有 confirmed preferences、snapshot/run binding 和 provider search run 模式 | 复用该模式新增独立的住宿搜索偏好服务；不得混入 flight preference 版本。 |
| `src/services/planning-service.ts` | tool loop 当前仅调度 `flight.search`；`stayProvider` 被直接调用 | 将酒店改为同一 bounded tool loop 的受控 tool，并把 hotel coverage 纳入研究矩阵和最终 evidence validator。 |
| `provider_search_runs`、`provider_offers`、`source_evidence` | 有通用 evidence 存储 | 复用，`category='hotel'`；不保存 raw response 或 booking URL。 |
| `planning_research_results` | 已表达 `COMPLETED_WITH_GAPS` | 复用 `serviceGaps`，增加 `hotel` capability；gap 不是 offer，不能被选择。 |

## 3. 技术栈与 supplier 边界

不新增运行时技术栈：Node.js LTS、TypeScript、Fastify、PostgreSQL、Drizzle、Zod、OpenTelemetry、Pino、现有 PostgreSQL durable Worker 与 ModelGateway 均复用。

2026-08-29 的 supplier spike 确认 Booking.com Demand 要求 Managed Affiliate Partner、合同及 Account Manager 开通，团队无法在 Hackathon 时限内取得；Amadeus 也已被项目既有准入结论排除。因此首发 adapter 改为 `SerpApiHotelProvider`，但 provider port 保持供应商无关。SerpApi 提供即时 self-service key 与每月免费额度；它聚合 Google Hotels 公开搜索结果而非 Google 官方合作 API，故必须显示 `SerpApi Google Hotels` 来源，禁止暗示由 Google/OTA 背书。无 key、额度耗尽、上游失败或字段漂移均严格 `UNAVAILABLE`。

2026-08-30 的 live spike 同时确认：openrouteservice geocoder 不存在 `accommodation` layer，不能承担住宿类别发现；OpenTripMap `places/radius?kinds=accomodations` 可通过目的地中心坐标返回住宿 POI。因此非价格发现使用 `OpenTripMapAccommodationProvider`。免费计划适合本次非商业 Hackathon，但有 5,000 次/日、10 次/秒、无 SLA 和非商业限制；运行时必须保留 `© OpenStreetMap contributors` 归因。商业化或正式生产前必须重新审查许可和供应商方案。

Spike 依据（2026-08-30 复核）：[Booking Demand prerequisites](https://developers.booking.com/demand/docs/getting-started/prerequisites)、[SerpApi Google Hotels contract](https://serpapi.com/google-hotels-api)、[SerpApi free quota](https://serpapi.com/use-cases/web-search-api)、[SerpApi terms](https://serpapi.com/legal)。当前 SerpApi contract 没有可验证的多房参数，因此首发只接受 `room_count=1`；多房请求返回 `SEARCH_CONSTRAINTS_INCOMPLETE`，绝不把单房价乘算成多房实时价。

仅使用 Search/Look 所需接口；本方案不实现 Redirect、Orders 或 Payments。即使 upstream 返回 URL，也在 adapter 边界删除。

## 4. 目标架构与数据流

```text
Private conversation
  -> StaySearchPreferences proposal -> user confirmation -> versioned preference
  -> stale active plan/confirmation (if input changed)

POST /planning/generate or replan event
  -> immutable constraint_snapshot + durable task lease
  -> bounded Shared model tool loop
  -> accommodation.discover(destinationId)
  -> DestinationReference -> OpenTripMap -> non-price AccommodationEvidence[]
  -> provider_search_cache (24h live / 30s negative)
  -> when confirmed stay preferences exist:
  -> hotel.search(destinationId)
  -> DestinationReference -> server derives HotelSearchRequest
  -> SerpApiHotelProvider -> distance-validated HotelOffer[] | UNAVAILABLE
  -> provider_search_cache (up to 15m live / 30s negative)
  -> provider_search_runs + provider_offers (only LIVE)
  -> evidence/plan validator
  -> PROPOSED plan, or COMPLETED_WITH_GAPS research result
```

`hotel.search` 的 LLM 输入只包含 `{ destinationId: string }`。服务端验证 destination 属于 snapshot 候选列表，并从以下权威来源构造 `HotelSearchRequest`：

- `constraint_snapshot`：候选目的地、旅行日期、已授权住宿偏好与预算；
- 最新且已确认的 `trip_stay_search_preferences`：房间数、每间成人数、请求币种、价格口径；
- task row：`tripId`、`snapshotId`、`agentTaskRunId`、lease 和 preference version；
- server-owned `DestinationReference`：`destinationId`、规范城市名、ISO-3166 国家码和城市中心坐标。Provider port 不接受自由文本重载；无法唯一解析时直接 `UNAVAILABLE`，禁止降级为城市名猜测。

模型、浏览器或 private chat 不得提供上述权威字段；模型只看到 HotelOffer 的安全展示字段和 provenance。

## 5. 模块改动清单

### 5.1 复用

- `agents/skill-registry.ts`、`policy-gate.ts`、`shared-trip-agent.ts`：注册、授权、Zod output 验证、timeout 和 audit。
- `providers/live-provider-factory.ts`：环境配置选择与 unavailable provider。
- `services/planning-service.ts`、`tasks/handlers/planning-task-handler.ts`：durable execution、lease、finalization、`COMPLETED_WITH_GAPS`。
- `services/consent-service.ts`、change-event/stale 逻辑：snapshot 和 plan 失效控制面。
- `policy/plan-output-validator.ts`：引用 provider evidence 的确定性校验。
- `provider_search_runs`、`provider_offers`、`source_evidence`、`planning_research_results`：规范化 research evidence 与安全结果查询。

### 5.2 修改

| 路径 | 修改 |
|---|---|
| `src/providers/types.ts`、`src/types/domain.ts` | 将 `StayProvider`/`StayOffer` 演进为酒店搜索契约和 `HotelOffer`；保留短期 type alias 仅用于迁移，随后删除旧字段引用。 |
| `src/agents/contracts.ts`、`policy-gate.ts` | 新增 `hotel:search`、`HotelSearchExecutionContext`、`SkillContext.hotelSearch`；仅 Shared allow-list 含该 scope。 |
| `src/services/planning-service.ts` | 以 hotel tool 替代直接 `searchStays` 调用；定义 destination hotel coverage，限制每候选一次查询并将 tool output 合入当前 run evidence。 |
| `src/providers/llm-gateway.ts` | system prompt 和 tool definitions 加入 `hotel.search`；保持现有最大 turns，未知 tool 立即失败。 |
| `src/policy/plan-output-validator.ts` | 校验 hotel ID、destination、日期、occupancy、price/currency、tax-fee status、source/capturedAt/expiresAt 与当前 evidence 精确一致。 |
| `src/db/schema.ts` | `provider_search_runs.category` 支持 `hotel`；`provider_offers` 保存正规化 hotel offer；新增住宿搜索偏好表和必要索引。 |
| `apps/api/.env.example` | 增加无敏感 SerpApi 配置及 feature flag 说明。 |
| `apps/web` contracts/query/components | 增加住宿偏好确认表单、research gap 和酒店 comparison DTO；TanStack Query 只缓存服务端 DTO，不保存 supplier secret/URL。 |

### 5.3 新增

- `src/providers/serpapi-hotel-provider.ts` 与 `serpapi-hotel-schemas.ts`：受 Zod 约束的 supplier anti-corruption adapter。
- `src/providers/opentripmap-accommodation-provider.ts` 与 schema：以中心坐标发现住宿；只返回无价格 POI，并保留 OSM 归因。
- `src/services/destination-reference-service.ts`：从服务端 destination 数据或本地城市目录产生唯一 `DestinationReference`；歧义或字段缺失时 fail closed。
- `src/services/provider-search-cache-service.ts`：hotel、activity、accommodation 共用的跨 run read-through cache、短负缓存和数据库租约防击穿。
- `src/services/accommodation-discovery-service.ts`、研究矩阵与 `accommodation-discovery-skill.ts`：Shared-only 非价格住宿发现。
- `src/services/stay-search-preferences-service.ts`、`hotel-search-service.ts`、`hotel-research-matrix-service.ts`：确认偏好、snapshot/run 参数验证、持久化、coverage。
- `src/skills/shared/hotel-search-skill.ts` 与 `hotel-search.md`：Shared-only typed Skill。
- migration：`trip_stay_search_preferences` 及索引；如无法安全复用现有类别类型，再添加受限 enum/check constraint。
- `PUT/GET /api/v1/trips/:tripId/stay-search-preferences`：仅成员可读；确认后返回 version。

## 6. 数据模型与接口

### 6.1 `trip_stay_search_preferences`

| 字段 | 规则 |
|---|---|
| `id`, `trip_id`, `version`, `confirmed_by`, `created_at` | 与 flight confirmed preferences 使用同等版本和审计语义。 |
| `room_count` | 1..8。 |
| `adults_per_room` | `integer[]`，长度等于 `room_count`，每项 1..8。首期不支持儿童年龄、婴儿或多房混合儿童报价。 |
| `currency` | ISO 4217 三位大写码。 |
| `price_display_mode` | 固定 `TOTAL_AND_PER_NIGHT`。 |
| `tax_fee_disclosure` | 固定 `SHOW_POSSIBLY_EXTRA_WHEN_UNKNOWN`。 |

住宿风格与预算继续来自已授权 snapshot，不复制到此表。point-of-sale/booker country 不进入首期模型或 preference；若 supplier 强制要求，必须另行设计字段级授权与数据最小化变更。

### 6.2 `HotelOffer`

```ts
type HotelOffer = {
  id: string; providerOfferId: string; queryId: string; providerName: string;
  destinationId: string; propertyId: string; propertyName: string;
  checkIn: string; checkOut: string; nights: number;
  roomCount: number; adultsPerRoom: number[];
  totalPrice: number; pricePerNight: number; currency: string;
  taxesAndFees: { status: "INCLUDED" | "PARTIAL" | "UNKNOWN"; amount?: number };
  cancellationSummary: string | null; roomSummary: string | null;
  source: string; capturedAt: string; expiresAt: string;
};
```

数值均为有限非负数；`pricePerNight` 由 `totalPrice / nights` 在 adapter 内确定性计算，禁止模型计算。`PARTIAL` 或 `UNKNOWN` 映射 UI 提示“可能另计”。不包含 supplier URL、tokenized link、支付数据、地址坐标、原始 rate ID。

### 6.3 HTTP 与 tool 契约

```text
PUT /api/v1/trips/:tripId/stay-search-preferences
Headers: Idempotency-Key
Body: { roomCount, adultsPerRoom, currency }
Response 200: { version, roomCount, adultsPerRoom, currency, priceDisplayMode, taxFeeDisclosure }

Tool hotel.search
Input:  { destinationId }
Output: { outcome: "LIVE", queryId, offers: HotelOffer[] }
      | { outcome: "UNAVAILABLE", code: ProviderUnavailableCode }

Tool accommodation.discover
Input:  { destinationId }
Output: { outcome: "LIVE", queryId, accommodations: AccommodationEvidence[] }
      | { outcome: "UNAVAILABLE", code: ProviderUnavailableCode }
```

该 HTTP endpoint 只保存用户已确认的表单值；私聊中的模型提问只能创建现有 proposal 模式下的确认草稿，不能调用此 endpoint 或 provider。planning endpoint 不新增浏览器直连 hotel search API。

## 7. 失效、并发与错误语义

1. 每个 task 对每个 destination 最多执行一次 hotel query；`provider_search_runs_hotel_task_destination_unique` 在数据库层原子占位，避免并发 Tool call 绕过应用层检查。跨 run 使用不含用户 ID 的稳定 fingerprint（目的地、日期、房间/住客、币种、locale）做 read-through cache；命中时复制规范化 offer 为当前 run 的新 evidence，不跨 run 引用旧 `queryId`。
2. 通用 `provider_search_cache` 按 provider、category 和完整受控请求计算 fingerprint。hotel LIVE 最长 15 分钟且绝不超过最早 offer 的 `expiresAt`；accommodation LIVE 最长 24 小时；`UNAVAILABLE` 均只缓存 30 秒。并发 miss 由 35 秒数据库 lease 合并；等待者最多等待 1.5 秒，未完成则安全返回 `UPSTREAM_TIMEOUT`，不再发起第二次 supplier 请求。cache hit 必须复制为当前 run 的新 `queryId`，不得跨 run 引用旧 evidence。
3. provider 成功时写入同一 snapshot/run 的 `provider_search_runs` 与 `provider_offers`；失败只写安全 outcome/code，绝不写虚假 offer。
4. 任一 hotel `UNAVAILABLE` 只产生 `hotel` service gap，其他 research 继续；最终写 `COMPLETED_WITH_GAPS`，不能把缺口摘要作为 plan evidence。
5. `expiresAt` 到期、价格/库存 change event、旅行日期、候选目的地、住宿偏好、房间/住客数、币种或授权投影改变，均在同一事务中 stale 相关 ACTIVE plan 与 confirmations，并 enqueue REPLAN。
6. 当前 task lease 丢失、preference version 已变化、snapshot 不匹配、tool schema 无效、未知 tool、跨 run evidence 或 final validator 失败均为 terminal；不得产生新 plan。

## 8. 可观测性与安全

- OTel client span：`provider.name=serpapi_google_hotels`、`provider.operation=hotel_search`、`provider.outcome`、`error.category`；不写 trip/run/query/property ID、目的地文本、价格、住客数或请求体。
- Metrics：hotel/accommodation provider 与 tool 指标，以及 `provider_search_cache_total{category,outcome}`。cache outcome 仅允许 `hit_live`、`hit_unavailable`、`miss`、`wait_timeout`，不得增加 fingerprint 或其他高基数标签。
- Audit：`HOTEL_SEARCH_*`、`ACCOMMODATION_DISCOVERY_*`、`STAY_SEARCH_PREFERENCES_CONFIRMED`；summary 仅含稳定 ID、版本、outcome 和 count，不含价格、地点、房型或用户输入。
- 密钥仅来自 AWS Secrets Manager/运行时 secret：`SERPAPI_API_KEY`、`OPENTRIPMAP_API_KEY`；浏览器不可见，`.env.example` 仅留占位符。

## 9. 实施阶段与依赖

1. **Supplier spike（已完成）**：记录 Booking/Amadeus/ORS accommodation 不可用结论，以及 SerpApi 与 OpenTripMap 的准入、额度、字段、归因和条款；没有 runtime key 时对应 feature 保持 disabled。
2. **领域与存储**：migration、Zod schemas、`HotelOffer`、住宿偏好服务/route、stale trigger、测试 doubles。依赖：无。
3. **Provider adapter**：配置读取、deadline、认证、schema 校验、错误映射、normalization、provider metrics。依赖：阶段 1、2。
4. **Skill 与 planning**：scope/context、`hotel.search`、registry、bounded model loop、coverage matrix、validator、研究结果。依赖：阶段 2、3。
5. **Web 与可观测性**：偏好确认表单、comparison/gap DTO、价格披露、审计/metric/tracing、文档。依赖：阶段 2、4。
6. **集成验证与发布 gate**：production-like supplier smoke test、回归 suite、docs verification、feature flag rollout。依赖：阶段 1–5。

## 10. 必测场景

- 未确认住宿偏好、无房间/住客数、跨成员越权读取或写入、模型试图传日期/价格/provider/URL。
- 每目的地一次成功与一次 `NO_RESULTS`、429、timeout、5xx、认证失败、schema 漂移、过期报价和重复 tool call；覆盖同 task 并发去重、跨 run LIVE cache、30 秒负缓存、过期/悬空 cache miss 与 run-bound `queryId` 重写。
- `DestinationReference` 缺少 ISO 国家码/坐标、同名城市歧义时不调用 provider；ORS 只接受 ISO `boundary.country`；SerpApi 丢弃无坐标或受控半径外结果，并在截取 10 条前完成过滤。
- OpenTripMap 使用坐标而非城市文本，输出不含价格/库存/booking link，保留 OSM attribution；超过半径、无名称、quota/timeout/schema drift 均安全不可用。
- 房间配置、日期、预算/住宿偏好或 consent 变化后的 stale/replan；旧 evidence 和跨 run evidence 被 validator 拒绝。
- `PARTIAL`/`UNKNOWN` 税费始终展示“可能另计”；`INCLUDED` 仅在 provider 明确返回时显示为已包含。
- 任何 raw supplier payload、key、URL、价格/房型输入均不出现在日志、trace、metric label、audit 或模型 tool output。
- provider 未配置时 planner 输出安全 `COMPLETED_WITH_GAPS`，不会引用 fixture/sandbox 结果或创建可预订动作。

## 11. 明确禁止事项

- 不将任何 demo response、fixture 或缓存样例当作生产/演示实时酒店库存。
- 不实现 Redirect、Orders、Payments，且不保存 booking URL。
- 不引入 Redis、Temporal、Step Functions、WebSocket、MCP server、自由 multi-agent 或新的客户端业务真相状态。
- 不把住房搜索、报价有效性或税费判断交给 LLM；LLM 只选择已验证证据并解释取舍。
