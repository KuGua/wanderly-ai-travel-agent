# 地图地点介绍共享缓存实施方案

**状态：** 已实施（待合并）
**范围：** Explore Map 中具有服务端认可稳定 `sourceId` 的地点介绍。  
**关联事实来源：** [技术栈](../TECH_STACK.md) · [PRD](PRD.md) · [Backlog](backlog.md) · [测试场景](test-scenarios.md) · [API](../apps/api/API.md)

## 1. 目标与固定边界

用户点击具有稳定 `sourceId` 的地图地点时，抽屉自动加载并展示该地点的短介绍。服务端在 7 天有效期内向所有用户复用同一语言版本的介绍；缓存缺失或过期时才调用 LLM。`apps/api/data/location-introduction/catalog.json` 是唯一的版本化目录事实来源，每条 `sourceId` 都必须先被服务端认可。

本能力是公共、非个性化的地点编辑内容，不是旅行候选、价格、库存、签证、路线或预订事实。它不创建 `shared_trips`、`chat_threads`、`chat_messages`、`agent_task_runs`、授权、快照或审计中的用户内容。

- `sourceId` 必须存在于版本化目录中；未知或不合法的格式直接拒绝（`400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE`）。
- `INSPIRATION`、任意坐标、地图标签和客户端自行构造的地点均不生成或共享缓存。
- 默认 TTL 为 7 天（`604800` 秒）。
- 同一缓存键生成中时，后续请求不重复调用 LLM，而是得到 `202 GENERATING` 并短暂轮询。
- 不引入 Redis。PostgreSQL 是跨实例缓存、租约和失效的唯一服务端存储；TanStack Query 仅作浏览器短缓存。
- 抽屉不显示“AI 生成”徽章或生成时间。LLM prompt 必须禁止时效性和可操作旅行断言，避免内容被误认为实时事实。

## 2. 现有架构衔接

| 现有模块 | 动作 | 实施要求 |
|---|---|---|
| `apps/web/src/components/explore/explore-map-page.tsx` | 修改 | 选中地点后自动请求介绍，在同一抽屉显示 loading、正文、不可用和重试状态；不得打开聊天或发送 turn。 |
| `apps/web/src/lib/api/*`、`lib/query/*` | 修改 | 新增合同、`TravelApi` 方法、HTTP 实现、`locationIntroductionKeys` 与 query hook。 |
| `apps/api/src/app.ts` | 修改 | 注册新的匿名 route，并把该精确路径加入认证豁免列表。 |
| `apps/api/src/routes/location-reference-rate-limit.ts` | 复用并泛化 | 复用进程内、哈希 IP 的限流模式；地点介绍使用独立 limiter，默认每 IP 每分钟 10 次。 |
| `apps/api/src/providers/model-gateway.ts`、`llm-gateway.ts`、`gateway-factory.ts` | 修改 | 在既有 ModelGateway 上新增独立 `generateLocationIntroduction` 方法；复用真实 provider、超时、trace、token 记录与安全输出校验。 |
| PostgreSQL / Drizzle / migrations | 新增 | 新建 `location_introduction_cache`、repository、短事务租约与过期接管逻辑。 |
| 私聊、SSE、Agent Worker、`agent_task_runs` | 不复用 | 介绍请求不持久化为用户对话，也不进入异步任务状态机。 |
| `LocationReferenceResolver` | 不作为身份来源 | 可继续为地图抽屉提供离线参考；不得把其自由坐标结果作为全局缓存键。 |

## 3. 组件与数据流

```text
ExploreMapPage（稳定 sourceId）
  → useLocationIntroduction(sourceId, locale)
  → POST /api/v1/explore/location-introductions
  → LocationIntroductionCatalog.resolve(sourceId)
  → LocationIntroductionCacheService.getOrStart()
      ├─ READY 且 expires_at > now：200 HIT
      ├─ 本请求取得 GENERATING 租约：LLM → READY → 200 MISS
      └─ 其他请求持有有效租约：202 GENERATING
  → 抽屉显示内容；202 时轮询同一请求
```

浏览器仅消费 location-reference 响应中的 `introductionSourceId`，不由地点名称、坐标或标签推断 ID；随后只发送该 `sourceId` 和 `locale`。模型只接收目录输出与语言，不接收用户、Trip、thread、Profile、私聊原文、原始坐标或当前时间。

## 4. 数据模型

新增表 `location_introduction_cache`。一次 migration 同时建立约束与索引。

| 列 | 类型/约束 | 说明 |
|---|---|---|
| `cache_key` | `varchar(64)` PK | `sha256(contentVersion + canonicalPlaceId + locale)` 的十六进制值。 |
| `canonical_place_id` | `varchar(128)` not null | 服务端目录的稳定 `sourceId`，非客户端任意地点。 |
| `locale` | `varchar(16)` not null | 仅 `en` 或 `zh`。 |
| `content_version` | `varchar(64)` not null | 初始值 `location-intro-v1`；prompt/安全语义改变时递增。 |
| `status` | enum `GENERATING | READY` | 只缓存成功结果；不持久化失败状态。 |
| `content` | `text` nullable | `READY` 时必填，限制为 60–120 字/等价简短文本，并由 Zod 校验。 |
| `generated_at` / `expires_at` | timestamptz | 生成成功时间与 `generated_at + 7 days`；过期内容绝不返回。 |
| `generation_lease_token` / `generation_lease_expires_at` | uuid / timestamptz | 默认 20 秒；到期后请求可接管。 |
| `model_name` / `prompt_version` | varchar nullable | 仅追溯，不进入缓存键。 |
| `created_at` / `updated_at` | timestamptz | 不记录用户身份或原始请求。 |

数据库约束：`READY` 必须有 `content`、`generated_at` 和合法 `expires_at`；`GENERATING` 必须有 lease token 和 lease expiry。唯一键为 `(canonical_place_id, locale, content_version)`；`cache_key` 为固定主键。

无需定时删除作正确性前提：查询只读取未过期 `READY` 行；过期行由下一次请求原子接管。可在后续运维清理中删除过期 30 天以上的记录，但该清理不是 MVP 上线前置条件。

## 5. 缓存并发与失败语义

`LocationIntroductionCacheService` 必须执行如下流程，且模型调用期间不得持有数据库事务：

1. `LocationIntroductionCatalog` 校验 `sourceId`；未知、失效或版本不匹配时返回 `400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE`。
2. 短事务查询该 key 的 `READY AND expires_at > NOW()` 行，命中立即返回 `HIT`。
3. 未命中时，在短事务内 insert 或条件 update 为 `GENERATING`。条件为不存在、已过期，或现有 generation lease 已到期；成功者获得新的 lease token。
4. lease owner 在事务外调用 `ModelGateway.generateLocationIntroduction`，并在短事务内以 `cache_key + generation_lease_token + status=GENERATING` 条件更新到 `READY`。
5. 未取得 lease 的请求重新读取一次；仍为 `GENERATING` 则返回 `202` 与 `retryAfterMs: 500`。客户端最多接收 8 次 `GENERATING`；随后显示可重试的不可用状态。
6. 上游超时、网络、5xx、schema 或政策失败时，lease owner 条件删除/释放 `GENERATING` 行；返回 `503 LOCATION_INTRODUCTION_UNAVAILABLE`。不得缓存错误、部分文本或安全拒答。
7. lease owner 每半个 lease 周期条件续租；任何 owner 在续租或写入前丢失 lease 都必须丢弃输出，不得覆盖新 owner 的结果。服务端生成使用独立 deadline，浏览器断连只取消观察请求，不取消有效 lease。

默认配置：`LOCATION_INTRODUCTION_TTL_SECONDS=604800`、`LOCATION_INTRODUCTION_GENERATION_LEASE_SECONDS=20`、`LOCATION_INTRODUCTION_RATE_LIMIT=10`、`LOCATION_INTRODUCTION_RATE_WINDOW_MS=60000`。实现时必须同步更新 `apps/api/.env.example`。

## 6. API 合同

### `POST /api/v1/explore/location-introductions`

该端点匿名可调用，且只能用于用户显式选择的地点。它独立于 `/explore/location-reference` 限流；两者均不接受或输出用户身份。

请求：

```json
{ "sourceId": "tokyo", "locale": "zh" }
```

`sourceId` 长度 1–128；`locale` 为 `en | zh`；请求 schema 为 strict。

`200`：

```json
{
  "status": "READY",
  "content": "...",
  "cacheStatus": "HIT",
  "expiresAt": "2026-09-04T12:00:00.000Z"
}
```

`202`：`{ "status": "GENERATING", "retryAfterMs": 500 }`

错误：`400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE`、`429 LOCATION_INTRODUCTION_RATE_LIMITED`、`503 LOCATION_INTRODUCTION_UNAVAILABLE`。错误体复用 `errorResponseSchema`；不得回显地点名称、坐标、缓存键、prompt 或 provider 错误正文。

## 7. LLM、内容与安全约束

新增 `LocationIntroductionInput` / `LocationIntroductionOutput` Zod schema 和专用 prompt。输出仅为 60–120 字/等价简短文本，必须为请求 locale。

禁止在 prompt 和最终 validator 中允许：实时价格、库存、航班/酒店可用性、签证/入境结论、天气、营业状态、预约/预订、法律/安全建议、来源不存在的具体时效事实。生成失败或安全校验失败时返回 `503`，而不是复用聊天的 `SAFE_REFUSAL`、空文本或 fixture。

LLM 调用沿用 `LLMGateway` 的 provider/model/prompt version、超时、有限 retry、`agent_runs` 哈希化结果记录、trace 和 token 统计。新增 skill/agent 标签使用稳定低基数值 `location.introduction` / `public-content`；不得在 log、metric label 或 span attribute 中记录 sourceId、地点名、坐标、缓存键或内容。

## 8. 前端行为

`ExploreMapPage` 仅在选中目录认可地点时启用介绍 query；`INSPIRATION`、无稳定 ID 或目录校验失败的地点维持现有地点参考/灵感展示，不调用介绍 API。

TanStack Query key 为 `['location-introductions', sourceId, locale]`。`200 READY` 的 `staleTime` 取响应 `expiresAt - now`；`202` 使用 500 ms 轮询；`503` 不自动无限重试，抽屉显示本地化的“暂时无法加载，请重试”。切换地点、关闭抽屉或组件卸载必须取消观察请求；取消浏览器请求不得取消服务端已取得的生成 lease。

介绍展示在现有地点说明之后、聊天 CTA 之前。它不写入聊天输入、不触发 `POST /explorations/start`、不替换现有离线位置参考提示，也不改变 pin 的 `REFERENCE` / `INSPIRATION` 语义。

## 9. 可观测性与审计

- `location_introduction_requests_total{outcome=hit|miss|generating|unsupported|rate_limited|unavailable}`
- `location_introduction_generation_duration_ms{outcome=success|failure}`
- `location_introduction_cache_entries{status=ready|generating}`（采集时聚合，不以地点区分）

为 catalog lookup、cache lookup/lease 与 LLM generation 建立 trace span；属性只能包含稳定值：`cache.outcome`、`content.version`、`llm.outcome`、HTTP route/status。复用 Pino correlation binding 和现有 redaction。该能力不写 `audit_events`：它没有用户授权、业务状态或不可逆动作；`agent_runs` 的安全运行记录已足以追溯模型调用。

## 10. 实施顺序与依赖

1. **合同和目录**：实现服务器版本化 `LocationIntroductionCatalog`，先写稳定 sourceId 校验单测；扩展 API/web Zod contracts、`TravelApi` interface 与 fake fixtures。
2. **持久化与并发**：添加 migration、Drizzle schema、repository 和 `LocationIntroductionCacheService`；覆盖 hit、expired takeover、并发 lease、lease loss、失败释放。
3. **模型边界**：扩展 ModelGateway/LLMGateway、独立 prompt、输出 validator、agent-run/trace/metric 记录；测试无私聊/Trip 输入和禁止时效声明。
4. **HTTP 边界**：新增 route、独立匿名 limiter、认证豁免、200/202/400/429/503 合同测试。
5. **前端**：query key/hook、HTTP client、抽屉状态与 i18n；确保不会创建探索 Trip 或聊天消息。
6. **集成与文档校验**：并发 API 测试、匿名访问测试、Map UI 测试、PII/高基数静态测试、更新 API/architecture/PRD/backlog/test scenarios，并运行仓库验证命令。

前置依赖是第一步的服务端目录。不得先以客户端 `sourceId` 或原始地图坐标构建缓存键。

## 11. 验收与回滚

发布必须满足 `TS-P2-LIC`：相同稳定地点和 locale 在有效期内只生成一次、过期后重新生成、并发请求不重复生成、灵感点不调用端点、匿名请求无业务状态写入、LLM 失败不缓存。

回滚方式：停止前端调用并从 API route 注销能力；缓存表可保留且不会影响行程、对话或授权状态。不得通过删除 `shared_trips`、聊天或其他业务表回滚。
