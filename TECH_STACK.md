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
        ├─ openrouteservice (Ground routing; optional live enhancement)
        ├─ Frankfurter (budget normalization; optional live enhancement)
        └─ official visa/readiness verification sources
```

所有用户、偏好和行程均来自已认证用户与数据库。唯一例外是匿名、无持久化、限流的离线地图位置参考：它不创建用户或业务状态。任何 provider 调用失败都必须显示不可用状态，不能伪装成实时库存、报价或签证结论。

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
| 身份 | **Amazon Cognito User Pool**，邮箱或手机号登录，API 验证 access token | 身份来自已验证 JWT 的 `sub`，前端不能通过用户 ID 或 demo 角色选择身份。生产使用 Cognito；本地仅允许显式 `local-dev`（固定单一身份 smoke test）或 `custom-local`（数据库用户名/密码和 API JWT，用于多用户隔离测试）。两者均仅限 development/test 与 server/client loopback。 | 复杂 SSO、社交登录矩阵、组织管理。 |
| 主数据库 | **Amazon RDS for PostgreSQL** + SQL migrations + Drizzle ORM | 需要事务、关系约束、审计和版本一致性：Profile、用户私有对话、字段级 consent、两个出发地、候选方案、三人确认和 callback 去重必须共享一个权威真相源。RDS PostgreSQL 支持 VPC、SSL、快照与时间点恢复。[AWS RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) | SQLite 作为云端主库、NoSQL 作为业务真相。 |
| Agent | **受限 Skill Registry + ModelGateway**，运行在 App Runner | 模型只能通过服务器暴露的、类型化 function-tool 契约请求能力；具体 LLM 为可配置的 OpenAI-compatible provider。SDK 不是授权、确认或持久状态机。 | 让模型直接读写数据库、付款或自由互聊的多 Agent 群。 |
| 工具与模型边界 | Zod schema、structured outputs、server-side policy gate | 对话 archive 仅由所有者读取；所有工具只获得当前 `constraint_snapshot` 的最小授权字段。模型发起 Tool 调用，服务端校验参数、执行 provider 请求并决定完整性；模型输出不直接成为业务真相。 | 把 Profile/私聊全文放进长 prompt、共享 snapshot、遥测或向前端暴露供应商 key。 |
| 旅行与数据 API | Amadeus Self-Service Flight Offers Search、openrouteservice Routing、Frankfurter；通过 provider adapters；版本化离线地图位置参考数据 | Flight adapter 仅在服务端启用并以 `UNAVAILABLE` fail closed；Amadeus Test 仅用于开发集成验证，不向产品展示为实时结果。唯一匿名端点按每客户端每分钟 30 次限流，仅将用户显式点击的坐标映射为非权威国家/最近城市上下文，不成为旅行事实或持久化数据。 | 现在接 Activities、POI、Weather、Calendar、Nager.Holidays 或多个 OTA；地图位置参考不得变成地址、POI 或旅行 provider。 |
| Visa / entry | 官方核验下一步；未来可接 Sherpa/IATA Timatic adapter | 未配置可靠数据源时只展示核验缺口与官方核验下一步。 | 以 LLM 或 Wikipedia 推断签证、代办、法律结论。 |
| 异步与编排 | PostgreSQL 持久任务状态机、租约领取、idempotency key、transactional outbox、`agent_task_runs`；Fargate Worker；同步 booking sandbox | 对话、planning 与 replan 都以 `QUEUED → RUNNING → COMPLETED/FAILED/STALE/CANCELLED` 执行；显式 Stop 是唯一取消源。租约过期可恢复，最终提交按 lease token 和版本条件化；不把 partial 文本作为业务记录。 | Temporal Cloud、Step Functions、Redis 队列同时进入 MVP；把浏览器/SSE 断开视为取消。 |
| 可观测性 | OpenTelemetry + CloudWatch；结构化日志和低基数业务指标 | 以 `trip_id`、`plan_version`、`run_id`、`orchestration_request_id` 关联结果；日志不含私聊、国籍明文、证件号、支付数据。 | 先建独立数据湖或全套企业 APM。 |
| 密钥与部署 | AWS Secrets Manager、最小 IAM role、ECR、GitHub Actions OIDC、IaC | API keys 仅后端可读；GitHub OIDC 避免在 CI 保存长期 AWS 凭据。[GitHub OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers) | 将 API key、数据库密码或 Cognito secret 放进浏览器、代码库或 demo fixture。 |

### 探索会话与 Draft Trip 生命周期

`/home` 进入只创建浏览器内存中的探索会话，不立即写数据库；地图浏览、坐标点击和打开聊天均不持久化业务状态。用户提交第一条聊天消息时，Fastify 通过幂等、单事务的 `POST /explorations/start` 创建 `DRAFT` Trip、创建者 membership 与默认私有 thread，随后浏览器调用既有 thread turn endpoint。每次新标签页、整页刷新或重新打开开始新的内存会话；同一标签页内客户端路由切换保留该会话。不得使用 URL、`localStorage` 或 `sessionStorage` 恢复当前探索 Trip。

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

### 必须存在的领域数据

`user_profile`、`preference_fact`、`private_conversation`、`private_message`、`shared_trip`、`trip_member`、`consent_grant`、`constraint_snapshot`、`destination_candidate`、`itinerary_plan`、`plan_version`、`member_confirmation`、`visa_readiness_check`、`source_evidence`、`provider_offer`、`booking_execution`、`idempotency_record`、`audit_event`、`outbox_event`。

必须由数据库或服务端规则保证：

1. 所有候选的工具请求使用同一 `constraint_snapshot`。
2. 授权撤回或约束变化会使依赖它的 plan 和 confirmations 进入 `STALE`。
3. 只有三个 required members 对同一最新 plan version 为 `CONFIRMED` 才能创建 `booking_execution`。
4. `orchestration_request_id` 和 provider callback id 全局幂等。
5. 每个价格、路线和 visa 输出有 `source` 与 `captured_at`；报价额外带 `expires_at`。无可验证数据只返回 `UNAVAILABLE`。
6. 每个 `private_conversation` 仅属于一个用户，使用独立 `conversation_id`，可选关联一个 `trip_id`；消息正文不进入 snapshot、共享视图、日志、trace 或 metric，删除线程时删除正文。

## 5. API 取舍与不可用语义

| 能力 | 选择 | MVP 行为 | 风险与缓解 |
|---|---|---|---|
| Flight | Amadeus Self-Service Flight Offers Search adapter | 每个目的地候选仅使用可验证的 provider 查询结果；Test 环境只用于开发验证，生产展示仅使用 Production 查询结果；失败则返回 `UNAVAILABLE` | 供应商覆盖、商业条款、报价过期和模型 Tool-calling 兼容性必须在启用前验证。 |
| Ground | 配置后的路由 adapter | 仅在完整端点和来源可验证时生成路线 | 公共服务有使用上限和 attribution 要求。 |
| Budget | Frankfurter adapter | 归一化候选总预算；显示汇率日期与“参考汇率” | 不能被当作支付或结算汇率；API 不可用时显示不可用。 |
| Visa readiness | 官方核验下一步 | 对每名授权成员、每个展示候选给出待办/核验缺口 | 没有可靠数据源前不得宣称实时正确或给法律建议。 |
| Map relief | [GEBCO WMS](https://www.gebco.net/data-products/gebco-web-services/web-map-service) | `GEBCO_LATEST` shaded relief 作为不透明全球海陆纹理；OpenFreeMap 矢量细节覆盖其上 | 公共服务无 SLA；失败时回退 Liberty Natural Earth；保留 attribution，并显示/记录“不用于航海”边界。 |

**明确延期：** Amadeus Activities、Open-Meteo、openrouteservice POI/Overpass、Wikimedia、Nager.Holidays、Google Calendar。它们不能帮助完成当前的授权、候选比较、replan 与三人确认闭环。Google Calendar 尤其会增加 OAuth 和隐私风险；以后如做，仅从最小 `freebusy` 权限开始。[Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

## 6. AWS 与 OpenAI 的关系

### 当前决定

- 应用前端、API、数据库、密钥和可观测性部署在 AWS。
- `ModelGateway` 通过 OpenAI-compatible Tool-calling 契约调用已配置模型；密钥存于 Secrets Manager。
- `flight.search` 由模型请求、服务器执行；每种 LLM provider 必须先通过 function-tool compatibility spike。
- 不在 MVP 强行引入 Bedrock AgentCore、Bedrock Agents 或 Bedrock 模型。

AWS AgentCore 的确支持多种框架，但这只能说明它是将来的可选运行环境，并不证明本次赛事必须用它；当前方案不以任何特定 Agent SDK 为运行时依赖。[AWS AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/using-any-agent-framework.html)

### 防止 provider lock-in

`ModelGateway` 对上提供结构化生成和受限 Tool-calling 能力，对下隐藏 OpenAI-compatible LLM 的差异。`TravelProvider` 对上提供 `searchFlights()`、`searchStays()`、`routeGround()`、`checkReadiness()`，隐藏 Amadeus/openrouteservice 的返回格式。

这不是为多云做抽象秀：它保护两个已知的真实变化点——hackathon live API 可能失效，后续模型/赛事限制可能变化。

## 7. MVP 与未来阶段

| 维度 | Hackathon MVP | Pilot / 未来 |
|---|---|---|
| 用户与路线 | 三个 seed 用户、两个出发地、两到三个预设目的地、至少两国籍 | 真实注册用户、可配置城市和更广覆盖 |
| 数据 | 已配置 provider 的可验证结果；失败明确 `UNAVAILABLE` | 正式供应商合同、SLAs、监控与多 provider routing |
| 工作流 | 数据库状态机 + 同步 booking sandbox | Step Functions Standard 或 Temporal，用于长等待、真实 callback、补偿和人工处理 |
| 支付与订单 | 无支付；sandbox reference | 在 merchant-of-record、退款、PCI、客服责任明确后才接支付与真实订单 |
| 签证 | 来源化 checklist / official verification CTA | 商业签证数据 provider、审计、法律/产品评审；仍不承诺批准 |
| 前端 | Web/PWA，轮询/SSE | React Native 仅在移动端使用证据成立后；推送与离线能力按需增加 |
| AWS | Amplify + App Runner + RDS + Cognito + CloudWatch | VPC hardening、WAF、Multi-AZ、灾备、队列/工作流、成本与告警治理 |

## 8. 不做与风险控制

**不做：** SQLite 主库、自动扣款、真实支付、真实签证代办、原生群聊、群聊截图导入、全球目的地搜索、多个实时 OTA、原生 App、Redis/Temporal/Step Functions 同时引入。

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
