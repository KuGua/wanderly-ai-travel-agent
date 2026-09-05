# 全球 POI 与地面出行实施规范

**状态：** 已确认，待实施
**适用范围：** `apps/api`、`apps/web`、数据库迁移与项目级契约文档
**非目标：** 本规范不授权真实下单、支付、自动预订或将路线、估价、时刻伪装成可购买库存。

## 1. 目标与完成标准

在现有 Shared Trip `PLAN` / `REPLAN` durable task 中增加全球关键词 POI 解析、任意已授权 POI 间路线，以及可扩展的出租车、接送、包车、租车和公共交通能力边界。

首个可验收版本必须做到：

1. Shared Agent 可调用受限的 `places.search`，使用关键词在当前目的地上下文中查询 POI 候选；模型、浏览器均不能提交坐标、provider 参数或 URL。
2. 候选 POI 以运行绑定的短生命周期 `candidateId` 返回；只有明确加入 `PROPOSED` plan 或用户显式共享后才成为版本化 `TripPlace`。
3. Shared Agent 可调用 `navigation.route`，在任意两个当前 Trip 已授权 `placeId` 之间获取步行、驾车或骑行的 ORS 路线；UI 显示路线线条、距离、时长、步骤、来源与检查时间。
4. Flight、Stay、Activities、Navigation 和 Mobility provider 缺失均不得使 Agent task 失败。任务返回 `COMPLETED_WITH_GAPS` 及安全的 `RESEARCH_SUMMARY`；不含 live evidence 的服务不可进入对应的确认或 booking sandbox 动作。
5. 打车/接送/包车使用独立 `MobilityOfferProvider` port，首个候选实现为 Amadeus Transfer Search 的搜索/估价能力；不下单、不展示或透传未经确认的 booking link。
6. 公交实时和租车保留独立 port，不承诺由 ORS、Amadeus Transfers 或任一免费数据源提供全球一致覆盖。

## 2. 既有系统接缝

| 现有模块 | 当前事实 | 本方案处理 |
|---|---|---|
| `src/providers/types.ts` | 只有 `GroundProvider.searchGround({ destination, snapshotId })`，返回带 `priceUsd` 的 `GroundOffer` | 以 `NavigationProvider`、`TransitJourneyProvider`、`MobilityOfferProvider` 替代该错误聚合语义；保留旧 port 仅作迁移期兼容。 |
| `src/providers/live-provider-factory.ts` | Ground provider 永远是 `NOT_CONFIGURED` | 通过配置注册 ORS navigation、Amadeus transfer；未配置时返回对应 `UNAVAILABLE` provider。 |
| `src/skills/shared/flight-search-skill.ts` | 已具备 snapshot-bound tool、Zod、审计、超时和 normalized output 模板 | 复用模式实现 `places.search`、`navigation.route` 与后续 `mobility.search`。 |
| `src/services/planning-service.ts` | 研究结果和 final validator 假定所有服务齐全，否则阻断 | 改为 service outcome matrix + `RESEARCH_SUMMARY`；只在用户选择相应商业动作时执行 hard gate。 |
| `src/db/schema.ts` | 已有通用 `provider_search_runs`、`provider_offers`、`source_evidence` | 复用 search run/source evidence；新增语义正确的 place 与 route evidence 表，不将路线写成价格 offer。 |
| `src/agents/*` 与 `ModelGateway` | 仅 flight tool 已注册和调度 | 扩 `SkillScope`、`SkillContext`、Shared registry 和 tool definitions；模型只看 normalized data。 |
| `apps/web` TanStack Query + MapLibre | 地图是显示层，不能成为路线或 POI 事实 | 新增 server API hooks 和 itinerary route UI；不把地图 label 或浏览器状态当业务权威。 |

## 3. 目标架构

```text
Shared PLAN / REPLAN durable task
  ├─ immutable constraint_snapshot
  ├─ places.search (LLM tool; bounded)
  │    └─ PlaceResolver → configured POI/geocoding provider
  ├─ TripPlace proposal/adoption (server authority)
  ├─ navigation.route (LLM tool; snapshot + run bound)
  │    └─ GroundCapabilityRouter → OrsNavigationProvider
  ├─ mobility.search (scheduled/LLM tool; later phase)
  │    └─ GroundCapabilityRouter → AmadeusTransferProvider
  ├─ normalized evidence + provider_search_runs
  ├─ service outcome matrix
  └─ deterministic validator
       ├─ complete selected live evidence → PROPOSED plan
       └─ gap(s) → RESEARCH_SUMMARY / COMPLETED_WITH_GAPS
```

`GroundCapabilityRouter` 是唯一 provider 选择点。它按能力、目的地国家/城市、feature flag 和已配置 provider 决定 primary provider；它不得由 LLM 选择 provider。后续 fallback 仅允许在相同语义和数据等级的 provider 之间发生，并且必须记录真实来源和 fallback 原因。

## 4. 领域模型与状态

### 4.1 TripPlace

新增 `trip_places`，作为 POI 的服务端权威引用，不持久化浏览器临时 pin。

| 字段 | 说明 |
|---|---|
| `id`, `trip_id`, `version` | UUID、所属 Trip 与乐观版本。 |
| `owner_user_id` | 创建者；系统创建的 Proposed place 使用 run creator。 |
| `visibility` | `OWNER_PRIVATE`、`TEAM_VISIBLE`、`ORCHESTRATOR_CONFIDENTIAL`。 |
| `status` | `PROPOSED`、`ACTIVE`、`REVOKED`。 |
| `kind` | `ATTRACTION`、`HOTEL`、`RESTAURANT`、`TRANSPORT_HUB`、`OTHER`。 |
| `display_name`, `country_code`, `city_name` | 经 schema 限长的显示数据；不能当作 provider 查询自由输入。 |
| `longitude`, `latitude` | server-only 坐标；不得进入 telemetry；只向已获访问授权的 Trip UI DTO 下发。 |
| `source`, `provider_place_id`, `captured_at` | 来源、provider stable id（若有）和采集时间。 |
| `created_from_run_id` | 可空；使 search/adoption 可审计且可阻止跨 run 候选引用。 |

创建/撤回/修改 `TEAM_VISIBLE` 或 `ORCHESTRATOR_CONFIDENTIAL` place 必须在同一事务中使依赖该 place 的 route evidence、ACTIVE plan 与 confirmations 进入 `STALE` 并 enqueue `REPLAN`。私有 place 永不进入 Shared snapshot。

### 4.2 Provider evidence

新增 `navigation_route_evidence`：`search_run_id`、`snapshot_id`、`trip_id`、origin/destination `place_id`、mode、distance_meters、duration_seconds、steps JSON、encoded geometry、source、captured_at、refresh_after。geometry 是受保护的 Trip 数据；默认不进 LLM、日志、trace、metric 或 audit summary。

`provider_search_runs.category` 扩展为 `place`、`navigation`、`transit`、`mobility`。`provider_offers` 只保存真正含价格/有效期的 `MobilityOffer`；路线 evidence 不写入该表。`source_evidence` 扩展 category 以关联已持久化 plan 中的路线与 mobility offer。

新增 `planning_research_results`：`trip_id`、`snapshot_id`、`agent_task_run_id`、`status` (`COMPLETE` / `COMPLETED_WITH_GAPS`)、安全的 `service_gaps`、`created_at`。它不是 `itinerary_plan`，没有 adoption、confirmation 或 booking authority。

### 4.3 依赖门禁

| 能力 | Research | 计划/确认规则 |
|---|---|---|
| Flight、Stay、Activities | 软依赖；失败记录 gap，task 继续 | 只有用户选择其 live offer 并进入相应 sandbox 动作时才为 hard gate。 |
| Navigation | 软依赖；不通或无数据只显示 `UNAVAILABLE` | 默认不产生商业确认门禁；若某已确认 HARD accessibility constraint 无可达路线，阻止该 POI 被采用。 |
| Taxi / transfer / charter / rental | 软依赖 | 只有用户选择具体 live offer 后才要求价格、币种、有效期和确认。 |
| Transit | 软依赖 | 只有 plan 明确承诺某班次或票价时才成为 hard gate。 |

所有 task 都须终止为 `COMPLETED`、`COMPLETED_WITH_GAPS`、`FAILED`、`STALE` 或 `CANCELLED`。provider `UNAVAILABLE` 绝不是 `FAILED` 的理由；schema/policy/authorization 失败、租约丢失与取消才是终止失败。

## 5. Tool 与 API 契约

### 5.1 Shared `places.search`

```ts
type PlaceSearchInput = {
  destinationId: string; // 必须属于 snapshot.destinationCandidates
  keyword: string;       // 1..160；不包含 private chat 原文
  category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
};

type PlaceSearchOutput =
  | { outcome: "LIVE"; queryId: string; candidates: PlaceCandidate[] }
  | { outcome: "UNAVAILABLE"; code: ProviderUnavailableCode };
```

服务端从 `destinationId` 解析城市/国家偏置，限制每次最多 5 个结果、每 run 最多 6 次 place search、总字符/超时预算与 provider rate limit。「最多 5 个结果」由 `place-search-service.ts` 的 `PLACE_SEARCH_MAX_RESULTS` 在**服务端**收口，不依赖任何单个 provider 的内部上界——仓库内两个 place provider 都返回至多 10 条，而 skill 输出契约是 1..5；2026-09-05 之前这个常量从未被引用，未截断的结果在 skill registry 的输出校验里被拒，且因为拒绝发生在搜索已成功并落库之后，整个能力被报成 provider 故障（见 `docs/test-scenarios.md` TS-SKILL-OUTPUT-CONTRACT）。候选只在当前 `runId` 有效；LLM 只能在后续 tool call 传回同 run `candidateId`。低置信度、国家不匹配或目的地外候选必须标为 `needsUserConfirmation`，不得自动成为 ACTIVE place。

### 5.2 Shared `navigation.route`

```ts
type NavigationRouteInput = {
  originPlaceId: string;
  destinationPlaceId: string;
  mode: "WALK" | "DRIVE" | "CYCLE";
};

type NavigationRouteOutput =
  | { outcome: "LIVE"; routeId: string; summary: RouteSummary }
  | { outcome: "UNAVAILABLE"; code: ProviderUnavailableCode };
```

handler 必须检查：当前 task 的 trip/snapshot、两个 place 的可见性与 status、run binding、mode allow-list、坐标范围、origin ≠ destination。ORS adapter 以 server-only `ORS_API_KEY` 调用 Directions v2；仅解析受 Zod 限制的 distance/duration/steps/geometry，raw payload 不出 adapter。UI 通过鉴权 DTO 获取 route geometry；LLM 仅接收 summary 与 source/time。

### 5.3 Mobility 与 Transit

`mobility.search` 的输入为两个已授权 place、服务类型、服务端派生的出发时间和乘客数；Amadeus Transfer Search 的报价/估价输出必须含 `source`、`capturedAt`、currency、`expiresAt`（若 provider 提供）和明确 `estimated` 标记。不得透传 booking link。

`transit.search` 为预留 Shared tool，不在首期注册。实现前必须选择拥有明确全球或区域覆盖、实时语义、商业条款和 attribution 的 `TransitJourneyProvider`。不使用 ORS route 代替公共交通时刻或票价。

HTTP API 保持 command/query 分离：planning route 不新增浏览器直连 provider endpoint；`POST /api/v1/planning/generate` 仍创建 durable task。新增受鉴权的 Trip place CRUD、route evidence 查询和 research-result 查询 API；所有 mutation 要求 idempotency key。

## 6. 模块改动清单

### 6.1 新增

| 路径/模块 | 职责 |
|---|---|
| `src/providers/ors-place-provider.ts`、`ors-navigation-provider.ts`、schemas | Geocoding/POI 与 Directions v2 的最小 schema、deadline、429/5xx 映射和 attribution metadata。 |
| `src/providers/amadeus-transfer-provider.ts`、schemas | Transfer Search 的正规化 mobility offer；丢弃 booking link。 |
| `src/providers/ground-capability-router.ts` | 固定、可审计的 provider 选择与同语义 fallback。 |
| `src/services/place-search-service.ts`、`trip-place-service.ts` | run-bound candidate、place adoption、visibility、stale/invalidation。 |
| `src/services/navigation-route-service.ts`、`navigation-research-matrix-service.ts` | snapshot/run validation、route evidence、outcome matrix。 |
| `src/services/planning-research-result-service.ts` | `COMPLETED_WITH_GAPS` 摘要及安全 DTO。 |
| `src/skills/shared/place-search-skill.ts`、`navigation-route-skill.ts` | Shared skill contracts。 |
| migrations | `trip_places`、`navigation_route_evidence`、`planning_research_results` 与扩展 category/index/foreign keys。 |
| `apps/web/src/components/trips/*` | POI candidate confirmation、route line/steps、gap state 与 attribution。 |

### 6.2 修改

| 模块 | 修改 |
|---|---|
| `providers/types.ts` | 定义三个语义独立 port 与 normalized evidence；废弃 `GroundOffer.priceUsd` 路由用途。 |
| `live-provider-factory.ts` | 从 env/config 创建 ORS、Amadeus Transfer 或 unavailable implementation。 |
| `agents/contracts.ts` / `policy-gate.ts` | 新增 `places:search`、`navigation:route`、`mobility:search` scope；只授予 Shared。 |
| `shared-trip-agent.ts` / registry | 注册两个首期 Shared skills；Personal Agent 不注册路线或商业 mobility tool。 |
| `planning-service.ts` / task handler | bounded tool loop、research matrix、gap summary、finalization 和 stale guard。 |
| `model-gateway.ts` | 只向 Shared planning 公开新增 tool schema；模型不获得 raw coordinates/geometry/provider payload。 |
| `plan-output-validator.ts` | 验证 place visibility、route evidence run/snapshot binding、provenance、刷新时间与 selected commercial offers。 |
| `observability/*` / audit enum | 增加 provider/capability/outcome/error-category metrics 与安全 audit action；不增加高基数 place/route labels。 |
| `apps/api/.env.example` | 新增无敏感占位配置和用途/格式/必填说明。 |

## 7. 配置、依赖与可观测性

新增配置：`ORS_API_KEY`、`ORS_BASE_URL`（默认官方 v2 base）、`ORS_PLACE_TIMEOUT_MS`、`ORS_DIRECTIONS_TIMEOUT_MS`、`PLAN_MAX_PLACE_SEARCHES`、`PLAN_MAX_ROUTE_QUERIES`、`PLAN_ENABLE_MOBILITY`、`AMADEUS_TRANSFER_TIMEOUT_MS`。key 仅存 AWS Secrets Manager，绝不发往浏览器。

每次 provider 调用须建立 OTel client span，安全属性仅含 `provider.name`、`provider.operation`、`provider.outcome`、`transport.mode`、`error.category`。metrics 采用低基数 `place_search_tool_invocations_total`、`navigation_route_tool_invocations_total`、`navigation_provider_latency_ms`、`mobility_provider_requests_total`、`planning_research_results_total`。`trip_id`、`run_id`、`place_id` 仅放 trace/log correlation context。

ORS 使用必须在路线 UI 和任何地图展示处保留 `© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors` attribution。部署前必须完成 key、配额、目标全球样本、profile、响应 schema 与 attribution spike。

## 8. 实施阶段与依赖

1. **契约与迁移**：更新项目事实来源、schema/migration、domain types、unavailable codes、test doubles。后续阶段均依赖此阶段。
2. **地点解析与 TripPlace**：ORS Place adapter、run-bound candidates、visibility/adoption、stale transaction、API 与单元/集成测试。
3. **导航**：ORS Directions adapter、route evidence、`navigation.route`、registry/policy/model gateway、matrix、route UI 与 attribution。
4. **非阻断研究结果**：`planning_research_results`、task terminal semantics、safe SSE/GET DTO、validator 改造和 regression tests。该阶段在首次启用 navigation 前完成。
5. **Mobility offer**：Amadeus Transfer adapter、offer freshness、selection/confirmation gate、UI。不得加入 booking。
6. **Transit 与 rental**：在 provider/商业条款/覆盖验证后单独立项；不得阻塞前五阶段。

## 9. 必测边界

- 同名 POI、低置信度、跨目的地/跨国家候选、空结果、rate limit、超时、provider schema 漂移。
- 浏览器或模型传入坐标、地址、provider、过期/跨 run candidate、私有/撤回/不存在 placeId 的拒绝。
- place 创建/撤回与 route refresh 使旧 plan/confirmations `STALE`；租约丢失和重复 command 不产生重复 evidence/plan。
- 任一 Flight/Stay/Activities/Navigation/Mobility `UNAVAILABLE` 产生 `COMPLETED_WITH_GAPS`，不泄漏 raw payload，其他 research 继续。
- 只有用户选择的商业 offer 可进入对应 confirmation/sandbox gate；navigation/POI 不创造付款或 booking authority。
- UI route 与 provider attribution 只对有 Trip 访问权的成员可见；日志、trace、metric/audit 不含关键词、名称、地址、坐标、geometry 或步骤正文。

## 10. 风险与禁止事项

- 全球可查询不等于全球实时、全球可订购或全球覆盖；所有 capability 必须按查询返回真实 availability。
- ORS Geocoding/POI 结果是外部不可信数据，必须 schema validate、限流、限制返回量，并且不执行其中任何文本、URL 或 metadata。
- 不把导航 route 填进 `provider_offers` 或伪造 `priceUsd`；不把 transit 结果从道路 ETA 推断出来。
- 不新增 Redis、Temporal、WebSocket、自由 multi-agent 或浏览器直连 provider。
- 公共 provider 不可用时 fail closed；不得以 fixture、Demo data 或 LLM 编造地点、路线、价格、时刻或库存。
