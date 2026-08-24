# AI Travel Agent 技术栈（Hackathon 收敛版）

**状态：** 已按当前 Hero Demo 收敛；`apps/api` fixture-backed backend 已部分实施并验证，frontend、AWS deployment、live providers 与真实 model integration 尚未实施

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
        │                 ├─ OpenAI Agents SDK → ModelGateway → OpenAI API
        │                 └─ typed provider adapters
        ▼
Amazon RDS for PostgreSQL
        │
        ├─ Amadeus Test (Flight / Hotel; optional live enhancement)
        ├─ openrouteservice (Ground routing; optional live enhancement)
        ├─ Frankfurter (budget normalization; optional live enhancement)
        └─ visa/readiness fixture with source + checked time
```

三名用户、两个出发地、两到三个目的地候选的 Hero 以可版本化 fixture 为**可靠基线**；live API 只增强演示。任何 live 调用失败都必须显示 `Demo data`，不能伪装成实时库存、报价或签证结论。

## 2. 各层技术选择

| 层 | MVP 选择 | 为什么适合当前范围 | 明确不做 |
|---|---|---|---|
| 客户端 | **Next.js + React + TypeScript**，部署到 **AWS Amplify Hosting** | 浏览器链接最适合三人邀请、独立授权、共同查看、投屏与移动端访问。Amplify 支持 Next.js SSR 部署。[AWS Amplify](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html) | 原生 iOS/Android App、应用商店发布、离线协作。 |
| UI | Tailwind CSS + shadcn/ui/Radix；响应式 PWA | 快速构建 Profile、授权抽屉、候选比较、replan diff、个人待办与三人确认队列。 | 复杂地图编辑器、原生群聊、设计系统平台化。 |
| 前端状态 | **TanStack Query** 管理服务器状态；React Hook Form + Zod 管理表单草稿；仅在必要时以 Zustand 保存局部 UI 状态 | Profile、consent、plan 和 confirmation 都以服务端版本为准。避免 Redux 或客户端复制业务真相。 | 全局客户端 store 作为授权/订单真相。 |
| 数据获取与状态刷新 | REST/JSON + OpenAPI；planning/replan 期间用 TanStack Query 短轮询或 SSE | 对三分钟 Demo 足够稳定；页面刷新后可从数据库恢复状态。 | 为 MVP 自建 WebSocket 事件总线。 |
| API / Agent runner | **Node.js LTS + TypeScript + Fastify**，容器化部署到 **AWS App Runner** | 保持 agent、供应商凭据和数据库访问在服务器；App Runner 可直接部署代码或容器并托管运行、扩缩与负载均衡。[AWS App Runner](https://docs.aws.amazon.com/apprunner/latest/dg/what-is-apprunner.html) | Lambda 链式编排、微服务网格、多个独立 agent 服务。 |
| 身份 | **Amazon Cognito User Pool**，邮箱或手机号登录，API 验证 access token | 身份来自已验证 JWT 的 `sub`，前端不能通过用户 ID 或 demo 角色选择身份。 | 复杂 SSO、社交登录矩阵、组织管理。 |
| 主数据库 | **Amazon RDS for PostgreSQL** + SQL migrations + Drizzle ORM | 需要事务、关系约束、审计和版本一致性：Profile、字段级 consent、两个出发地、候选方案、三人确认和 callback 去重必须共享一个权威真相源。RDS PostgreSQL 支持 VPC、SSL、快照与时间点恢复。[AWS RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) | SQLite 作为云端主库、NoSQL 作为业务真相。 |
| Agent | **OpenAI Agents SDK（TypeScript）**，运行在 App Runner；`ModelGateway` 隔离 provider | 部署到 AWS 不妨碍使用 SDK。Agent 只调用类型化工具；SDK 不是授权、确认或持久状态机。 | 让模型直接读写数据库、付款或自由互聊的多 Agent 群。 |
| 工具与模型边界 | Zod schema、structured outputs、server-side policy gate | 所有工具都只获得当前 `constraint_snapshot` 的最小授权字段；模型输出不直接成为业务真相。 | 把 Profile/私聊全文放进长 prompt 或向前端暴露供应商 key。 |
| 旅行与数据 API | Amadeus Test Flight/Hotel、openrouteservice Routing、Frankfurter；通过 provider adapters | 恰好覆盖候选比较所需的 Flight/Stay/Ground/预算归一化，并能替换数据源。 | 现在接 Activities、POI、Weather、Calendar、Nager.Holidays 或多个 OTA。 |
| Visa / entry | 固定候选路线的**来源化 fixture**；未来可接 Sherpa/IATA Timatic adapter | H4 是 Hero 必需项，但现有 API 清单没有签证数据源。fixture 必带来源、检查时间、适用成员、下一步与不确定性。 | 以 LLM 或 Wikipedia 推断签证、代办、法律结论。 |
| 异步与编排 | MVP 用 PostgreSQL 持久状态机、idempotency key、transactional outbox 和同步 sandbox | 当前流程是确定性 demo；不额外引入 workflow 平台，仍能使 plan 失效、三人确认和 sandbox callback 可验证。 | Temporal Cloud、Step Functions、Redis 队列同时进入 MVP。 |
| 可观测性 | OpenTelemetry + CloudWatch；结构化日志和低基数业务指标 | 以 `trip_id`、`plan_version`、`run_id`、`orchestration_request_id` 关联结果；日志不含私聊、国籍明文、证件号、支付数据。 | 先建独立数据湖或全套企业 APM。 |
| 密钥与部署 | AWS Secrets Manager、最小 IAM role、ECR、GitHub Actions OIDC、IaC | API keys 仅后端可读；GitHub OIDC 避免在 CI 保存长期 AWS 凭据。[GitHub OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers) | 将 API key、数据库密码或 Cognito secret 放进浏览器、代码库或 demo fixture。 |

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

`user_profile`、`preference_fact`、`shared_trip`、`trip_member`、`consent_grant`、`constraint_snapshot`、`destination_candidate`、`itinerary_plan`、`plan_version`、`member_confirmation`、`visa_readiness_check`、`source_evidence`、`provider_offer`、`booking_execution`、`idempotency_record`、`audit_event`、`outbox_event`。

必须由数据库或服务端规则保证：

1. 所有候选的工具请求使用同一 `constraint_snapshot`。
2. 授权撤回或约束变化会使依赖它的 plan 和 confirmations 进入 `STALE`。
3. 只有三个 required members 对同一最新 plan version 为 `CONFIRMED` 才能创建 `booking_execution`。
4. `orchestration_request_id` 和 provider callback id 全局幂等。
5. 每个价格、路线和 visa 输出有 `source`、`captured_at` 或 `Demo data` 标签。

## 5. API 取舍与 fallback

| 能力 | 选择 | MVP 行为 | 风险与缓解 |
|---|---|---|---|
| Flight / Hotel | Amadeus Test adapter | 每个目的地候选可尝试 live 查询；若失败则使用固定 fixture | Test 数据有限、缓存且非完整库存；Amadeus Self-Service 明确有航司/票价覆盖限制。Demo 的通过条件不依赖其可用性。[Amadeus FAQ](https://admin.developers.amadeus.com/self-service/apis-docs/guides/developer-guides/faq/) |
| Ground | openrouteservice Routing adapter | 生成机场/住宿/目的地之间的路线时间或 fixture | 公共服务有使用上限和 OSM attribution 要求；两个出发地、少量候选不需要 Matrix 或 Overpass。[openrouteservice restrictions](https://openrouteservice.org/restrictions/) |
| Budget | Frankfurter adapter | 归一化候选总预算；显示汇率日期与“参考汇率” | 不能被当作支付或结算汇率；API 不可用时使用已标记的 fixture。[Frankfurter](https://frankfurter.dev/providers/ecb/) |
| Visa readiness | 固定来源化 fixture | 对每名授权成员、每个展示候选给出待办/核验缺口 | 没有实时签证 API 前不得宣称实时正确或给法律建议。未来再评估 Sherpa/IATA Timatic。 |

**明确延期：** Amadeus Activities、Open-Meteo、openrouteservice POI/Overpass、Wikimedia、Nager.Holidays、Google Calendar。它们不能帮助完成当前的授权、候选比较、replan 与三人确认闭环。Google Calendar 尤其会增加 OAuth 和隐私风险；以后如做，仅从最小 `freebusy` 权限开始。[Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

## 6. AWS 与 OpenAI 的关系

### 当前决定

- 应用前端、API、数据库、密钥和可观测性部署在 AWS。
- OpenAI Agents SDK 继续作为 TypeScript agent orchestration 库。
- OpenAI 模型调用经 `ModelGateway` 在后端发起；密钥存于 Secrets Manager。
- 不在 MVP 强行引入 Bedrock AgentCore、Bedrock Agents 或 Bedrock 模型。

AWS AgentCore 的确支持包括 OpenAI Agents SDK 在内的多种框架，但这只能说明它是将来的可选运行环境，并不证明本次赛事必须用它。[AWS AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/using-any-agent-framework.html)

### 防止 provider lock-in

`ModelGateway` 对上提供 `generateStructuredPlan()` / `explainPlanDiff()` 等应用能力，对下隐藏 OpenAI、Bedrock 或其他模型的 SDK。`TravelProvider` 对上提供 `searchFlights()`、`searchStays()`、`routeGround()`、`checkReadiness()`，隐藏 Amadeus/openrouteservice/fixture 的返回格式。

这不是为多云做抽象秀：它保护两个已知的真实变化点——hackathon live API 可能失效，后续模型/赛事限制可能变化。

## 7. MVP 与未来阶段

| 维度 | Hackathon MVP | Pilot / 未来 |
|---|---|---|
| 用户与路线 | 三个 seed 用户、两个出发地、两到三个预设目的地、至少两国籍 | 真实注册用户、可配置城市和更广覆盖 |
| 数据 | fixture 为基线，live API 为增强 | 正式供应商合同、SLAs、监控与多 provider routing |
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
| live API 不稳定 | 所有工具均有版本化 fixture；UI 明示数据来源。 |
| 三人多约束导致 demo 拖沓 | 预置 Profile、两出发地、最多三个候选、一个确定性变化事件；不允许自由目的地搜索。 |
| 未授权信息泄露 | 服务器创建最小授权 snapshot；共享页面只读取其字段；测试跨用户读取与授权撤回。 |
| OpenAI 或 AWS 服务变更 | ModelGateway；API/部署和 agent framework 分离。 |
| 重复 callback / 重复 sandbox | plan version + idempotency key；三人确认是执行前硬门槛。 |

## 9. 实现前仅需验证的事项

1. 取得赛事规则原文，确认 “部署到 AWS” 是否要求特定 AWS 服务或区域。
2. 确定 Hero 的两个出发地、两到三个目的地候选、三位测试用户和至少两种国籍；将其制作为稳定 fixture。
3. 对该固定场景试跑一次 Amadeus Test、openrouteservice、Frankfurter；任何失败都不改变 fixture-first 基线。
4. 完成最小 OpenAI Agents SDK tool-call spike，确认 structured output、超时与错误处理；失败时降级为同一 `ModelGateway` 下的直接 OpenAI Responses 调用。

在以上验证通过前，不应将平台宣传为真实库存、实时签证判断或可实际购票的生产 OTA。
