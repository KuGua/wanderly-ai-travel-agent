# Nuitee Connect / LiteAPI 与 SerpApi Google Hotels 可切换报价实施规范

**状态：** 待开发  
**目标实现：** 在既有 `hotel.search` 实时搜索与方案比较能力中，以 Nuitee Connect / LiteAPI Rates 为首选 provider，同时保留 SerpApi Google Hotels，并支持通过服务端配置快速切换。  
**范围：** 仅搜索与方案比较；不接入 prebook、book、支付、跳转链接或真实预订。

## 1. 已确认的实施决策

| 决策 | 最终定义 |
|---|---|
| 默认酒店报价源 | `nuitee_connect`（Nuitee Connect / LiteAPI Rates REST API） |
| 保留来源 | `serpapi_google_hotels`，作为可选的同能力 provider |
| 切换方式 | 服务端环境变量 `HOTEL_PROVIDER=nuitee|serpapi|disabled`；配置变更后滚动重启 Worker/API。切换只影响新接受的 task。 |
| 任务一致性 | task 接受时把选择写入服务端权威状态 `agent_task_runs.hotel_provider`；一个 run 只能查询一个 provider，禁止自动 fallback 或混合比较。 |
| 产品边界 | 两家 provider 都只提供实时搜索和比较。所有结果显示来源、采集时间、有效期、总价与每晚价；税费或必缴费用不完整/无法验证时一律显示“可能另计”。 |
| 模型权限 | LLM 只能调用 `hotel.search({ destinationId })`，不能选择 provider，也不能传递地点、日期、住客、币种、国籍、供应商 ID 或 URL。 |
| Nuitee 国籍字段 | `guestNationality` 必须由用户显式确认一次“本次报价国籍”并以 provider-only 授权保存；禁止从 Profile 自动推断、写入 LLM prompt、同行可见 DTO 或遥测。 |

Nuitee 的 `/v3.0/hotels/rates` 是实时报价/可用性接口，要求入住/离店日期、币种、`guestNationality`、`occupancies` 和一种地点条件。MVP 使用现有完整 `DestinationReference.cityName + countryCode`，不调用付费 Places API。认证使用仅服务端的 `X-API-Key`。具体外部契约以 [Nuitee Rates API](https://docs.liteapi.travel/reference/post_hotels-rates)、[认证说明](https://docs.liteapi.travel/reference/authentication) 和 [错误码](https://docs.liteapi.travel/reference/api-errors-for-hotel-booking-workflow) 为准。

## 2. 与现有系统的衔接

现有实现已提供 Shared PLAN/REPLAN durable task、`hotel.search` skill、`HotelProvider` port、酒店查询缓存、`provider_search_runs` / `provider_offers` / source evidence、Plan validator 和 stale/replan 控制面。当前唯一 live adapter 是 `SerpApiHotelProvider`，其 provider 名、source、缓存 fingerprint、Zod schema、validator 和 observability allow-list 存在硬编码，不能直接接入第二家 provider。

| 处理 | 模块 |
|---|---|
| 复用 | `hotel-search-skill`、`hotel-search-service` 的 run/evidence/cache 生命周期、Planning tool loop、研究矩阵、offer expiry stale、UI comparison DTO、现有 PostgreSQL Worker、Zod、Drizzle、Pino、OpenTelemetry。 |
| 修改 | `providers/types.ts`、`types/domain.ts`、`live-provider-factory.ts`、`serpapi-hotel-*`、`hotel-search-service.ts`、`plan-output-validator.ts`、metrics/telemetry allow-list、DB schema/migration、`.env.example`、相关 API/Web DTO 与测试。 |
| 新增 | `NuiteeHotelProvider`、`nuitee-hotel-schemas.ts`、provider selector/config、provider-only nationality authorization service/table、Nuitee adapter contract fixtures/tests，以及 provider-switch integration tests。 |

不改变 OpenTripMap 的非价格住宿发现能力；它仍不得输出价格、库存或可订性。

## 3. 目标架构与数据流

```text
owner confirms stay preferences + provider-only quote nationality
  -> immutable snapshot / durable task acceptance
  -> persist agent_task_runs.hotel_provider
  -> Shared hotel.search(destinationId)
  -> server derives canonical request from task + preferences + DestinationReference
  -> NuiteeHotelProvider OR SerpApiHotelProvider (one only)
  -> schema validation + provider-neutral normalization
  -> provider-scoped cache -> current-run provider_search_runs/offers/evidence
  -> plan validator -> comparison DTO
```

1. `HOTEL_PROVIDER` 仅由部署配置决定；factory 在 task 接受时解析并验证它。`disabled` 或缺失的 key 创建 `UnavailableHotelProvider`，结果为 `UNAVAILABLE/NOT_CONFIGURED`。
2. task 创建事务将 `hotel_provider` 写入 `agent_task_runs`。Worker 只读取该字段，不重新读取默认 provider；运行中配置切换不影响既有 run。
3. `hotel.search` 继续只接受 `destinationId`。服务端从已确认 `trip_stay_search_preferences` 推导 dates、currency、roomCount、adultsPerRoom，再从 `DestinationReference` 推导 Nuitee `city/country` 或 SerpApi query/coordinates。
4. 对 Nuitee，执行前读取同一 trip、发起成员、`nuitee_connect` 的有效 provider-only nationality grant；缺失、撤回或过期返回 `SEARCH_CONSTRAINTS_INCOMPLETE`，不发出 supplier 请求。
5. 成功结果只以当前 run 的规范化 evidence 进入 plan。Nuitee 的 upstream `offerId`、原始地址/图片 URL、request URL 与 payload 不进入 tool 输出、浏览器持久状态、日志或审计摘要。该阶段不需要保存 raw `offerId`。
6. 任一上游失败、限流、schema drift、无授权或无结果均 fail closed。Nuitee 的 HTTP 200 且业务 `error.code=2001` 是 `NO_RESULTS`；不得当作成功空 payload，也不得改查 SerpApi。

## 4. Provider 抽象与接口

### 4.1 领域契约

新增：

```ts
type HotelProviderName = "nuitee_connect" | "serpapi_google_hotels";

interface HotelProvider {
  readonly name: HotelProviderName;
  readonly capabilities: { multiRoom: boolean };
  searchHotels(params: HotelSearchParams): Promise<ProviderResult<HotelProviderItem[]>>;
}
```

将 `HotelOffer.providerName` 与 `source` 改为受控 union，而非 SerpApi literal。每条 offer 必须含 `queryId`、`propertyName`、可选 rating/room/meal/cancellation 摘要、`totalPrice`、`perNightPrice`、`currency`、`taxFeeStatus`、`capturedAt`、`expiresAt`、provider/source；其中 `providerName` 与当前 `agent_task_runs.hotel_provider` 完全一致。不得为了统一展示而猜测取消政策、早餐、税费或 all-in 金额。

缓存 key 必须至少包含 `providerName`、schema version、destination reference、dates、occupancies、currency 和已确认偏好版本；不含国籍明文、raw offer ID、用户 ID。缓存绝不跨 provider 复用。保留现有 LIVE 最长 15 分钟且不超过 supplier expiry、`UNAVAILABLE` 30 秒负缓存与 DB lease 去重语义。

### 4.2 Nuitee adapter

`NuiteeHotelProvider` 调用：

```http
POST https://api.liteapi.travel/v3.0/hotels/rates
X-API-Key: <NUITEE_API_KEY>
Content-Type: application/json
```

请求由服务端构造：`checkin`、`checkout`、`currency`、`guestNationality`、`occupancies`、`city`、`countryCode`、`maxRatesPerHotel: 1`、`includeHotelData: true`。不使用 Places endpoint；当 canonical city/country 缺失或歧义，直接 fail closed。

`occupancies` 由 `adultsPerRoom` 映射为同样数量的 `{ adults }` 项；Nuitee 支持多房，应用层首期接受 1–8 间、每间 1–8 位成人，超出返回 `SEARCH_CONSTRAINTS_INCOMPLETE`。SerpApi capability 仍为单房；当选中 SerpApi 且 `roomCount !== 1` 时保持现有安全错误，不拆分或乘算房价。

adapter deadline 为 12 秒；仅对明确的网络瞬断、5xx 和可重试限流执行最多一次、有总 deadline 约束的 retry。401/403、参数错误、Nuitee 业务错误、2001 无结果和 schema 异常均不 retry。所有错误映射到既有 `ProviderResult` 分类，原始错误 body 不得透传。

Nuitee 返回中只有在所有相关税费/强制费用明确包含时才设置 `INCLUDED`；能确认部分但不能确认完整金额时为 `PARTIAL`；其余为 `UNKNOWN`。`PARTIAL`、`UNKNOWN` 的 UI 文案固定为“可能另计”。

### 4.3 SerpApi adapter 保持兼容

保留 `SerpApiHotelProvider` 的 endpoint、query、距离过滤、10 条结果上限、单房限制和 `SERPAPI_*` 配置。只将其实现迁移到新的 provider-neutral types；来源持续显示 `SerpApi Google Hotels`，不得显示为 Google 官方酒店 API。不得在 Nuitee 失败时暗中调用 SerpApi，反之亦然。

## 5. 数据、授权与状态变更

### 5.1 数据迁移

1. `agent_task_runs` 新增可空 `hotel_provider`（枚举值 `nuitee_connect`、`serpapi_google_hotels`）；只在实际启用 hotel capability 的 task 接受时写入。为 worker 的 task 读取路径建索引/查询覆盖。
2. 新增 `stay_search_provider_authorizations`：`trip_id`、`member_id`、`provider_name`、`field`（首期仅 `guest_nationality`）、加密/受保护的 value、`status`、`granted_at`、`expires_at`、`revoked_at`、版本与审计关联字段。唯一性为 `(trip_id, member_id, provider_name, field, active)`。
3. 现有 `provider_search_runs`、`provider_offers` 保持复用；写入实际 `provider_name`。迁移现有 SerpApi evidence/缓存的 fingerprint schema version，旧 cache 不复用并自然过期。

国籍只用于当前 Nuitee quote 供应商调用；不写入 `constraint_snapshot`、LLM 上下文、公开 plan、共享 trip DTO、metric labels、log/trace/audit summary。用户改变、撤回或授权过期时，撤销相关 grant，原子地使依赖的 hotel evidence、plan 与 confirmations `STALE` 并按当前条件 replan。多人不同国籍时，界面要求报价发起人明确选择一个“本次报价国籍”；不得默认推断为任何成员国籍，也不得声称该报价适用于所有旅客。

### 5.2 配置

在 `apps/api/.env.example` 增加（只写占位符和说明）：

```dotenv
# disabled | nuitee | serpapi; affects newly accepted hotel-search tasks only
HOTEL_PROVIDER=disabled
PLAN_ENABLE_HOTEL=false
NUITEE_API_KEY=
NUITEE_BASE_URL=https://api.liteapi.travel
NUITEE_HOTEL_TIMEOUT_MS=12000
NUITEE_HOTEL_MAX_RETRIES=1
```

保留现有 `SERPAPI_HOTEL_ENABLED`、`SERPAPI_API_KEY`、timeout/retry/radius 配置。启动校验：`HOTEL_PROVIDER=nuitee` 必须有 `NUITEE_API_KEY`；`serpapi` 必须同时启用且有 SerpApi key；不满足不阻止应用启动，但 provider 为明确的 `NOT_CONFIGURED` 并有安全运维日志。供应商费用、额度和 look-to-book 条款按账号合同实时确认；禁止将静态免费额度或 RPS 数字写进产品承诺。Nuitee 的公开 [API pricing](https://docs.liteapi.travel/reference/api-pricing-usage-costs) 说明 Rates 受条款及 reasonable look-to-book 约束，不能将“免费”理解为无限制。

## 6. 接口与 UI 变更

`hotel.search` 的 LLM tool schema 和对外 plan 比较 DTO 不新增 provider 参数。新增 owner 确认的 provider-only 报价输入 endpoint/表单，最小请求为：`provider: "nuitee_connect"`、`guestNationality: ISO-3166-1 alpha-2`、明确用途确认；响应只返回授权状态/版本，不回显国籍。

酒店 comparison DTO 可增加只读 `providerName`（内部稳定枚举）与 `source`（展示文本），但不得包含 Nuitee `offerId`、supplier URL、完整地址、图片 URL、国籍或原始房型 token。provider 差异须在卡片来源处明确展示，禁止把不同 provider 的结果标为同一库存池。

## 7. 实施顺序与任务拆分

1. **契约与迁移：** provider enum/neutral offer types、`agent_task_runs.hotel_provider`、provider-only authorization schema/service、cache key version；完成 migration rollback 验证。
2. **选择器与 SerpApi 回归：** 改 factory、task acceptance binding、service/validator/metrics 的 hardcode；证明已有 SerpApi 行为和单房保护不变。
3. **Nuitee adapter：** config、HTTP client、Zod schema、error mapping、normalizer、多房 mapping、deadline/retry 和 adapter contract tests。
4. **Skill/状态接线：** execution context 读取 task-bound provider 和 grant；实现授权 UI/API、stale/replan、plan evidence validation，确保模型不可操纵 provider 或国籍。
5. **比较 UI 与运维：** 来源展示、统一“可能另计”、provider-scoped metrics/dashboards、runbook、feature rollout。
6. **上线：** 先以 `HOTEL_PROVIDER=serpapi` 回归生产样环境，再启用 Nuitee sandbox/account 验证，最后把新 task 默认切为 `nuitee`；保留一次配置回切路径，不迁移/混合已有 plan。

## 8. 验收与测试

- Nuitee 单房及多房请求分别正确构造 `occupancies`；SerpApi 多房继续在 provider 调用前 fail closed。
- 切换 `HOTEL_PROVIDER` 后，新 task 持久化新 provider；旧 run、cache、evidence 与 plan 不改变，且两个 provider 的 cache 永不命中对方。
- Nuitee 缺少/撤销/变更报价国籍不会调用上游，并令依赖 evidence/plan `STALE`；国籍不出现在 LLM 输入、前端持久数据、日志、trace、metric label、fixture 或 audit summary。
- 覆盖 Nuitee 2001、401/403、429、5xx、timeout、malformed payload、过期 rate；全部产出明确 `UNAVAILABLE`/`NO_RESULTS` gap，无 SerpApi fallback、无 fixture。
- 验证 Nuitee/SerpApi 的 `INCLUDED`、`PARTIAL`、`UNKNOWN` 税费显示；后两者始终显示“可能另计”。
- 针对 provider selector、Nuitee adapter、酒店 cache、planning task、stale/replan 和 plan validator 运行单元/集成/contract 测试；执行 `npm run typecheck`、相关 Vitest、migration test 和 `git diff --check`。

## 9. 可观测性、风险与回滚

新增低基数指标：`hotel_provider_requests_total{provider,outcome}`、`hotel_provider_latency_ms{provider}`、`hotel_provider_errors_total{provider,error_code}`、`hotel_provider_cache_total{provider,result}`；trace/log 使用 `trip_id`、`run_id`、`plan_version` 关联，不记录国籍、价格、酒店名、offer ID、URL 或 key。为 Nuitee 认证失败、schema drift、错误率和延迟设置告警；价格/酒店名均不能成为 metric label。

主要风险是 Nuitee contract/账号准入变化、Rates 合理使用限制、单一 `guestNationality` 对多人行程的语义、供应商字段无法证明税费完整、以及配置切换导致价格来源不同。缓解措施分别为 adapter contract fixtures + fail closed、账户上线检查与限流、显式 provider-only 确认、保守“可能另计”规则、run-bound provider persistence 及显式来源展示。

回滚只需将新部署的 `HOTEL_PROVIDER` 设为 `serpapi` 或 `disabled` 并滚动重启；已完成 plan 保持原 evidence/source，用户要求重新报价时才创建新的 task。不得通过修改旧 run 的 provider 或复制另一 provider 的报价实现回滚。

## 10. 明确不做

- 不使用 Nuitee MCP server、Places、Price Index、Prebook、Book、订单、支付、redirect/deep link。
- 不新增 Redis、Temporal、Step Functions、WebSocket、自由 multi-agent 或客户端业务真相。
- 不自动按成员 Profile 填充国籍，不将多位成员拆成多次报价后伪装为同一订单价。
- 不做运行时 fixture/demo fallback，不从 base price 推断税费或总价，不在两家 provider 之间自动 fallback。
