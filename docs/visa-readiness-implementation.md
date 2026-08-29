# 全球签证与入境 Readiness 实施规范

**状态：** 已确认，待实施  
**适用范围：** Shared Trip `PLAN` / `REPLAN`、成员私有 readiness 待办、方案确认前的路线核验  
**非目标：** 签证代办、法律意见、获批/可入境保证、RAG、规则网页抓取、向量库、浏览器直连规则 API。

## 1. 已确认的技术决策

1. 全球覆盖使用受审查的结构化旅行证件/入境数据 provider；首选接入目标为 **Sherpa Requirements API (Trips v3)**。签约、生产许可、数据处理协议、SLA 和费用完成验证前，运行时 provider 必须返回 `UNAVAILABLE`，不得以 sandbox、fixture 或模型答案替代。
2. Readiness 分两阶段执行：
   - **候选阶段（destination-level）**：每个已授权成员 × 每个展示目的地，生成目的地入境的初步 readiness。未选具体航班时，必须明确标记“过境核验待选定航班后完成”。
   - **路线阶段（route-level）**：用户选择具体 flight offer 后，按实际完整航段（目的地与每个中转机场/国家）重新核验。该结果才是行程级完整 checklist。
3. 国籍仅从当前不可变 `constraint_snapshot.authorized_data` 取得；服务端不得从姓名、出发地、聊天或模型推断。详情仅返回给该成员；团队 API/UI 只能看到不含国籍、成员归属或规则正文的汇总缺口。
4. provider 输出是有时效的 evidence，不是业务真相或法律结论。所有显示项必须带 provider/source、`captured_at`、适用阶段和官方核验下一步；过期、未知、空结果和失败均 fail closed。
5. 不使用 RAG 或自建签证规则资料库。允许保存 provider 标识、规范化结果、官方 CTA URL、检查时间和安全状态；不得保存/索引规则网页正文。

## 2. 现有架构与复用边界

本实现保留模块化单体：Next.js Web、Fastify API、PostgreSQL/Drizzle、PostgreSQL lease 驱动的 Fargate Worker、受限 Skill Registry、`ModelGateway` 与 typed provider adapters。API 只接受命令/读取结果；耗时 provider 调用只在 durable Worker 执行。

| 现有模块 | 处理 | 实施要求 |
| --- | --- | --- |
| `src/services/consent-service.ts`、`constraint_snapshots` | 复用 | 仅使用本次 snapshot 中已授权的国籍；授权撤回沿用现有 stale/replan 控制面。 |
| `src/services/visa-service.ts` | 修改 | 从单目的地的占位 service 演进为 `ReadinessOrchestrator`；移除把国籍重复持久化到结果行的需求。 |
| `src/providers/types.ts` 中的 `VisaProvider` | 修改 | 改为显式接收 `ReadinessQuery`（阶段、旅客、完整 route），返回归一化 `VisaReadinessEvidence`。 |
| `src/providers/live-provider-factory.ts` | 修改 | 注入 `visaProvider`；未配置/未通过 capability probe 时返回 `UNAVAILABLE/NOT_CONFIGURED`。 |
| `src/tasks/handlers/planning-task-handler.ts` | 修改 | 候选 research 后执行 destination-level readiness；不让模型决定 provider、国籍、航段或请求 URL。 |
| `src/services/planning-service.ts` | 修改 | 将安全的候选汇总输入 plan synthesis；持久化前验证只引用同 snapshot/current run 的 readiness evidence。 |
| `FlightOffer.segments` | 复用 | 实际 offer 被选择后，以其机场序列构造 route-level 请求；机场→国家由服务端 reference 解析。 |
| `visa_readiness_checks`、`source_evidence` | 迁移并复用 | 结果改为 stage/route/evidence 绑定；`source_evidence.category='visa'` 记录可显示来源。 |
| Next.js + TanStack Query | 新增读取/UI slice | 候选卡只显示安全汇总；个人待办请求只返回当前用户的结果。 |

## 3. 系统架构与数据流

```text
POST /planning/generate or REPLAN
  → immutable constraint snapshot
  → flight/stay/ground candidate research
  → destination-level ReadinessOrchestrator (member × destination, bounded concurrency)
  → normalized visa_readiness_checks + source_evidence
  → safe aggregate only → plan synthesis / deterministic validator
  → PROPOSED plan and private readiness read models

member selects a concrete flight offer
  → POST /plans/:planId/selected-flight
  → validate offer belongs to current plan/snapshot and is unexpired
  → derive ordered airports/transit countries server-side
  → route-level ReadinessOrchestrator (member × selected route)
  → supersede destination-only result for that member/route
  → complete route checklist or explicit gap
  → confirmation gate reads route readiness state
```

### 3.1 候选阶段

输入：`snapshotId`、候选 destination 的 ISO-3166 alpha-3 code、旅游目的、日期、已授权成员 alias/国籍、受控 origin airport。输出不使用或臆造中转机场。

每个成员/候选写入一条或一组 destination-level check：

- 未授权国籍：`NEEDS_NATIONALITY_CONSENT`；不调用 provider；只向本人显示说明。
- provider 有可验证响应：`PRELIMINARY_READY` 或 `OFFICIAL_VERIFICATION_REQUIRED`；始终保留“需在选定航班后完成 transit check”。
- provider 无响应/超时/无可信内容：`UNAVAILABLE`；记录安全 reason code 和官方核验 CTA。

候选阶段的结果不得阻止其它 provider research；与既有 provider gap 一致，可形成非确认型 `COMPLETED_WITH_GAPS` summary。它不得宣称 route-level 完整。

### 3.2 路线阶段

`selected-flight` 只能引用当前 `ACTIVE` / 当前可采用 plan 内、未过期的 `provider_offers` flight 行。服务端从其标准化 `FlightOffer.segments` 取得顺序机场，使用 location reference 映射国家；浏览器不得提交 airport list、country、provider 或任意 URL。

若任一机场无法解析、offer 已过期、计划已 `STALE`、成员撤回国籍授权或 provider 失败：不创建完成状态，写安全 gap 并使依赖的 route readiness 失效。选定 flight 改变、航段改变、计划/snapshot 变化、相关 consent 撤回、provider evidence 到期，均使 route-level check `STALE`。

## 4. Provider 契约与依赖

### 4.1 新的归一化接口

```ts
type ReadinessStage = "DESTINATION" | "ROUTE";
type ReadinessStatus =
  | "PRELIMINARY_READY"
  | "ROUTE_CHECK_REQUIRED"
  | "OFFICIAL_VERIFICATION_REQUIRED"
  | "NEEDS_NATIONALITY_CONSENT"
  | "UNAVAILABLE"
  | "STALE";

interface ReadinessQuery {
  snapshotId: string;
  tripId: string;
  memberId: string;                 // server internal only
  stage: ReadinessStage;
  nationality: string;              // provider call only; never log/persist in result
  purpose: "TOURISM";
  departureAt: string;
  travelNodes: Array<{ kind: "ORIGIN" | "TRANSIT" | "DESTINATION"; airportCode: string }>;
  locale: "en" | "zh";
}

interface VisaReadinessEvidence {
  status: Exclude<ReadinessStatus, "NEEDS_NATIONALITY_CONSENT" | "STALE">;
  checklist: Array<{ code: string; title: string; nextAction: string; officialUrl?: string }>;
  source: { provider: string; sourceUrl?: string; capturedAt: string; expiresAt?: string };
  appliesTo: { stage: ReadinessStage; destinationCountry: string; transitCountries: string[] };
}
```

`SherpaVisaProvider` 负责把 Sherpa Trips v3 的 travel nodes、procedure/document grouping 与来源映射为该接口。adapter 必须：设置 deadline/AbortSignal、validate upstream schema、丢弃原始 payload、丢弃申请购买链接、只返回 allow-listed 文本字段；不可验证的响应返回 `UNAVAILABLE`。

### 4.2 配置与 capability gate

新增 server-only 环境变量，并在 `.env.example` 注明格式、是否必填和安全说明：

- `VISA_PROVIDER=sherpa|disabled`
- `SHERPA_REQUIREMENTS_API_KEY=<secret>`
- `SHERPA_REQUIREMENTS_API_BASE_URL=<https URL>`
- `VISA_PROVIDER_TIMEOUT_MS=<bounded integer>`

`disabled` 是默认安全模式。生产启用前必须完成：合同/许可审查、DPA、sandbox contract suite、生产 credentials 验证、SLO/限流设定和 provider outage 演练。不得把 Timatic/VisaHQ widget 作为服务端 evidence provider 或默认加载的浏览器组件。

## 5. 数据模型与状态

### 5.1 Migration

对 `visa_readiness_checks` 做向后兼容 migration：

- 新增 `trip_id`、`agent_task_run_id`、`stage`、`status` enum/受限字符串、`selected_offer_id`（route-only）、`route_fingerprint`、`transit_countries`、`source_url`、`expires_at`、`stale_at`、`superseded_by_id`。
- `nationality` 改为 nullable legacy 列并停止写入；新读取 DTO 不返回它。后续数据清理 migration 在无兼容消费者后删除该列。
- 加唯一条件约束：同一 `(snapshot_id, member_id, stage, destination_country, route_fingerprint)` 只能有一个未 stale 的结果；route stage 的 `selected_offer_id` 必填。
- 加索引：`(trip_id, member_id, status)`、`(snapshot_id, stage)`、`expires_at`、`selected_offer_id`。

`source_evidence` 保持权威出处记录，新增/约束 `category='visa'` 的 metadata 仅包含安全的 provider、stage、destination code、route fingerprint、结果状态；不包含国籍、证件、原始 response 或 URL query。

### 5.2 状态与门禁

| 状态 | 含义 | 对 plan/confirmation 的作用 |
| --- | --- | --- |
| `PRELIMINARY_READY` | 目的地级 provider evidence 已保存 | 仅候选展示；仍要求 route check。 |
| `ROUTE_CHECK_REQUIRED` | 尚未选择有效 flight offer | 不阻塞候选比较；不能称完整。 |
| `OFFICIAL_VERIFICATION_REQUIRED` | provider 给出需用户完成的外部核验 | 保持可见待办；不代表批准。 |
| `NEEDS_NATIONALITY_CONSENT` | 成员未授权国籍 | 仅本人可见；不调用 provider。 |
| `UNAVAILABLE` | provider/解析/数据失败 | 显示缺口；不可用结果不是成功 evidence。 |
| `STALE` | snapshot、route、授权或证据已变 | 不可展示为当前状态、不可用于确认。 |

本 MVP 的 booking sandbox 不得因系统“判定可入境”而自动放行。确认 UI 必须要求成员显式确认其 route-level readiness 已查看；缺少 route result、`STALE` 或 `UNAVAILABLE` 时仅允许继续显示官方 CTA，是否阻断 booking 由单独的确认 policy 实现，默认应阻断自动进入 sandbox。

## 6. HTTP 与前端契约

所有 route 必须鉴权、先查 membership，再按 owner scope 过滤。所有写入命令使用 UUID idempotency key；读取 DTO 不返回国籍或原始 provider 数据。

| Endpoint | 行为 |
| --- | --- |
| `GET /trips/:tripId/readiness/me` | 返回当前成员在当前 plan/snapshot 下的 destination 与 route checklist、gap、来源和检查时间。 |
| `GET /trips/:tripId/readiness/summary` | 返回团队安全汇总：按候选/plan 的完成数、待操作数、不可用数；不返回成员-国籍关联、规则正文或个人 next action。 |
| `POST /plans/:planId/selected-flight` | body `{ offerId, requestId }`；校验 membership、plan state、offer snapshot/expiry 后持久化用户选择，并接受 durable `ROUTE_READINESS` task。 |
| `GET /plans/:planId/readiness` | 当前用户个人结果的 plan-scoped alias；非成员 403，其他成员结果不可见。 |

前端以 TanStack Query 缓存这些 read models；`run.completed`、plan stale、offer selection 和 consent mutation 后精确 invalidation。候选卡显示 `destination readiness` 徽标和“选择航班后核验过境”；个人待办页显示 checklist、source、captured time、官方 CTA。禁止在团队卡、共享 plan explanation、SSE、浏览器持久状态或 analytics 中显示国籍。

## 7. 实施阶段与任务依赖

### Phase 0 — Provider spike（先决条件）

1. 与 Sherpa 确认生产许可、全球覆盖定义、Trips v3 SLA、速率/价格、DPA、保留与删除条款。
2. 用 sandbox 验证 destination request、含 1–3 transit nodes 的 request、`NO_INFORMATION`、超时、429、schema 变更与官方来源字段。
3. 输出 provider contract decision；未通过则保持 `disabled`，实施 generic official-verification gap，不启用真实规则结论。

### Phase 1 — 服务端领域基础

1. Migration、Drizzle schema、domain/Zod DTO、readiness status enum 和 redaction allow-list。
2. `ReadinessOrchestrator`、`UnavailableVisaProvider`、factory injection、deadline/retry/circuit metrics。
3. snapshot nationality reader、airport-country resolver、route fingerprint 与 stale cascade service。
4. 单元/DB tests：授权、去重、过期、stale、跨成员隔离和 raw payload redaction。

### Phase 2 — 候选阶段集成

1. 在 `PLAN`/`REPLAN` Worker 的 candidate research 后执行有并发上限的 member × destination checks。
2. 将安全 aggregate 传入 synthesis/validator；持久化 check/evidence/audit。
3. 完成 personal/summary GET endpoints、OpenAPI 与 Web Query hooks。
4. 增加候选卡和成员个人待办 UI；不允许 Shared UI 读取其他成员详情。

### Phase 3 — 航班选择与路线阶段

1. 实现 `selected-flight` authoritative state 与 idempotency；禁止客户端提交 route。
2. 接受 durable `ROUTE_READINESS` task（扩展 operation/status schema、worker handler、SSE safe phase）。
3. 从 selected normalized flight segments 构造 travel nodes，执行 provider，写 route-level evidence 和 stale rules。
4. 将 confirmation/booking policy 接到 route-level readiness；补齐 UI 重新选择航班、过期和失败提示。

### Phase 4 — 运营与发布

1. OTEL spans、低基数 metrics、审计事件、dashboard/SLO、provider outage runbook。
2. 生产 credential rollout、限流/circuit breaker、合同要求的 retention/deletion job。
3. 端到端三成员全球目的地+中转 Hero Demo 和回归门禁。

## 8. 验收与测试

必须同步实现 `docs/test-scenarios.md` 中的 H4 场景，并至少覆盖：

- 两个候选目的地的 destination-level checks；未选航班时永远显示 route pending。
- 两条相同目的地、不同中转机场的 offer 产生不同 route fingerprints；选择/切换 offer 使旧 route check stale。
- 无国籍授权不访问 provider、不推断国籍，仅 owner 见 consent CTA。
- 其他成员、团队 summary、plan explanation、SSE、audit、logs、traces、metrics 不含国籍、passport、raw provider payload 或申请链接。
- provider 429/5xx/timeout/空响应/schema 失败、机场映射失败、证据过期、授权撤回、plan stale、重复/乱序 task finalization。
- provider failure 形成 `UNAVAILABLE` gap，不产生虚构 checklist、`ACTIVE` route evidence 或自动 booking authority。

## 9. 可观测性与运维

- Trace spans：`visa.readiness.destination`、`visa.readiness.route`、`visa.provider.sherpa`；可携带 `trip_id`/`run_id` 作为 trace/log correlation，不得把它们或用户身份作为 metric label。
- Metrics：`visa_readiness_checks_total{stage,status,provider}`、`visa_provider_requests_total{outcome,provider}`、`visa_provider_latency_ms`、`visa_readiness_stale_total{reason}`。所有标签为固定低基数枚举。
- Audit：`VISA_CHECK`、`VISA_READINESS_STALE`、`FLIGHT_SELECTION`；summary 仅记录 status/stage/provider/关联 ID，不含个人字段或规则正文。
- 运行手册：provider outage 时保持 `UNAVAILABLE`、显示官方 CTA、禁止人工在日志或数据库补录国籍/规则正文。

## 10. 风险与不可违反的边界

| 风险 | 控制措施 |
| --- | --- |
| Provider 覆盖、条款或费用不符合全球承诺 | Phase 0 合同与 sandbox gate；未通过不启用。 |
| 规则或来源变化 | `captured_at`/`expires_at`、stale cascade、重新检查；不缓存规则正文。 |
| 候选阶段被误解为完整过境结论 | 固定 `ROUTE_CHECK_REQUIRED` 状态和 UI 文案；route 仅来自选定 offer。 |
| 国籍泄露 | snapshot 最小授权、owner-only DTO、团队 aggregate、日志/trace redaction、禁止前端 provider widget。 |
| Provider 申请导流或代办链接 | adapter allow-list 丢弃申请/购买 URL；只显示官方核验 CTA。 |
| 高调用量（成员 × 候选 × route） | 候选阶段有界并发、按 snapshot/result 去重；仅对选定 flight 执行 route-level query。 |
| 模型将 readiness 编造成事实 | 模型只能消费持久化安全 aggregate；validator 禁止无 evidence 的 visa 文本。 |
