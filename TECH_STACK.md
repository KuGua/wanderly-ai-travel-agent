# AI Travel Agent 技术栈（Hackathon 收敛版）

**状态：** 真实身份与服务端模型是唯一运行路径；旅行 provider 尚待配置。无可验证的 provider 数据时，系统返回 `UNAVAILABLE`，绝不生成替代报价、库存或 Demo data。

**基线：** 2026-08-23

## 1. 决策摘要

本项目的优先级是 **Hackathon 稳定 Hero Journey > 生产级覆盖度**。最终方案部署到 AWS，但赛事原话只说明“solutions to AWS”，**不构成必须使用 Bedrock 原生 Agent、Bedrock 模型或全套 AWS 专有组件的证据**。

推荐的 MVP 基线：

```text
Responsive Web / PWA (Next.js on AWS Amplify Hosting)
        │
        ▼
Node.js API + Agent runner (AWS App Runner)
        │                 │
        │                 ├─ ModelGateway → configured OpenAI-compatible LLM
        │                 └─ typed provider adapters
        ▼
Amazon RDS for PostgreSQL
        │
        ├─ Amadeus Self-Service Flight Offers Search (adapter; server-side only)
        ├─ Viator Experiences MCP (Activities adapter; server-side only)
        ├─ openrouteservice (Ground routing; optional live enhancement)
        ├─ Frankfurter (budget normalization; optional live enhancement)
        └─ Sherpa Requirements API adapter（签约/验证后）→ official verification CTA
```

所有用户、偏好和行程均来自已认证用户与数据库。匿名例外仅限用户显式触发的离线地图位置参考，以及只读、共享的稳定地点介绍：两者不创建用户或业务状态；地点介绍仅持久化非个性化缓存条目。任何 provider 调用失败都必须显示不可用状态，不能伪装成实时库存、报价或签证结论。

## 2. 各层技术选择

| 层 | MVP 选择 | 为什么适合当前范围 | 明确不做 |
|---|---|---|---|
| 客户端 | **Next.js + React + TypeScript**，部署到 **AWS Amplify Hosting** | 浏览器链接最适合三人邀请、独立授权、共同查看、投屏与移动端访问。Amplify 支持 Next.js SSR 部署。[AWS Amplify](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html) | 原生 iOS/Android App、应用商店发布、离线协作。 |
| UI | Tailwind CSS + shadcn/ui/Radix；响应式 PWA | 快速构建 Profile、私有对话 archive、授权抽屉、候选比较、replan diff、个人待办与三人确认队列。 | 复杂地图编辑器、原生群聊、设计系统平台化。 |
| 探索地图 | MapLibre globe + OpenFreeMap Liberty；GEBCO WMS shaded relief；Natural Earth 10m 派生的本地多级共享边界 mesh + 本地九段线与地名覆盖层 | OpenFreeMap 提供道路与行政区；GEBCO 提供 public-domain 的不透明全球陆地/海底地势；构建期由单一 Natural Earth topology 生成按 zoom 懒加载的 SVG 边界，九段线是独立的版本化本地显示线；标签按球面相机投影显示洲、国家、首都/主要城市和省州，不依赖 MapLibre globe 的 symbol worker。 | 不把地图像素或显示标签当作路线、地点解析、签证、价格或可预订事实；不在浏览器或标签构建中调用 DataV；GEBCO 不用于航海或安全判断。 |
| 前端状态 | **TanStack Query** 管理服务器状态；React Hook Form + Zod 管理表单草稿；仅在必要时以 Zustand 保存局部 UI 状态 | Profile、consent、plan 和 confirmation 都以服务端版本为准。避免 Redux 或客户端复制业务真相。 | 全局客户端 store 作为授权/订单真相。 |
| 数据获取与状态刷新 | REST/JSON + OpenAPI；`POST` 创建持久 Agent task 并返回 `202`；鉴权 `fetch` SSE 仅订阅安全进度/文本 | API 与浏览器断开不会影响已接受任务；SSE 是可丢失显示通道，用户返回后以服务端 task 状态和最终结果恢复。对话文本仅在流式安全 gate 后增量显示；planning/replan 仅发送安全阶段和已持久化结果状态。 | 为 MVP 自建 WebSocket 事件总线、用原生 `EventSource` 承担 Bearer 鉴权、由连接生命周期控制任务取消。 |
| API / Agent runner | **Node.js LTS + TypeScript + Fastify**（AWS App Runner）+ **ECS Fargate Agent Worker** | API 负责认证、命令与结果读取；独立 Worker 通过 PostgreSQL 租约执行任务，能跨 API 断连、滚动发布和实例替换恢复。Worker 可多副本并发，正确性不依赖 `desiredCount=1`。 | Lambda 链式编排、微服务网格、多个自由 Agent 服务。 |
| 离线地图位置参考 | 进程内 `LocationReferenceResolver`（生产默认）/ `disabled` 模式（仅返回 `NO_REFERENCE`）/ 本地 dev 可选 `sidecar` 容器（`apps/api/src/location-reference/location-reference-source.ts`） | 生产保留单进程以降低 RPS 内存与跨实例限流复杂度；本地 dev 通过 `LOCATION_REFERENCE_MODE=sidecar` 把 ~70 MB GeoJSON 抽到独立容器，避免 API/Worker 重复加载；`disabled` 模式跳过数据加载直接返回 `NO_REFERENCE`，用于 16GB Mac 端到端 demo | 把位置参考改为共享 Redis 缓存、把 sidecar 推到生产、把 `disabled` 当作"零成本"代替 fixture。 |
| 地点介绍共享缓存 | PostgreSQL `location_introduction_cache` + 服务端版本化地点目录 + `ModelGateway` 专用生成方法；浏览器用 TanStack Query 短缓存 | 对稳定 `sourceId` 与 `en`/`zh` 内容版本提供 7 天跨用户复用、数据库租约防击穿和可控失效；复用现有真实模型、trace、指标与安全输出边界，不写入私聊或 Trip 状态 | Redis/ElastiCache、客户端以任意坐标或名称为共享键、把介绍作为实时旅行/签证/价格事实。 |
| 身份 | **Amazon Cognito User Pool**，邮箱或手机号登录，API 验证 access token | 身份来自已验证 JWT 的 `sub`，前端不能通过用户 ID 或 demo 角色选择身份。生产使用 Cognito；本地仅允许显式 `local-dev`（固定单一身份 smoke test）或 `custom-local`（数据库用户名/密码和 API JWT，用于多用户隔离测试）。两者均仅限 development/test 与 server/client loopback。 | 复杂 SSO、社交登录矩阵、组织管理。 |
| 主数据库 | **Amazon RDS for PostgreSQL** + SQL migrations + Drizzle ORM | 需要事务、关系约束、审计和版本一致性：Profile、用户私有对话、字段级 consent、两个出发地、候选方案、三人确认和 callback 去重必须共享一个权威真相源。RDS PostgreSQL 支持 VPC、SSL、快照与时间点恢复。[AWS RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) | SQLite 作为云端主库、NoSQL 作为业务真相。 |
| Agent | **受限 Skill Registry + ModelGateway**，运行在 App Runner | 模型只能通过服务器暴露的、类型化 function-tool 契约请求能力；具体 LLM 为可配置的 OpenAI-compatible provider。SDK 不是授权、确认或持久状态机。 | 让模型直接读写数据库、付款或自由互聊的多 Agent 群。 |
| 长期记忆 | **PostgreSQL 中结构化、版本化的个人事实 + 当前 Trip 记忆投影** | 复用 `user_profiles`、`preference_facts`、字段级 consent、不可变 `constraint_snapshot` 和 stale/replan 控制面。低风险行为只能形成待确认的建议；个人事实默认私有，Shared Agent 只消费当前 Trip 的最小授权投影。 | 向量库、embedding、RAG、独立 memory service、跨 Trip Team memory、从私聊或敏感字段自动写入长期记忆。 |
| 工具与模型边界 | Zod schema、structured outputs、server-side policy gate、受限 thread context builder | 对话 archive 仅由所有者读取。Personal Agent 仅可由服务端从同一 owner 的同一私有 thread 构造最近、有预算的原文上下文；该上下文只发送给已配置模型 provider，不进入共享 snapshot、Profile、日志、trace、audit、metric 或客户端持久状态。原文窗口受 `CONVERSATION_CONTEXT_MAX_TURNS`（默认 8 完整轮次，上限 12）和 `CONVERSATION_CONTEXT_MAX_CHARS`（默认 12,000 UTF-16 字符，上限 20,000）双重预算限制，并以 task acceptance 时记录的 `agent_task_runs.context_max_message_sequence` 为不可回写上界。所有共享工具只获得当前 `constraint_snapshot` 的最小授权字段。模型输出不直接成为业务真相。 | 将整段私聊、其他 thread 或共享/未授权数据放进 prompt；由浏览器提交 history；向量库、Redis 或独立 memory service；自动摘要 worker；tokenizer/embedding；向遥测或前端暴露供应商 key。 |
| 客户端 | **Next.js + React + TypeScript**，部署到 **AWS Amplify Hosting** | 浏览器链接最适合三人邀请、独立授权、共同查看、投屏与移动端访问。Amplify 支持 Next.js SSR 部署。[AWS Amplify](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html) | 原生 iOS/Android App、应用商店发布、离线协作。 |
| 旅行与数据 API | Amadeus Self-Service Flight Offers Search、Viator Experiences MCP、Amadeus Transfer Search；Booking.com Demand Accommodation Search/Look（取得 production 准入后）；openrouteservice Place/POI 与 Directions；Frankfurter；通过 typed provider adapters | Flight、Activities、Hotel 保持独立 port。Activities 通过公开 MCP 做只读发现，无 API key，且不展示无币种价格或 click-off link；Hotel 首期仅在 Shared PLAN/REPLAN 中以 snapshot/run-bound `hotel.search` 进行实时搜索和方案比较，模型只可传 `destinationId`，日期、房间/住客数、币种和偏好由服务端推导。Ground 分为 `PlaceResolver`、`NavigationProvider`、`TransitJourneyProvider`、`MobilityOfferProvider`，关键词 POI 候选和路线均由 server-owned TripPlace/run context 解析。任何缺失或不可信 provider 都返回 `UNAVAILABLE`，task 安全完成为 `COMPLETED_WITH_GAPS`，不伪造数据；sandbox/fixture 只用于测试。 | 浏览器直连 provider、将 sandbox 当实时库存、供应商 deep link/订单/支付、自动 booking；Viator MCP 没有公布配额/SLA，不应被宣传为稳定库存或预订能力；公共交通实时和租车在 provider/商业条款 spike 前不承诺覆盖。 |
| Visa / entry | `VisaProvider` typed adapter；首选 Sherpa Requirements API（签约/验证后） | 全球覆盖采用两阶段：候选阶段仅核验目的地；选定具体航班后按完整中转航段核验。未配置、过期或失败时只显示 `UNAVAILABLE`/官方核验下一步。国籍只从当前授权 snapshot 在服务端使用；详情仅本人可见。 | RAG、规则网页抓取、浏览器直连 widget/API、LLM/Wikipedia 推断签证、代办、法律结论。 |
| 异步与编排 | PostgreSQL 持久任务状态机、租约领取、idempotency key、transactional outbox、`agent_task_runs`；Fargate Worker；同步 booking sandbox | 对话、planning 与 replan 都以 `QUEUED → RUNNING → COMPLETED/FAILED/STALE/CANCELLED` 执行；显式 Stop 是唯一取消源。租约过期可恢复，最终提交按 lease token 和版本条件化；不把 partial 文本作为业务记录。 | Temporal Cloud、Step Functions、Redis 队列同时进入 MVP；把浏览器/SSE 断开视为取消。 |
| 可观测性 | OpenTelemetry + CloudWatch；结构化日志和低基数业务指标 | 以 `trip_id`、`plan_version`、`run_id`、`orchestration_request_id` 关联结果；日志不含私聊、国籍明文、证件号、支付数据。 | 先建独立数据湖或全套企业 APM。 |
| 密钥与部署 | AWS Secrets Manager、最小 IAM role、ECR、GitHub Actions OIDC、IaC | API keys 仅后端可读；GitHub OIDC 避免在 CI 保存长期 AWS 凭据。[GitHub OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers) | 将 API key、数据库密码或 Cognito secret 放进浏览器、代码库或 demo fixture。 |

### 探索会话与 Draft Trip 生命周期

`/home` 进入只创建浏览器内存中的探索会话，不立即写数据库；地图浏览、坐标点击和打开聊天均不持久化业务状态。稳定地点点击可读取或刷新全局、非个性化的地点介绍缓存，但不得创建任何用户、Trip、thread、message、授权或审计业务记录。用户提交第一条聊天消息时，Fastify 通过幂等、单事务的 `POST /explorations/start` 创建 `DRAFT` Trip、创建者 membership 与默认私有 thread，随后浏览器调用既有 thread turn endpoint。每次新标签页、整页刷新或重新打开开始新的内存会话；同一标签页内客户端路由切换保留该会话。不得使用 URL、`localStorage` 或 `sessionStorage` 恢复当前探索 Trip。地点介绍的完整实施契约见 [地点介绍共享缓存实施方案](docs/location-introduction-cache-implementation.md)。

`DRAFT` 仅允许私有探索对话与编辑 brief，不能邀请、授权、创建 snapshot、planning/replan、确认或 booking。只有 creator 显式“开始规划/邀请同行者”且 brief 满足正式约束后，服务端才将其激活为 `PLANNING`。实现细节见 [探索会话与 Trip 生命周期实施方案](docs/exploration-trip-lifecycle-implementation.md)。

## 3. 为什么不用 SQLite 作主数据库

SQLite 适合本地开发、单进程测试和 fixture，但不承担云端主库。当前 Hero 至少要求：三名彼此隔离的用户、可撤回字段级授权、不可变约束快照、计划失效、三人确认、callback 幂等和审计。将 SQLite 放在 App Runner 容器内会遇到无状态磁盘、并发写入、横向扩容、备份恢复与数据层权限的风险。

因此：

- **本地开发/测试：** 可以使用 SQLite 或临时 PostgreSQL。
- **部署的 Hero Demo 与后续 Pilot：** 使用 RDS PostgreSQL。
- **SQLite 不承担：** consent、plan version、confirmation、booking sandbox callback 的权威记录。

## 4. Agent、授权和业务状态的边界

### 一个受约束的 Trip Orchestrator，而非自由多 Agent

产品叙事中的 Personal Agent 与 Shared Trip Agent 保留，但运行时只需一个受控的 `TripOrchestrator` 和类型化工具：

1. 读取三名成员明确保存的 Profile 与本次输入；
2. 服务端按 consent 创建不可变 `constraint_snapshot`；
3. 为两到三个目的地候选调用 Flight、Stay、Ground、Visa 工具；
4. 输出 schema 校验后的候选比较与解释；
5. 变化后创建新 snapshot、作废旧 plan/confirmations，生成 diff；
6. 仅在三名 required members 确认同一未过期 plan version 后调用 sandbox。

Agent 不能自行跨越以下边界：

- 不能查看未授权 Profile、私聊或历史反馈；
- 不能推断未授权国籍；
- 不能把 provider 返回值当作永久真相；
- 不能自动扣款、自动预订或绕过任一成员确认。

酒店住宿的确认实施契约见 [酒店实时搜索与方案比较实施方案](docs/hotel-search-tool-implementation.md)：首期仅搜索与比较，不能创建供应商订单、支付或跳转预订；税费不完整时必须展示“可能另计”。

### Team Agent 结构化交接与方案采用

Personal Agent 只能把私有输入转化为 owner 确认的、字段目录允许的 Trip constraint proposal；不能向 Shared Agent 发送原文消息、自动确认或自动共享。确认的事实是当前 Trip 的 `TEAM_VISIBLE` 或 `ORCHESTRATOR_CONFIDENTIAL` 约束，并带 `HARD`/`SOFT` 强度。前者向所有 active members 与 Shared Agent 展示；后者只进入服务端 snapshot projection 和本次 Shared planning prompt，不出现在其他成员的 API/UI、plan explanation 或遥测。它仍可能从方案结果被间接推断，确认 UI 必须提示该限制。

任一 projection 源变化须在同一事务中将旧 ACTIVE plan 与 confirmations 标记为 `STALE` 并自动 enqueue `REPLAN`。新 run 只能生成 `PROPOSED` plan；全体 required members 投票 `ACCEPT` 后才能成为 `ACTIVE`。任一 `NEEDS_CHANGES` 阻止采用。旧方案仅供比较，永不恢复为可确认或可预订状态；`ACTIVE` 后仍须通过既有全员 booking confirmation。完整实施契约见 [Team Agent 协作编排实施规范](docs/team-agent-orchestration-implementation.md)。

### 必须存在的领域数据

`user_profile`、`preference_fact`、`memory_proposal`、`trip_constraint_proposal`、`trip_constraint_fact`、`private_conversation`、`private_message`、`shared_trip`、`trip_member`、`consent_grant`、`constraint_snapshot`、`destination_candidate`、`itinerary_plan`、`plan_adoption_vote`、`member_confirmation`、`visa_readiness_check`、`source_evidence`、`provider_offer`、`booking_execution`、`idempotency_record`、`audit_event`、`outbox_event`。Team Agent 交接与长期记忆实施细节见 [Team Agent 协作编排实施规范](docs/team-agent-orchestration-implementation.md) 与 [长期记忆实施方案](docs/long-term-memory-implementation.md)。

必须由数据库或服务端规则保证：

1. 所有候选的工具请求使用同一 `constraint_snapshot`。
2. 授权撤回或约束变化会使依赖它的 plan 和 confirmations 进入 `STALE`。
3. 只有三个 required members 对同一最新 plan version 为 `CONFIRMED` 才能创建 `booking_execution`。
4. `orchestration_request_id` 和 provider callback id 全局幂等。
5. 每个价格、路线和 visa 输出有 `source` 与 `captured_at`；报价额外带 `expires_at`。无可验证数据只返回 `UNAVAILABLE`。
6. 每个 `private_conversation` 仅属于一个用户，使用独立 `conversation_id`，可选关联一个 `trip_id`；消息正文不进入 snapshot、共享视图、日志、trace、metric 或 audit。仅在该 owner 对同一 thread 发起 Personal Agent turn 时，服务端可在固定轮次和上下文预算内将原文窗口发送给已配置的模型 provider；删除线程时删除正文。
7. 个人长期事实只能由用户表单编辑或用户确认的提案写入；低风险行为聚合只可创建待确认提案。国籍、旅行证件、出生日期、健康或无障碍信息不得从对话或行为自动提取。
8. Shared Agent 不得直读个人记忆表；它只能读取当前 Trip、当前授权、当前版本的 memory projection。个人事实、Trip memory 或授权变化必须使依赖 plan 和 confirmations 进入 `STALE`。
9. `ORCHESTRATOR_CONFIDENTIAL` projection 只能被 Shared planning Worker 的内部 prompt 使用；公开 plan DTO、explanation、SSE、audit、log、trace 与 metrics 必须经过禁止该 projection 的确定性校验。
10. `PROPOSED` plan 的 adoption vote 与 `ACTIVE` plan 的 booking confirmation 是不同状态机；sandbox 只接受最新、未过期、全员确认的 ACTIVE version。

## 5. API 取舍与不可用语义

| 能力 | 选择 | MVP 行为 | 风险与缓解 |
|---|---|---|---|
| Flight | Amadeus Self-Service Flight Offers Search adapter | 每个目的地候选仅使用可验证的 provider 查询结果；Test 环境只用于开发验证，生产展示仅使用 Production 查询结果；失败则返回 `UNAVAILABLE` | 供应商覆盖、商业条款、报价过期和模型 Tool-calling 兼容性必须在启用前验证。 |
| Activities | Viator 官方 Experiences MCP adapter | Shared Agent 可在 PLAN/REPLAN durable task 内为 snapshot 中每个候选目的地调用 provider-neutral `activities.search`。服务端注入 snapshot/run/date authority，adapter 严格验证 MCP 响应并丢弃 click-off link 与无币种 `fromPrice`。失败、超时、限流、空数据或 schema drift 返回 `UNAVAILABLE`，不以 fixture 或模型内容替代。Personal Tool-loop 暂缓，直到 owner-scoped streaming tool boundary 单独实施。 | 公开 MCP 当前无需 key，但未公布固定配额或 SLA；默认 feature flag 关闭。协议/字段漂移必须 fail closed，并以 adapter contract test 监控。 |
| Ground place/navigation | openrouteservice Geocoding/POI + Directions；`TripPlace` server-owned reference | Shared Agent 可受限关键词搜索并在两个已授权 POI 之间生成步行/驾车/骑行路线；显示 geometry、距离、时长、步骤、source/captured_at 与归因。缺失仅形成 gap，不阻断其他 research。 | 全球查询不等于全球覆盖或实时交通；关键词、名称、地址、坐标和 geometry 是受保护 Trip 数据，不进 telemetry。 |
| Ground commercial mobility | Amadeus Transfer Search adapter（可选启用） | 可显示 taxi、接送、包车等真实报价或估价及其来源/有效期；不下单、不透传 booking link。 | 租车、公共交通实时和全球商业覆盖必须由独立 port/provider 验证；不能从 ORS 路线推导价格或班次。 |
| Budget | Frankfurter adapter | 归一化候选总预算；显示汇率日期与“参考汇率” | 不能被当作支付或结算汇率；API 不可用时显示不可用。 |
| Visa readiness | `VisaProvider`；Sherpa Requirements API 为首选接入目标 | 候选比较对每名授权成员/目的地运行 destination-level readiness，并明确“选定航班后再完成过境核验”；用户选择有效 flight offer 后，按实际 destination/transit airport route 运行 route-level readiness。 | provider 合同、覆盖、DPA、生产凭据与 SLA 未验证前保持 `disabled`/`UNAVAILABLE`；不得声称实时正确、可入境或给法律建议。 |
| Map relief | [GEBCO WMS](https://www.gebco.net/data-products/gebco-web-services/web-map-service) | `GEBCO_LATEST` shaded relief 作为不透明全球海陆纹理；OpenFreeMap 矢量细节覆盖其上 | 公共服务无 SLA；失败时回退 Liberty Natural Earth；保留 attribution，并显示/记录“不用于航海”边界。 |

**明确延期：** Open-Meteo、Overpass/Wikimedia、Nager.Holidays、第二个 POI/路线 provider、公共交通实时 provider、租车 provider、Google Calendar。ORS Place/POI、Directions 与 Amadeus Transfer Search 由本规范定义为受控首期能力；其他 provider 必须单独验证覆盖、许可、归因、限流与隐私边界后接入。Google Calendar 尤其会增加 OAuth 和隐私风险；以后如做，仅从最小 `freebusy` 权限开始。[Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

地面出行的模块、数据、状态与测试级实施契约见 [全球 POI 与地面出行实施规范](docs/ground-mobility-implementation.md)。

签证 readiness 的 provider、隐私、两阶段状态机、接口和实施顺序见 [全球签证与入境 Readiness 实施规范](docs/visa-readiness-implementation.md)。

## 6. AWS 与 OpenAI 的关系

### 当前决定

- 应用前端、API、数据库、密钥和可观测性部署在 AWS。
- `ModelGateway` 通过 OpenAI-compatible Tool-calling 契约调用已配置模型；密钥存于 Secrets Manager。
- `flight.search` 由模型请求、服务器执行；每种 LLM provider 必须先通过 function-tool compatibility spike。
- 不在 MVP 强行引入 Bedrock AgentCore、Bedrock Agents 或 Bedrock 模型。

AWS AgentCore 的确支持多种框架，但这只能说明它是将来的可选运行环境，并不证明本次赛事必须用它；当前方案不以任何特定 Agent SDK 为运行时依赖。[AWS AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/using-any-agent-framework.html)

### 防止 provider lock-in

`ModelGateway` 对上提供结构化生成和受限 Tool-calling 能力，对下隐藏 OpenAI-compatible LLM 的差异。provider 层按语义提供 `FlightProvider`、`ActivitiesProvider`、`PlaceResolver`、`NavigationProvider`、`TransitJourneyProvider`、`MobilityOfferProvider` 与 readiness port；`GroundCapabilityRouter` 在服务端固定选择 provider，adapter 隐藏 Amadeus、Viator MCP 与 openrouteservice 的返回格式。

这不是为多云做抽象秀：它保护两个已知的真实变化点——hackathon live API 可能失效，后续模型/赛事限制可能变化。

## 7. MVP 与未来阶段

| 维度 | Hackathon MVP | Pilot / 未来 |
|---|---|---|
| 用户与路线 | 三个 seed 用户、两个出发地、两到三个预设目的地；每个目的地下支持 LLM 关键词 POI 搜索和已授权 POI 间路线 | 真实注册用户、更多 provider 与受验证的实时 transit/rental 覆盖 |
| 数据 | 已配置 provider 的可验证结果；失败明确 `UNAVAILABLE` | 正式供应商合同、SLAs、监控与多 provider routing |
| 工作流 | 数据库状态机 + 同步 booking sandbox | Step Functions Standard 或 Temporal，用于长等待、真实 callback、补偿和人工处理 |
| 支付与订单 | 无支付；sandbox reference | 在 merchant-of-record、退款、PCI、客服责任明确后才接支付与真实订单 |
| 签证 | 来源化 checklist / official verification CTA | 商业签证数据 provider、审计、法律/产品评审；仍不承诺批准 |
| 前端 | Web/PWA，轮询/SSE | React Native 仅在移动端使用证据成立后；推送与离线能力按需增加 |
| AWS | Amplify + App Runner + RDS + Cognito + CloudWatch | VPC hardening、WAF、Multi-AZ、灾备、队列/工作流、成本与告警治理 |

## 8. 不做与风险控制

**不做：** SQLite 主库、自动扣款、真实支付、真实签证代办、原生群聊、群聊截图导入、浏览器或模型自由坐标/provider 调用、多个实时 OTA、原生 App、Redis/Temporal/Step Functions 同时引入。全球 POI 查询和路线不构成全球实时 transit、租车或商业库存承诺。

**最高风险与最小控制：**

| 风险 | 最小控制 |
|---|---|
| live API 不稳定 | 受控 `UNAVAILABLE` 状态、恢复操作和失败遥测；不创建 plan 或替代报价。 |
| 三人多约束导致 demo 拖沓 | 预置 Profile、两出发地、最多三个候选、一个确定性变化事件；不允许自由目的地搜索。 |
| 未授权信息泄露 | 服务器创建最小授权 snapshot；共享页面只读取其字段；测试跨用户读取与授权撤回。 |
| LLM 或 AWS 服务变更 | ModelGateway；API/部署和 OpenAI-compatible provider 分离。 |
| 重复 callback / 重复 sandbox | plan version + idempotency key；三人确认是执行前硬门槛。 |

## 9. 实现前仅需验证的事项

1. 取得赛事规则原文，确认 “部署到 AWS” 是否要求特定 AWS 服务或区域。
2. 确定 Hero 的两个出发地、两到三个目的地候选、三位测试用户和至少两种国籍；将测试数据限制在 test-only 依赖注入路径。
3. 对该固定场景试跑 Amadeus Test，验证认证、IATA 路线、限流和返回字段；Test 结果不进入产品运行路径。
4. 对目标 OpenAI-compatible LLM 完成 function-tool compatibility spike，确认多轮 tool loop、schema、超时、取消和错误处理；失败时保持服务器检索 + 模型解释，不启用自主 Tool 调用。

在以上验证通过前，不应将平台宣传为真实库存、实时签证判断或可实际购票的生产 OTA。
