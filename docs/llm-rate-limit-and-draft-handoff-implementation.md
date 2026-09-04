# LLM 限流韧性与 DRAFT→Shared 交接实施规范

**状态：** 已确认，待实施  
**范围：** 修复对话 LLM 的 429 限流处理；使 DRAFT 私聊在未满足 Shared 规划前提时给出准确、可执行的交接提示。  
**不在范围：** 改变 Shared 授权边界、自动激活 Trip、放宽城市级目的地约束、增加 provider、迁移数据库、修改 booking 或 Shared 规划逻辑。

## 1. 目标与验收结果

本变更交付两个彼此独立、可分别发布的结果：

1. Gemini/OpenAI-compatible 模型返回 HTTP 429 时，`CONVERSATION` task 不得因指标记录失败而成为 `INTERNAL`；系统应记录有界 `rate_limited` 指标并继续既有的重试、退避或 fallback 路径。
2. DRAFT 私聊只有在出发地、单一可解析城市目的地、日期齐备且 owner 点击“开始规划”后，才进入 Shared planning。缺字段时，Personal 对话和 UI 必须明确展示缺什么及下一步，不能暗示 Shared 规划已经开始。

完成后必须满足：

- 429 的日志/trace 仍保留安全错误分类，`agent_task_runs` 不会因 `MetricLabelError` 失败。
- `llm_request_errors_total{provider,error_category="rate_limited",retryable="true"}` 可被采集，且不存在任意错误文本作为 label 的路径。
- 本次普通 brief 对话的 `DRAFT` 状态不创建 `constraint_snapshots`、snapshot-bound `PLAN`/`REPLAN`/`RESEARCH` task 或 itinerary plan；已独立授权的 `PERSONAL_RESEARCH` 行为不受本方案改变。
- “法国”等国家级表述不被写成目的地城市；聊天明确解释需选择城市，并保留用户点击“开始规划”的显式授权门。

## 2. 已确认的系统事实

### 2.1 现有技术栈与运行边界

| 层 | 当前实现 | 本变更处理方式 |
|---|---|---|
| Web | Next.js、React、TypeScript、TanStack Query | 修改 DRAFT 交接状态的显示与 action gating；不新增全局业务状态。 |
| API | Node.js、TypeScript、Fastify、Zod | 复用 `POST /trips/:tripId/activate` 与现有 DTO；不新增 API。 |
| 异步执行 | PostgreSQL `agent_task_runs`、lease Worker、SSE | 保持 `CONVERSATION` 与 planning task 分派；修复 LLM 失败路径不能反噬 task。 |
| 数据库 | PostgreSQL + Drizzle | 不新增表、列、索引或 migration。 |
| LLM | `ModelGateway`，Gemini/OpenAI-compatible provider | 修改 error-to-metric 映射；保留现有 429 长退避策略。 |
| 可观测性 | Pino NDJSON、OpenTelemetry、进程内有界 Prometheus registry | 扩展固定枚举并更新文档/测试；不将 trip/thread/run ID 放入 metric label。 |

### 2.2 当前调用链

```text
Browser private thread
  → POST conversation turn
  → agent_task_runs(operation=CONVERSATION)
  → Agent Worker.handleConversationTask
  → travel.conversation (Personal)
  → ModelGateway.streamConversationReply
  → provider HTTP response

provider 429
  → classifyError() = RATE_LIMITED
  → recordRetryableError()
  → metrics.inc(llm_request_errors_total)
  → existing retry / rate-limit backoff / fallback semantics
```

Shared 不在该链路中直接回复聊天。它只有在 owner 通过现有激活端点提交完整 brief 后才由 Worker 处理：

```text
Personal private conversation
  → creator confirms draft brief
  → shared_trips remains DRAFT until explicit UI action
  → POST /trips/:tripId/activate
  → transaction: DRAFT → PLANNING + snapshot + accepted planning task (solo)
  → Worker.handlePlanningTask
  → Shared typed skills and plan persistence
```

## 3. 问题与根因

### 3.1 429 被二次故障覆盖

`classifyError()` 已将 HTTP 429 归类为 `RATE_LIMITED`。`recordRetryableError()` 随后用 `code.toLowerCase()` 写入 `rate_limited`。但 `metrics.ts` 中 `llm_request_errors_total.error_category` 的固定 allow-list 没有 `rate_limited`。`MetricsRegistry` 因此抛出 `MetricLabelError`，中断 conversation error path，使 Worker 将 run 标记为 `FAILED / INTERNAL`。

该错误已在本地 Worker 日志中复现：provider 记录 HTTP 429 后，同一 run 紧接着出现 `MetricLabelError`。

### 3.2 DRAFT 对话提示与状态机事实不一致

Personal 对话允许讨论国家级目的地和路线方向，但 Shared activation 要求目的地可解析为唯一城市。`proposeTripBriefFromTurn()` 与 draft write boundary 都会 fail closed；国家、歧义城市或缺出发地不会进入可激活 brief。当前模型通用提示在信息不足时仍可能使用“开始具体规划”等措辞，造成用户以为 Shared 已可执行。

这不是把 `CONVERSATION` 路由到 Personal 的错误。该路由是授权设计：DRAFT 私聊不得触发 Shared handoff；只有明确 UI action 才能执行激活。

## 4. 模块处置

| 模块 | 处置 | 具体改动 |
|---|---|---|
| `apps/api/src/providers/llm-gateway.ts` | 修改 | 引入受控的 LLM metric category 归一化函数；`RATE_LIMITED` 映射到 `rate_limited`，再写指标。保留 `isRetryableUpstreamError()` 与 20s+ jitter 的限流退避。 |
| `apps/api/src/observability/metrics.ts` | 修改 | 在 `llm_request_errors_total.error_category` allow-list 增加唯一固定值 `rate_limited`。不得删除校验或接受自由文本。 |
| `apps/api/src/observability/README.md` | 修改 | 同步该 metric 的枚举和 429 语义。 |
| `apps/api/tests/**` | 修改/新增 | 覆盖 429 指标、重试/失败路径和 label boundedness。 |
| `apps/api/src/providers/llm-gateway.ts` 的对话提示 | 修改 | 为 DRAFT + 缺字段场景加入明确的“先选城市/补出发地，再确认并开始规划”约束；不能命令模型自动激活。 |
| `apps/web/src/components/explore/travel-agent-chat.tsx` | 修改 | 复用 `canStartSharedPlanning`，将缺失字段转化为准确 UI 提示或 disabled-action 说明；按钮继续仅调用既有 activate mutation。 |
| `apps/web/messages/{zh,en}.json` | 修改 | 增加/更新中英文缺字段和国家级目的地提示。 |
| `apps/api/src/routes/trips.ts` | 复用，不修改 | `POST /trips/:tripId/activate` 继续是唯一 `DRAFT → PLANNING` 写入边界。 |
| `apps/api/src/services/trip-brief-proposal-service.ts` | 复用，不修改 | 保持城市解析和 fail-closed 正规化；国家不可降级为任意城市。 |
| `apps/api/src/tasks/handlers/conversation-task-handler.ts` | 复用，按需要最小修改 | 保持 DRAFT 禁止 handoff。仅当 UI 所需缺字段已在 server context 中具备时，可添加安全、无正文的 readiness DTO；优先避免新增接口。 |
| schema/migrations/provider adapters/Shared skills | 不修改 | 本变更不改变数据模型、provider 或 Shared authority。 |

## 5. 详细设计

### 5.1 LLM 限流指标修复

#### 5.1.1 固定错误枚举

将 `llm_request_errors_total.error_category` 的允许集合确定为：

```text
upstream_5xx | upstream_failure | network | timeout |
schema_parse | tool_protocol | rate_limited | unknown
```

实现中建立一个局部类型或只读映射，例如：

```ts
type LlmMetricErrorCategory =
  | "upstream_5xx" | "upstream_failure" | "network" | "timeout"
  | "schema_parse" | "tool_protocol" | "rate_limited" | "unknown";
```

`recordRetryableError(provider, code)` 必须先将内部错误码映射到该 union。任何未来未映射 code 一律归为 `unknown`，不得直接下传 `toLowerCase()` 的任意值。

#### 5.1.2 429 语义

- `classifyError()` 识别 status 429 或 quota/rate-limit 文本后返回 `RATE_LIMITED`；保持现状。
- `isRetryableUpstreamError("RATE_LIMITED")` 返回 true；保持现状。
- `computeBackoffMs()` 对限流采用 `MODEL_GATEWAY_RATE_LIMIT_BACKOFF_MS`（默认 20 秒）加有界 jitter；保持现状。
- 指标记录不得抛出并阻断 retry/fallback。正常路径的实现保证来自 allow-list 的输入；作为防御性要求，指标调用若仍发生 programmer error，必须被限制在 observability boundary 内并记录安全日志，不得覆盖原始 provider error。

最后一项应仅在现有 registry 不能保证 total mapping 时实现；不可把所有指标异常静默吞掉。对未知 category，应记录 `unknown` 并保留一个安全、固定的 diagnostic error code。

#### 5.1.3 可观测性契约

- Metrics：`llm_request_errors_total{provider, error_category, retryable}`，所有 label 低基数。
- Logs：保留现有 `component=llm`、`operation=travel.conversation`、`errorCode=RATE_LIMITED`、latency 和 trace context；不得记录 prompt、对话正文、API key 或 provider 原始错误 body。
- Traces：保留 `llm.outcome` / `llm.error_code` 的安全分类；不要添加 user/trip/thread 值。
- Durable task：原始上游耗尽重试后可进入既有 fallback/失败语义；不得用 `INTERNAL` 伪装限流。

### 5.2 DRAFT→Shared 交接提示

#### 5.2.1 权威状态与计算

权威来源始终是 `shared_trips`：

```text
canStartSharedPlanning =
  status === DRAFT
  && departureCities.length > 0
  && destinationCandidates.length > 0
  && travelDateStart exists
  && (travelDateEnd exists || travelDays exists)
```

该条件已在 Web 使用。服务端 activation route 仍是最终权威，必须重新校验 creator、DRAFT status、日期、trip mode 和城市正规化。

缺口计算只可包含枚举字段：`departure_city`、`destination_city`、`travel_dates`。不能把私聊文本、Profile、候选 rationale 或 provider 数据返回到客户端。

#### 5.2.2 对话与 UI 行为

| 当前状态 | Personal 回复和 UI 行为 | 禁止行为 |
|---|---|---|
| 国家级目的地（如法国），无城市 | 明确要求选择一个起始城市或候选城市；可给出“巴黎/里昂/尼斯”等作为用户可选方向，但不把其中任一写入 brief。 | 自动把国家映射为首都或隐式选城市。 |
| 已有城市，缺出发地 | 明确索取出发城市。 | 以 Profile、历史 thread 或模型猜测填充。 |
| 已有城市/出发地，缺日期 | 请求日期或时长。 | 生成 Shared task 或 provider 调用。 |
| brief 齐全但仍 DRAFT | 显示“开始规划”CTA，说明点击会进入完整规划。 | 因用户自然语言“确认”或模型输出自动调用 activate。 |
| 已激活 | 沿用 Shared plan surface 与既有 planning task 流程。 | 在私聊中把 Shared 视为普通聊天机器人。 |

模型提示必须把“可以讨论安排方向”与“可以开始完整规划”明确区分：只有 `canStartSharedPlanning` 为 true 时才允许后者。若仅由 prompt 不能可靠利用该状态，应在 `PersonalTripContext` 中增加仅含该布尔值和缺口枚举的安全字段，并更新 Zod schema、handler 组装和测试；不引入原始 brief 文本。

#### 5.2.3 接口设计

不新增 public endpoint。复用：

| 方法 | 路径 | 责任 |
|---|---|---|
| `PATCH` | `/api/v1/trips/:tripId/draft-brief` | creator 明确确认的 brief 字段写入；继续执行城市解析与日期校验。 |
| `POST` | `/api/v1/trips/:tripId/activate` | 唯一激活入口；solo 在原子事务中创建 snapshot 和首个 planning task。 |
| `GET` | `/api/v1/trips/:tripId` | 前端刷新权威 trip 状态和已有 brief 字段。 |

既有返回码保持不变：城市不明确为 `422 DESTINATION_UNRESOLVED`；日期不合法为 `400 BRIEF_DATES_INVALID`；非 DRAFT 激活为 `409 TRIP_NOT_DRAFT`。前端只将这些转为用户可理解的修正提示，不能重试或伪造字段。

### 5.3 数据模型

本变更不执行 migration。

| 对象 | 继续使用的字段 | 约束 |
|---|---|---|
| `shared_trips` | `status`、`departure_cities`、`destination_candidates`、`travel_date_start`、`travel_date_end`、`travel_days` | DRAFT 信息仅由 creator 确认写入；城市必须通过 server resolver。 |
| `agent_task_runs` | `operation`、`status`、`error_code`、`trip_id`、`thread_id` | 普通对话任务继续为 `CONVERSATION`；禁止因 metric label 缺陷失败为 `INTERNAL`。 |
| `constraint_snapshots`、`itinerary_plans` | 无新增字段 | DRAFT 期间必须保持无行。 |
| Prometheus in-process registry | `llm_request_errors_total` | 只扩展固定 label 枚举；不持久化业务/个人数据。 |

`agent_runs.run_id` 目前不是 `agent_task_runs.id` 的外键，不能用数据库 join 将二者直接关联。本实施不改变该历史设计；排障使用 Worker log 中的 `relatedRunId` 与安全 trace context。若要改善关联，必须另开 migration/隐私评审任务，且不能把关联 ID 作为 metric label。

## 6. 实施阶段与依赖

### Phase 1 — 429 韧性修复

**依赖：** 无。

1. 在 `llm-gateway.ts` 建立内部错误码到 `LlmMetricErrorCategory` 的总映射。
2. 在 `metrics.ts` 注册 `rate_limited`。
3. 更新 observability 文档。
4. 编写并通过 429、未知错误码、label boundedness 测试。
5. 在本地受控 provider stub 下验证日志、指标、task 终态。

**完成门槛：** 429 不产生 `MetricLabelError`；没有任意 error_category label；测试验证 retry/fallback 或既有稳定终态。

### Phase 2 — DRAFT 交接可理解性

**依赖：** Phase 1 无强依赖，可并行开发；发布前共同回归。

1. 审核 `PersonalTripContext` 是否已足以确定缺口；只有不足时才添加最小安全 DTO 字段。
2. 修改 DRAFT conversation prompt/response constraints，使用真实状态表达下一步。
3. 修改 chat UI，复用 `canStartSharedPlanning`，显示缺口与 disabled CTA 说明。
4. 更新中英文文案。
5. 编写 API/worker/component tests，验证国家、城市、出发地、日期和显式 CTA 的组合。

**完成门槛：** “法国 + 日期”不宣称 Shared 已启动；城市、出发地、日期齐全后 CTA 可用；只有点击 CTA 才产生 activation/snapshot/task。

### Phase 3 — 集成与发布验证

**依赖：** Phase 1、Phase 2。

1. 运行 API typecheck、lint、相关 unit/integration tests 和 Web component tests。
2. 使用 HTTP 429 stub 做端到端 conversation test；不得调用真实 provider 或使用 runtime fixture。
3. 使用 DRAFT Solo trip 做端到端 brief test：国家→城市→出发地→日期→确认→开始规划。
4. 检查 `/metrics` 的固定 labels、NDJSON 日志中的安全字段和数据库中 DRAFT/activation 不变量。

## 7. 测试矩阵

| 编号 | 场景 | 断言 |
|---|---|---|
| RL-1 | provider HTTP 429，流式对话尚未输出 | metrics 接受 `rate_limited`；不抛 `MetricLabelError`；执行限流退避后按既有策略 retry/fallback。 |
| RL-2 | provider HTTP 429，已输出部分 delta | 不拼接重试内容；task 采用现有可诊断终态；不会因 metrics 变为 `INTERNAL`。 |
| RL-3 | 新的未映射内部 code | metric 使用 `unknown`；无动态 label。 |
| RL-4 | metrics registry | `rate_limited` 被允许；任意未注册值仍拒绝，保护低基数约束。 |
| DH-1 | DRAFT，国家级目的地 + 完整日期 | 不创建 destination city、snapshot 或 planning task；UI/对话请求城市。 |
| DH-2 | DRAFT，城市 + 日期，缺出发地 | Start planning 不可用；只提示出发地。 |
| DH-3 | DRAFT，城市 + 出发地 + 日期 | CTA 可用；点击前无 snapshot/task。 |
| DH-4 | DH-3 点击 CTA | 唯一 activation transaction；Solo 创建 snapshot 和 planning task；重复请求幂等。 |
| DH-5 | 任意自然语言“确认/开始”但未点击 CTA | 保持 DRAFT；不得自动激活。 |
| DH-6 | 不明确或不存在的城市 | `DESTINATION_UNRESOLVED`；不回退为国家或模型猜测。 |

## 8. 风险与约束

| 风险 | 控制措施 |
|---|---|
| 为修复 429 放开自由 metric label，导致高基数 | 只增加 `rate_limited`，并用 union/映射及 registry test 强制枚举。 |
| 吞掉 observability 故障，掩盖编程错误 | 仅在已归一化 mapping 的边界处理；未知值映射 `unknown` 并保留安全日志。 |
| 文案修复意外变成自动激活 | `POST /activate` 继续仅由 CTA mutation 调用；增加“自然语言不可激活”回归测试。 |
| 国家到城市的自动推断导致错误 itinerary | 保持 `LocationReferenceResolver` 的唯一城市要求与 fail-closed 行为。 |
| 将私聊内容用于 readiness/指标 | DTO 和 metric 只传安全枚举；禁止正文、Profile、坐标、thread/trip ID labels。 |
| 429 retry 增加用户等待 | 复用当前较长退避；UI 显示可理解的处理中/稍后重试状态，不重复提交 task。 |

## 9. 交付清单

- API：`llm-gateway.ts`、`metrics.ts`、相关 API tests。
- Web：DRAFT handoff 文案、Chat CTA/缺口展示、组件 tests、`zh/en` messages。
- 文档：本文件、`observability/README.md`、`docs/test-scenarios.md`。
- 验证记录：typecheck、lint、目标测试、429 stub E2E、DRAFT activation E2E 的命令与结果。

不需要：新环境变量、数据库 migration、provider credential、真实支付/预订、Shared Agent 直接聊天入口。
