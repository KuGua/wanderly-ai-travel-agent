# DRAFT Personal Research 到 Shared Planning 实施规范

**状态：** 部分实施；当前仅 Flight 可确认，其他 capability fail closed
**适用范围：** `DRAFT` Trip、owner-only Personal Agent、真实 research provider、显式进入 Shared Planning  
**实现前提：** 当前运行时已具备 owner-only `PERSONAL_RESEARCH` durable task 与 immutable confirmed request；只允许 `flight.search`。它不创建 Shared snapshot，结果不能进入 plan。其余能力仍按 [Personal Research Intent Routing 实施规范](personal-research-intent-routing-implementation.md) 的 snapshot-bound Shared 路径处理，直到各自完成独立验收。

## 1. 目标与范围

### 目标

保留当前“首条已提交私聊消息原子创建一个 `DRAFT` Trip、创建者 membership 与默认私有 thread”的模型；任何 Personal Session 都绑定一个 Trip，绝不引入无 Trip 的搜索上下文。

在此基础上，使 Trip owner 能在 `DRAFT` 阶段、经每次明确确认后，直接获得 owner-only 的真实旅行研究结果。Personal Agent 应主动帮助补齐行程信息，但不能以“尚未完整规划”为由阻断用户已经明确要求的查询。Shared Agent 只在用户选择“开始共同规划”、现有激活流程完成并形成授权 snapshot 后才运行。

术语在本项目中的精确定义如下：

| 名称 | 权威对象 | 说明 |
| --- | --- | --- |
| Trip | `shared_trips` | 第一条消息即创建；`DRAFT` 是 owner 的私有研究阶段，不是不存在 Trip。 |
| Personal Session | `chat_threads` | 当前已经持久化、owner-only、且 `trip_id` 非空的私有对话。第一期不新增 `personal_agent_sessions`。 |
| Personal Research run | `agent_task_runs` 的新 `PERSONAL_RESEARCH` operation | 一次被 owner 确认的、带 `tripId + threadId + ownerUserId` 的 provider 调用；无 Shared snapshot。 |
| Shared Planning run | 既有 `PLAN` / `REPLAN` / 当前 `RESEARCH` | 只在 Trip 激活、明确授权并生成 immutable `constraint_snapshot` 后运行。 |

### 纳入范围

- 让 Personal Agent 对已确认的查询使用与 Shared Agent **同一套** capability contract、policy 描述和 provider adapter；差异只在 authority、输入来源、结果可见性与是否能写 Shared state。
- 以一个最小纵切面开始：`flight.search` 的 DRAFT Personal Research。之后按 capability 独立扩展至住宿、活动、地点、路线和 mobility。
- 把 DRAFT research 结果保存为 owner-only、有来源和 `captured_at`/有效期的结果；它们只能帮助用户决定是否进入规划，不得成为 plan evidence 或 booking 输入。
- 复用既有 `POST /trips/:tripId/activate` 作为进入 Shared Planning 的唯一手动交接。激活页可从 Personal Research 预填，但必须由 owner 在表单中审阅并提交；服务端不得从聊天或个人结果静默写入 trip brief/consent。

### 明确不在范围

- 不创建第二套持久化“Session”表，不解绑 `chat_threads.trip_id`，也不改变 `shared_trips.pinned_session_id`（它当前指向 task run，而非 chat thread）。
- 不让模型、浏览器或普通 conversation task 直接调用 provider；不做自由 multi-agent、真实预订/付款/签证申请或自动 handoff。
- 不把 Personal Research 的结果或用户原文复制到 `constraint_snapshot`、Shared Agent、同行者或 telemetry。
- 不假设已有可用的签证实时 provider。当前 `VisaProvider` / Sherpa 仍是禁用的接入目标，签证 Personal Research 必须等 provider contract、DPA、凭据和 sandbox 验证通过后另行启用。

## 2. 当前实现基线与问题

| 当前事实 | 影响 | 对应实现 |
| --- | --- | --- |
| 首条消息已创建 DRAFT Trip、member、默认私有 thread，并在该 thread 接受消息。 | 不需要另造 TripID 或 SessionID 生命周期。 | `apps/api/src/services/exploration-service.ts`; `apps/api/src/db/schema.ts` 的 `sharedTrips`、`chatThreads` |
| `chat_threads` 只有 `TRIP` scope 且 `trip_id` 非空，owner 检查也同时检查 thread/trip membership。 | Personal Session 应复用 thread，而非新增平行 session。 | `apps/api/src/db/schema.ts`; `apps/api/src/services/chat-thread-service.ts` |
| 当前 policy 仅允许 Personal Agent 读/提议 profile、consent、chat；Shared 才获得 provider scopes。 | 不能仅改提示词或前端确认按钮；必须增加受约束的 Personal Research authority。 | `apps/api/src/agents/policy-gate.ts`; `apps/api/src/agents/skill-registry.ts` |
| 既有 Shared tool/run/evidence 都依赖 snapshot。 | 不能把现有 evidence 表的 `snapshot_id` 粗暴改为 nullable，也不能让 Personal 结果进入 Shared plan validator。 | `apps/api/src/services/personal-trip-orchestrator-service.ts`; `apps/api/src/services/*provider*.ts`; `apps/api/src/agents/plan-output-validator.ts` |
| Worker 将所有非 `CONVERSATION` task 交给 planning handler。 | 新 operation 必须有显式 claim/dispatch/handler，不能借用 PLAN 或 RESEARCH 语义。 | `apps/api/src/workers/agent-task-worker.ts`; `apps/api/src/tasks/task-repository.ts` |

## 3. 具体改动与技术实现建议

### 3.1 Authority：复用工具，不复用越权上下文

在 agent/tool contract 中引入一个由服务端构造的辨别联合类型（名称可按现有命名规范调整）：

```ts
type ResearchAuthority =
  | { kind: "PERSONAL"; tripId: string; threadId: string; ownerUserId: string; runId: string }
  | { kind: "SHARED"; tripId: string; snapshotId: string; runId: string };
```

- `ToolSpec`、输入 schema、timeout、provider adapter 与标准 `UNAVAILABLE` 错误码保持单一实现；不要复制一套 `personal-flight-service` 或让 LLM 持有 provider credentials。
- `DefaultPolicyGate` / skill registry 按 `authority.kind + capability + operation` 授权。`PERSONAL` 只允许显式开放的 read-only research capability；永远拒绝 `plan:write:*`、booking、consent 写入、Team memory、Shared state 写入和其他成员资料。
- Shared 路径仍要求 `snapshotId`，并保留现有 exact-evidence validator。Personal 路径不能调用 plan persistence/validator，也不能在没有 snapshot 的情况下写既有 snapshot-bound provider evidence 表。
- 初期只开放 `flight.search`。每个后续 capability 要先完成其输入契约、结果 schema、授权检查和 contract tests，再加入 allow-list，不能用一个“all tools enabled”开关一次放开。

### 3.2 任务、私有结果与幂等

新增 `PERSONAL_RESEARCH` 到 `agentTaskOperationEnum`，并在 task 接受、schema constraint、repository、lease/claim 和 Worker dispatch 中把它当成独立 operation。

新增一张**薄的、owner-only** `personal_research_evidence`（最终名称由实现者按 schema 命名统一）表，而不是修改现有 provider evidence 的 snapshot 不变量。建议字段：

- `id`, `run_id`（唯一，FK task run）、`trip_id`, `thread_id`, `owner_user_id`；
- `capability`, `outcome`（`AVAILABLE | UNAVAILABLE`）、`provider_name`、`source`, `captured_at`, `expires_at`；
- 经 Zod 验证后的最小 normalized result JSON 与安全 error code；不存 raw provider payload、私聊正文、证件或未授权 profile 字段；
- owner-only RLS/service 查询条件；唯一 `(run_id, capability)`，并沿用 stable request ID 的接受幂等性。

这张表是 Personal run 的私有结果投影，不是第二个 provider/tool 系统：数据只能由同一 core tool adapter 的已验证输出写入，不能被 Shared plan 读取。将来如要统一 evidence 数据模型，必须先完成独立 migration 设计和 Shared validator 回归，不能在本需求中顺带迁移全部 provider 表。

新建 `PersonalResearchTaskHandler`：加载 run、thread、owner 和经确认的 typed request，重做 membership/owner/Trip status/capability/provider gating，再构造 `PERSONAL` authority 并调用 core skill。所有失败、超时、限流、空结果与 schema drift 统一持久化/返回 `UNAVAILABLE`；严禁 fixture 或模型生成的报价替代。

### 3.3 受控确认与输入

普通 conversation 仍只能识别 intent、说明缺口并生成不可执行 draft。新增 owner-only Personal Research request 生命周期，例如 `DRAFT → CONFIRMED → QUEUED → COMPLETED | COMPLETED_WITH_GAPS | FAILED | CANCELLED`；状态与可编辑字段的权威来源在服务端，不在浏览器或模型输出。

建议新增 owner-only 路由组，而不改变既有 snapshot research 路由的含义：

| 接口（建议） | 行为 |
| --- | --- |
| `GET /agent-runs/:runId/personal-research` | 读取当前 owner 自己的 draft、缺口与最小结果摘要。 |
| `PUT /agent-runs/:runId/personal-research/answers` | 按 capability 的 Zod schema 更新 owner 明确填写的字段；用 version/ETag 防止乱序覆盖。 |
| `POST /agent-runs/:runId/personal-research/confirm` | 仅接受 `requestId`；事务中重新校验 owner/thread/trip、字段、feature/provider gate，创建 `PERSONAL_RESEARCH` durable task，返回 `202`。 |
| `POST /agent-runs/:runId/personal-research/cancel` | 取消尚未执行的 draft，幂等且不发起 provider。 |

不要让 confirm body 接收自由 provider 参数、snapshot ID、价格、地点 ID 或身份。Phase 1 的 flight schema 只允许已经明确选择的出发/到达 airport reference、日期、旅客数和舱位等现有 FlightProvider 支持的受控字段；缺少字段时只追问或提示用户编辑，绝不猜测。

确认会发起真实调用，因此 UI 必须在按钮附近显示：将查询真实供应商，结果可能不可用或已过期；建议先补齐行程以获得完整方案，但用户可继续查询。确认前不可发起网络 provider 调用。

### 3.4 从 Personal 到 Shared 的交接

不增加“自动提交给 Shared Agent”的接口。用户在 owner-only UI 中点击“开始规划”后，使用既有 `POST /trips/:tripId/activate` 填写并确认 Trip brief。仅成功激活后，现有 consent、snapshot、`POST /trips/:tripId/research`、PLAN/REPLAN 与 Shared Orchestrator 路径保持生效。

Personal Research 结果可作为 UI 参考或表单预填候选；owner 必须逐字段确认。激活或后续 snapshot 只收集用户明确选择、并已按字段授权的最小约束；Shared Worker 必须重新查询所需 provider 事实，不能引用 DRAFT Personal Research evidence。

### 3.5 Capability rollout

| 阶段 | 能力 | 必须先完成的专属边界 |
| --- | --- | --- |
| 1 | Flight | airport/date/passenger typed input、result projection、expiry 与 flight provider contract tests。 |
| 2 | Accommodation discovery、hotel quote、activities | hotel 日期/occupancy/currency 与 Nuitee provider-only nationality；活动的 source/price contract。 |
| 3 | Places、navigation、mobility | owner-only place adoption / route endpoint 选择；不得将 private place 静默写入可共享 `trip_places`，也不得从路线推导商业票价/班次。 |
| 4 | Visa readiness | 仅在真实 `VisaProvider` 的协议、DPA、凭据、审计与 sandbox 验证完成后；否则 `UNAVAILABLE` + 官方核验下一步。 |

## 4. 涉及模块/文件

| 模块 | 主要改动 |
| --- | --- |
| `apps/api/src/db/schema.ts` 与 migration | 增加 operation、Personal request/evidence 表、FK/unique/check constraint 和索引；保留 `chat_threads.trip_id` 与现有 snapshot evidence 非空约束。 |
| `apps/api/src/tasks/task-repository.ts`、`apps/api/src/workers/agent-task-worker.ts` | Personal task 接受、幂等、claim、取消、retry 与独立 handler dispatch。 |
| `apps/api/src/agents/policy-gate.ts`、`apps/api/src/agents/skill-registry.ts`、tool contracts | 引入 authority union 与逐 capability allow-list；Shared 权限不回退。 |
| `apps/api/src/tasks/handlers/`、`apps/api/src/services/` | 新 Personal Research request/service/handler；从已有 provider service 抽取可复用的、无 snapshot 写入的 core execution 边界。 |
| `apps/api/src/routes/` 与 `apps/api/src/contracts/` | 新的 owner-only draft/answers/confirm/cancel/read 接口、Zod DTO、错误码与 route registration。既有 `/trips/:tripId/research` 继续仅用于 snapshot-bound Shared research。 |
| `apps/web/src/` | 私聊内 draft/补齐/确认卡、明确真实查询提示、结果卡、开始规划 handoff 与 SSE/refresh 恢复；浏览器不保存 provider authority 或消息历史。 |
| tests 与 `docs/test-scenarios.md` | 单元、repository、route、worker、provider contract、授权/隐私/幂等和回归场景。 |

## 5. 数据、接口与兼容性

- 这是 additive migration：现有 `CONVERSATION`、`PLAN`、`REPLAN`、`RESEARCH` 记录和 API 语义不变。`PERSONAL_RESEARCH` 必须在数据库 check constraints、TypeScript union、metrics/audit event allow-list 和所有 switch 中完整处理。
- 不改变既有 `/trips/:tripId/research` 对 snapshot 的要求，也不把 `snapshot_id` 改为“可选且随处可用”。
- 新接口只能对 `run.owner_user_id`、同一 `thread_id` 和 active membership 的 owner 返回数据。跨用户、同 Trip 的其他 member、Shared Agent、过期/取消 run 一律 fail closed。
- 新表与事件只写安全枚举、时间、provider/source、run/trip correlation ID 和字段填充状态；run/trip ID 仅用于 log/trace 关联，不作为 metric label。不得记录 user text、完整 input、原始结果或 nationality/document 数据。
- 本设计不引入环境变量。实现各 capability 时继续使用当前 provider feature/config gate；不得复用 `PLAN_ENABLE_*` 将 DRAFT personal 调用意外打开。若确需新开关，必须同一变更更新 `apps/api/.env.example`、runbook、指标与默认 fail-closed 行为。

## 6. 边界情况与风险

| 情况/风险 | 必需行为 |
| --- | --- |
| 用户尚未完成行程但明确要查 | 显示“建议先规划”的提示后仍允许 owner 填写/确认；不得因 DRAFT 拒绝。 |
| 用户只是在讨论或 intent 低置信度 | 保持普通私聊/澄清；不创建可执行 task，不调用 provider。 |
| 复用 Shared evidence 导致私有事实泄露 | Personal evidence 不可被 plan/snapshot query；Shared 阶段重新查询。 |
| owner 撤销、成员/brief 变化、结果过期 | Personal 结果不产生 Shared staleness；开始规划时重新以最新 consent/snapshot 编排。已接受但尚未执行的 Personal run 重新校验 owner/thread membership。 |
| 双击确认、网络重试、callback 乱序 | 以 stable request ID 与 run/capability uniqueness 幂等；重复最多产生一次 provider execution/result。 |
| provider 缺配置、超时、限流、schema 漂移 | `UNAVAILABLE`，记录安全 audit/telemetry；不得 fallback 到 fixture、Demo data、其他 provider 或模型内容。 |
| 酒店/签证/路线的敏感或高风险字段 | 按当前 provider 专属授权与官方核验边界执行；未完成能力的 allow-list 必须关闭。 |

## 7. 验收标准

1. 新用户发送第一条私聊消息后，仍只有一个服务器创建的 DRAFT Trip、creator membership 和默认 `chat_threads` 行；刷新后能恢复同一 thread，没有新 session 表。
2. DRAFT owner 明确确认完整的 Flight query 后，Worker 以 `PERSONAL_RESEARCH` 调用已配置的 flight adapter；结果仅 owner 可读，并带 `source`、`captured_at` 和适用的 `expires_at`。未配置/失败返回 `UNAVAILABLE`，没有 fixture。
3. DRAFT 不完整时，Personal Agent 可询问并展示“建议先规划”的提示；用户确认有效输入后仍可研究。低置信度普通聊天、未确认 draft、取消和过期绝不调用 provider。
4. 其他成员、Shared Agent、snapshot/plan endpoint 和 plan validator 都不能读取/使用 Personal evidence；私聊正文、raw provider payload、国籍/证件不进入该表、日志、SSE 或指标标签。
5. DRAFT research 不会创建 snapshot、PLAN/REPLAN、plan、confirmation 或 booking request；激活 + 明确 consent + 既有 Shared research 是唯一 Shared Planning 入口。
6. 重复 confirm、重试、取消竞争和乱序 worker/callback 最多产生一个执行/一条结果，且状态可恢复、审计可关联。
7. 每个新 capability 均有 success、missing input、未授权、DRAFT owner、cross-user、provider unavailable、expiry、idempotency 和 privacy 回归测试；酒店/路线/签证另覆盖其专属边界。

## 8. 实施顺序

1. **契约与数据设计：** 确认术语、authority union、operation/state machine 和 thin private evidence schema；先写 migration/repository tests，审查所有现有 snapshot non-null/check constraints。
2. **任务基础设施：** 新 operation 的 accept/claim/dispatch/cancel/retry、owner/thread authorization 和安全 audit/SSE stage；确保旧 PLAN/RESEARCH 不回归。
3. **Flight 纵切面：** request draft/answers/confirm routes、typed input、Personal handler、同一 flight adapter、private result projection、Web 卡片和 refresh recovery。
4. **Shared handoff：** 在 UI 接入既有 activate form 的显式预填/审阅；验证 Personal evidence 不会进入 snapshot，Shared research 会重新取数。
5. **逐能力扩展：** 严格按 §3.5 的顺序逐项开放；每项先完成 provider contract、隐私/授权威胁模型和 fail-closed tests。
6. **文档与发布门槛：** 更新 API、`.env.example`（仅有新配置时）、runbook、PRD/backlog/test scenarios；运行 migration、typecheck、lint、unit/integration、provider contract 和 docs link verification。没有真实 provider 配置的环境以明确 `UNAVAILABLE` 验证，不伪造演示数据。

## 9. 实施前的决策门

研发开始 Phase 1 前，产品/工程需确认：Flight 结果最小展示字段、Personal result 的过期策略、DRAFT owner 是否可邀请成员后仍使用个人 research，以及是否使用新增的 capability-specific feature flag。未确认这些事项时，保持默认关闭，不能通过放宽 Shared `PLAN_ENABLE_*` 或 snapshot 约束来抢跑。
