# Agent Architecture

**状态：** 当前 Hackathon MVP 的推荐实现架构  
**范围：** 仅定义 Agent、Skill、工具、状态与控制边界；产品范围与安全约束仍以 TECH_STACK.md、docs/PRD.md 和 AGENTS.md 为准。

## 1. 架构总览

### 核心决策

采用 Skill 驱动的多 Agent 协作架构：

- 每个成员拥有一个隔离的 Personal Travel Agent；
- 共享行程由一个 Shared Trip Agent 协调；
- Agent 不自由交换自然语言消息，而是通过经授权、字段最小化且不可变的 constraint snapshot 交接；
- Agent 的认知和工具选择由 Skill 驱动；授权、版本、确认、幂等和 sandbox booking 留在确定性的服务端控制平面。

这不是“用工作流替代 Agent”。系统分为三层：

| 层 | 责任 | 实现方式 |
|---|---|---|
| Agent / Skill 平面 | 理解意图、选择允许的 Skills、有限任务规划、解释取舍、生成变更提案及审查说明质量。 | 经 ModelGateway 接入 OpenAI Agents SDK；每个 Skill 有类型、权限与输出契约。 |
| 协作平面 | Personal Agent 将明确授权的约束交给 Shared Trip Agent；Shared Agent 综合多人约束。 | consent grants 经服务端构建为 constraint snapshots，而不是 Agent 间聊天。 |
| 控制平面 | 守住业务不变量和不可逆操作边界。 | PostgreSQL、领域服务、事务、版本、STALE、确认门槛、幂等、audit 和 outbox。 |

### 为什么不是自由 Multi-Agent

产品概念是多 Agent：不同用户的 Agent 参与同一旅行协作。但运行时不应让它们自由讨论、互相调用工具或共享完整上下文。当前仓库的核心约束——Profile 默认私有、字段级 consent、不可变 snapshot、plan stale、三人确认与 sandbox——要求协作可验证、可撤回、可审计。

自由 Agent-to-Agent 消息传递会导致未授权数据泄露、竞争写入、循环推理、成本不可控，以及无法说明某条结论是否仍有效。正式协作语言应是授权 snapshot，而不是 prompt。

### 不做 RAG / 资料库

当前 MVP 不建立 RAG、向量库、文档检索或 MCP knowledge server。事实源均为结构化数据：

- 用户明确保存的 user_profiles 和 preference_facts；
- 本行程获授权的 consent_grants 和 constraint_snapshots；
- 版本化 travel / visa fixtures，或未来的 typed live provider；
- provider_offers、source_evidence 与 visa_readiness_checks。

三位用户、2–3 个固定候选目的地和版本化 fixture 不构成非结构化知识检索问题。RAG 会增加索引更新、来源过期、误检索、prompt injection 与敏感数据暴露面，却不能解决本项目核心问题：授权边界和多成员方案一致性。

## 2. Agent 拓扑

| Agent | 运行上下文 | 职责 | 输入 | 输出 | 明确边界 |
|---|---|---|---|---|---|
| Personal Travel Agent | 单一已认证用户的私有空间 | 维护和解释用户偏好；把消息转为 Profile 或 trip override 提案；解释本人正在共享什么。 | 私有消息、自己的 Profile、自己的 override、自己的 consent 摘要。 | 私有回复、结构化变更提案、需确认的操作。 | 不读取其他成员；不自动写 Profile；不授予 consent；不传递私有对话或未授权字段。 |
| Shared Trip Agent | 某个共享 trip 的授权上下文 | 将多人已授权约束与旅行事实组合为候选比较、差异解释和成员待办。 | constraint snapshot、规范化 provider offers、readiness、旧/新 plan。 | 经校验的 PlanSynthesis、候选解释、冲突或恢复建议。 | 不读取 Profile/聊天原文；不推断国籍；不直接写状态；不 booking 或支付。 |
| Plan Review Agent（可选） | Shared Agent 的受限审查步骤 | 审查解释清晰度与恢复建议，不重新创造事实。 | 通过确定性校验的安全 plan 摘要和 evidence 引用。 | 结构化 review。 | 不覆盖硬性校验；不改 offer、eligibility、consent 或 readiness。 |

Plan Review Agent 是可选的短生命周期反思能力，不是能自行循环调用工具的自治实体。

### 协作与交接

~~~text
个人私有 Profile / trip override
        ↓
Personal Agent（仅私有 Skills）
        ↓ 用户显式保存 / 授权
ConsentExportSkill（服务端）
        ↓
不可变 constraint snapshot
        ↓
Shared Trip Agent（仅共享 Skills）
        ↓
候选比较、成员待办、plan 解释
        ↓
确定性确认与 booking 控制平面
~~~

交接数据必须：

1. 由 ConsentService.buildAuthorizedData 从生效 consent 构建，不能由 Agent 自行挑选；
2. 只含本次规划必要且已授权的字段；永不含 passport number、私有对话或未授权国籍；
3. 在 constraint_snapshots 中持久化、版本化且不可变；
4. 任一授权、约束、价格或库存变化都会使依赖它的 plan/confirmations 进入 STALE；
5. Shared Agent 只能消费 snapshot，不能回读成员私有存储。

## 3. Skill Architecture

### Skill 契约

Skill 不是一段 prompt。每个 Skill 都是代码级能力契约：

~~~text
Skill = 输入 Zod schema
      + 所需权限 / 数据范围
      + 允许的 typed tools
      + 输出 Zod schema
      + 审计事件
      + timeout / retry / fallback 规则
      + 是否需要用户确认
~~~

模型只能选择已注册且已授权的 Skill，不能获得任意数据库、HTTP、filesystem、MCP 或 booking tool。

### 推荐 Skills

| Skill | 所属 Agent | 输入 / 输出 | 可复用模块 | 权限与限制 |
|---|---|---|---|---|
| ProfileMemorySkill | Personal | 查询意图 → 私有 profile 摘要。 | userProfiles、preferenceFacts、profiles route/service。 | 仅当前用户；只读。 |
| ProfileChangeProposalSkill | Personal | 私有消息 → 字段级 change proposal。 | createProfileSchema、updateProfileSchema。 | 模型不能写库；用户确认后才更新。 |
| TripOverrideProposalSkill | Personal | 本次要求 → trip-specific constraint proposal。 | 新增 trip override storage/service。 | 与长期 Profile 分离；不能自动共享。 |
| ConsentExplanationSkill | Personal | 本人 grants → “我正在共享什么”。 | getActiveConsents。 | 不显示其他成员授权。 |
| TravelConversationSkill | Personal | 当前问题 + 可选最小 place context + 安全 recall → 私有回答。 | ModelGateway.generateConversationReply。 | 不接受客户端角色；不声称 live price、库存、visa 或 booking；fallback 显式标记。 |
| ConsentExportSkill | 服务端协作边界 | trip + active grants → 最小化 snapshot。 | buildAuthorizedData、createConstraintSnapshot。 | 不由模型执行；禁止 passport number。 |
| CandidateResearchSkill | Shared | snapshot + candidate → ResearchBundle。 | FlightProvider、StayProvider、GroundProvider、fixtures。 | 只请求已配置候选；失败必须明确 fallback。 |
| ReadinessSkill | Shared | 授权国籍 + 成员 + 路线 → readiness 或 verification gap。 | VisaProvider、checkVisaReadiness。 | 未授权不得推断；不得法律建议。 |
| PlanComparisonSkill | Shared | candidate bundles + 约束摘要 → 带 evidence ID 的 PlanSynthesis。 | ModelGateway.generateStructuredPlan。 | 不生成新的 offer、价格或签证结论。 |
| PlanDiffExplanationSkill | Shared | safe old/new plan → diff explanation。 | ModelGateway.explainPlanDiff。 | 只解释持久化差异，不改变状态。 |
| PlanReviewSkill（可选） | Review | 已校验 plan/explanation → 可读性 review。 | 新增受限 gateway 调用。 | 仅软性审查；无 DB/tool write 权限。 |
| ConfirmationSkill | 控制平面 | 用户 + plan + decision → 权威确认状态。 | ConfirmationService。 | 不经模型；仅 required member 可确认当前 ACTIVE plan。 |
| BookingSandboxSkill | 控制平面 | plan + quorum + request ID → sandbox execution。 | BookingService。 | 不经模型；无真实支付。 |

## 4. 单用户 Agent：Memory、Tools 与 Plan-and-Execute

Personal Agent 默认采用 Memory-Augmented + Tool-Augmented；仅在必要时使用有限的 Plan-and-Execute。

### Memory-Augmented

| 记忆类型 | 现有位置 | 使用规则 |
|---|---|---|
| 长期个人偏好 | user_profiles、preference_facts | 用户可查看、编辑、删除；仅 Personal Agent 私有读取。 |
| 本次行程偏好 | 当前未实现 | 新增独立 trip override；不得静默覆盖长期 Profile。`this trip` 标记 = 线程创建时绑定的 tripId。 |
| 私有对话 archive | 已实现（migrations 0006/0008） | `chat_threads`（归属 `ownerUserId`，可选 `tripId`）+ `chat_messages`。USER 由 authenticated owner 发送；ASSISTANT 的 sender 为 null，且角色/sender 组合由 DB CHECK 约束。owner UI 可经专用 endpoint 恢复 raw history；`thread.recall` 仍只返回安全摘要，trip 关联不赋予其他成员或 Shared Agent 读取权限。 |
| 共享协作记忆 | consent_grants、constraint_snapshots | 仅通过服务端最小化导出；snapshot 不可变。 |
| 运行事实 | provider_offers、source_evidence、visa_readiness_checks、itinerary_plans | 用于重建证据；不作为聊天长期记忆。 |

私有对话 archive 是 MVP 已确认的能力：保存的 raw transcript 只能由所有者通过 `GET /threads/:threadId/conversation` 回看，且支持线程级删除。`POST /threads/:threadId/turns` 先执行 owner/idempotency 检查，再以 `thread.recall → travel.conversation → ModelGateway` 生成回答，最后用短事务持久化 USER、ASSISTANT、安全 audit 与不含正文的幂等结果。模型等待期间不持有数据库事务。默认 recall 只包含最多 20 条、每条最多 1000 字的非空安全摘要；完整 raw transcript 不进入 audit、metrics 或 Shared Agent context。`redacted_summary` 的通用生成 worker 仍未实现，因此未标记/未摘要的历史不会进入后续 Agent recall。

### Tool-Augmented

Personal Agent 可以调用受限 Skills 来读取自己的 Profile、解释 consent、生成 proposal；它不能直接使用任意 tool。

### 何时使用 Plan-and-Execute

只有请求具备多个步骤、可能修改数据或影响共享边界时才启用。例如：

~~~text
“这次东京行程不要红眼，但不要改我以后默认偏好。”
  → 识别字段
  → 判断为 trip override，而非 Profile 修改
  → 生成可展示 proposal
  → 等待用户确认
  → 服务端写入 override 并使相关 plan stale
~~~

查询型请求不需规划循环，例如“我目前共享了什么？”直接调用 ConsentExplanationSkill。每条消息都走 Plan-and-Execute 会增加延迟、成本和不可预测性。

Plan-and-Execute 必须有最大步数、总 deadline、每步 schema 校验和停止条件；不得形成开放式自主循环。

## 5. 多用户协作与反思

### Shared Trip Agent 执行过程

1. 服务端校验成员、trip 与 consent；
2. ConsentExportSkill 生成不可变 snapshot；
3. Shared Agent 为全部配置候选调用 CandidateResearchSkill 和 ReadinessSkill；
4. 收集并 normalize 每个 provider outcome、offer、source 与 demo 标记，作为当前 run 的 evidence；
5. PlanComparisonSkill 只根据安全 snapshot projection 和已验证 research bundles 生成结构化比较；
6. 确定性 policy/evidence validator 校验输出；
7. 可选 PlanReviewSkill 审查取舍、缺口和恢复路径是否表达清楚；
8. 校验成功后，服务端持久化 plan、provider offers、source evidence 与 audit，并激活/替代版本；确认和 booking 始终在 Agent 之外执行。校验失败时不写入任何 authoritative plan/evidence state。

### Reflective Agent 的正确位置

反思能力有价值，但不能成为事实或安全判断的来源。

| 检查问题 | 负责者 |
|---|---|
| 是否覆盖全部配置候选？是否引用有效 offer/evidence？是否保留来源标签？ | 确定性 validator。 |
| 是否引用未授权字段？是否错误声称签证结论？是否试图 booking？ | 确定性 policy gate。 |
| 取舍说明是否清楚？是否指出冲突成员？无可行方案时是否给出恢复路径？ | 可选 PlanReviewSkill。 |

PlanReviewSkill 是一次受限 review pass，而不是反复自我批评、重试和调用工具的自治 Reflective Agent。它不应显著拉长 Hero Demo，也不能覆盖硬性校验结果。

## 6. 执行、失败恢复与控制平面

### 必须保留确定性控制的状态转换

~~~text
profile / consent / constraint / provider change
  → 创建或更新权威记录
  → 相关 snapshot、plan、confirmation 标记 STALE
  → 创建新 snapshot
  → Shared Agent 重新规划
  → 所有 required members 确认同一 latest ACTIVE plan
  → sandbox booking
~~~

现有 constraintSnapshots、itineraryPlans、memberConfirmations、bookingExecutions、idempotencyRecords、auditEvents 和 outboxEvents 正是控制平面的基础。这部分不能被 Skill 选择或 Agent 自主决策取代。

### Sequential、Parallel 与 Event-driven

- **Sequential：** membership/consent 校验 → snapshot → run-scoped evidence 收集 → plan synthesis → hard validation → authoritative plan/evidence persistence 与 activation。
- **Parallel（有上限）：** 不同 candidate 的研究、不同 departure city 的 flights、member/candidate readiness；使用 Promise.allSettled、并发上限和 request deadline。
- **Event-driven：** consent/profile/constraint/provider change 和 callback 在事务中写入 outbox_events；MVP 使用进程内 polling worker，无需 Redis、Temporal 或 Step Functions。

### Timeout、Retry、Fallback

| 边界 | 规则 |
|---|---|
| Travel provider | 单调用 deadline；只对瞬态失败做有限 retry；失败、无数据或不可信时返回版本化 fixture，明确标记 Demo data。 |
| Model / Skill 执行 | 限制最大步骤、输出大小和总 deadline；只对传输/限流错误做一次 retry。schema/policy failure 不扩大 prompt 重试，而是安全失败。 |
| Plan comparison | 模型失败时降级为确定性候选列表和 evidence 摘要；不得生成未经验证的解释或事实。 |
| Idempotency / callback | 副作用前原子 claim；callback 必须独立认证、关联预期 booking execution，并按 provider event ID 去重；late callback 不覆盖终态。 |
| 恢复 | timeout/failed run 保留安全 step outcome；下一次触发从新 snapshot 开始，不恢复使用旧 snapshot 的半完成 plan。 |

provider 层已使用判别联合 `ProviderResult<T>`，其 `outcome` 为 `LIVE | FALLBACK_DEMO | UNAVAILABLE`。fixture 命中返回带固定来源、采集时间、fixture version 与 fallback 原因的 `FALLBACK_DEMO`；fixture 缺失返回不含 `data` 的 `UNAVAILABLE`，调用方必须先 narrowing。

当前 planning control plane 在 `ModelGateway` 输出与 `itineraryPlans` 写入之间执行两层确定性校验：

1. `snapshot-policy.ts` 只允许引用实际存在于 immutable snapshot 的 `authorizedData.<memberId>.<fieldName>`；路径缺失、格式不明确或字段未授权均 fail closed。
2. `plan-output-validator.ts` 使用 strict Zod schema 校验结构，并校验所有 origin/destination、source/capturedAt/fixtureVersion，以及选中 offer 与当前 planning run provider evidence 的完整对象一致性。

失败统一抛出 `PlanValidationError`（HTTP `422`）。`violations` 仅包含稳定 code、field path 和低风险 reason，不回显模型值或 snapshot 私密内容；失败发生在任何 plan/provider/evidence persistence 之前。

## 7. Tool、权限与安全

~~~text
Personal Agent → 私有 Skills → 个人 Profile / trip-override 服务
                         ↓（用户明确 grant）
                 ConsentExportSkill → constraint snapshot
                         ↓
Shared Trip Agent → shared Skills → typed provider adapters / ModelGateway
                         ↓
          policy + evidence validator → PostgreSQL plan state
                         ↓
        ConfirmationService / BookingService（非 Agent）
~~~

| 调用方 | 可访问内容 | 不可访问内容 |
|---|---|---|
| Personal Agent | 当前用户 Profile、自己的 override、自己的 consent。 | 其他成员、共享前私密 profile、booking。 |
| Shared Trip Agent | 当前 snapshot、规范化 offers/readiness/evidence、safe old/new plan。 | 私有 profile、聊天记录、passport number、未授权 nationality。 |
| ModelGateway | Skill 传入的预校验 JSON。 | DB connection、HTTP client、filesystem、credentials、通用 MCP client、payment/booking tool。 |
| Provider adapter | 单一 provider 所需的最小路线/日期参数。 | 完整 profile、私有消息、无关成员数据。 |
| 控制平面服务 | 领域状态和事务。 | 以模型输出绕过授权或 quorum。 |

### Prompt injection / tool misuse 防护

1. 用户、provider、fixture 和未来外部文本都是数据，不是指令；
2. 所有进入模型的内容先做 schema normalization；模型只可调用 allow-list Skills；
3. 每个模型输出先经 Zod，再经 authorization/evidence/action policy 校验；
4. 不将 passport/document number、raw transcript、unshared profile、credentials 或 raw headers 放入 prompt、日志、trace、metric labels 或客户端持久状态；
5. schema/policy failure fail closed：不能激活 plan，不能确认，不能 booking；
6. bookings callback 已独立使用 provider HMAC signature/secret 验证：签名覆盖 timestamp 与精确 raw body，使用五分钟窗口和 timing-safe comparison，并在通过后校验预期 execution。

## 8. 模型路由与取舍

ModelGateway 是唯一模型边界。`gateway-factory.ts` 只构建已完整配置的真实 `LLMGateway`；`LLMGateway` 使用结构化输出、有限 retry、prompt/model version 与 agent-run recording，并在 upstream/schema failure 时失败关闭。测试可注入 fake gateway，但生产不使用 mock fallback。模型输出只是 candidate，必须通过对应的 plan 或 conversation policy 后才能持久化。

| 任务 | 模型策略 | 取舍 |
|---|---|---|
| Profile / override 提案 | 低延迟 structured extraction + 用户确认。 | 低成本；错误不会自动写入长期记忆。 |
| 私有资料或 consent 解释 | 直接 Skill 或小模型总结。 | 事实由服务端提供，无需昂贵推理。 |
| 候选比较 | 确定性筛选先行，结构化模型解释取舍。 | 输入只有 2–3 candidates；优先 schema reliability 与可解释性。 |
| Plan diff | 结构化模型解释已验证 diff；确定性 field diff 是 fallback。 | 使用低成本、低延迟模型。 |
| Readiness、价格、库存、授权、确认、booking | 不用模型。 | 只能由 fixture/provider 和领域服务决定。 |
| Plan review | 可选小模型、单次受限 review。 | 只提升说明质量；不替代硬性 validator。 |

每次模型调用设置 deadline、max output size、JSON schema、低 temperature 以及 prompt/schema/template version。记录模型名、token/cost、结果和安全 hash 到 agent_runs；默认不保存 raw prompt/completion。

### LLM gateway trace sites

`apps/api/src/providers/llm-gateway.ts` opens a `SpanKind.CLIENT` span on
each of its three outbound paths (`generateStructuredPlan`,
`generateConversationReply`, `streamConversationReply`). The span name is
`llm.openai.parse` for structured calls and `llm.openai.stream` for the
streaming conversation path. Attributes use the `llm.*` namespace and are
gated by `apps/api/src/observability/tracing.ts#FORBIDDEN_SPAN_ATTRIBUTE_KEYS`:

| Attribute | Source | Notes |
| --- | --- | --- |
| `llm.system` | constant | always `"openai-compatible"` |
| `llm.provider` | `LLMGatewayOptions.provider` | low-cardinality enum |
| `llm.model.name` | `LLMGatewayOptions.modelName` | model name (already configured, not free-form) |
| `llm.model.prompt_version` | `LLMGatewayOptions.promptVersion` | static at deployment |
| `llm.method` | per-site | `plan.comparison` or `travel.conversation` |
| `llm.stream` | per-site | bool |
| `llm.skill.name` | per-site | matches `skillName` in `agent_runs` |
| `llm.tokens.{prompt,completion,total}` | response usage | low-cardinality integer |
| `llm.outcome` | per-site | `"success"` or `classifyError(err)` |
| `llm.error_code` | per-site | bounded enum (TIMEOUT/SCHEMA_PARSE/NETWORK/UPSTREAM_5XX/UPSTREAM_FAILURE) |

The W3C `traceparent` header is forwarded on every outbound SDK call via
`outboundTraceHeaders(ctx)` so downstream services (and OpenAI-aware
proxies) can continue the trace. Inbound `traceparent` from the API request
is installed as the active span in `app.ts#onRequest`, so the LLM span
becomes a child of the inbound HTTP server span by default; background
callers that have no active span fall back to `ctx.traceparent`.

### Durable Worker trace continuity

The Durable Worker is a separate ECS Fargate process; the HTTP request that
accepted a conversation turn cannot be held alive while the Worker runs.
To keep the trace continuous across this boundary:

1. `acceptConversationTask` (`apps/api/src/tasks/task-repository.ts`)
   writes the inbound `RequestContext.traceparent`/`tracestate` into the
   new `agent_task_runs.trace_context` JSONB column (migration
   `0010_agent_task_trace_context.sql`) inside the same transaction that
   inserts the run row.
2. `processNextAgentTask` (`apps/api/src/workers/agent-task-worker.ts`)
   calls `ctxFromRun(run)` to rebuild a `RequestContext` from the
   persisted column and uses it as the active OTel context.
3. The Worker opens `agent_task_worker.run` (`SpanKind.CONSUMER`) with a
   `SpanLink` to the originating HTTP server span. The link is a `link`
   rather than a parent because the original span may have already ended
   by the time the Worker polls — causality is preserved without holding
   the parent alive.
4. SSE events published by the Worker carry the persisted `traceparent`
   on the postgres NOTIFY payload. The SSE relay
   (`apps/api/src/tasks/agent-stream-relay.ts`) re-emits the value to the
   client and uses it to open `sse.event.<type>` spans linked back to the
   same originating trace.

When the persisted `trace_context` is `null` (old rows, recovery, replay),
the Worker opens a fresh root span and tags it with `tasks.recovery=true`
so dashboards can filter it from the live trace path.

## 9. 可观测性与评估

当前仓库已将集中式 Pino 接入 Fastify，并提供 correlation-aware 安全日志、严格 audit summary whitelist 与仅限进程内的低基数 `/metrics` 文本输出。当前仍未初始化 OpenTelemetry trace exporter，也没有生产 metrics exporter、持久化存储或 scraper 配置；不得把 MVP endpoint 描述为完整生产遥测栈。

| 信号 | 必需内容 |
|---|---|
| Logs | trace_id、span_id、correlation_id、run_id、trip_id、plan_version、conversation_id（仅在 chat thread 涉及的操作出现）、agent、skill、operation、result/error code、duration；禁止敏感字段与 prompt text。 |
| Traces | HTTP → auth → consent export → 每个 Skill/provider → model → validation → persistence → outbox/callback。 |
| Metrics | 当前 process-local registry 包含 agent/planning/provider/booking/callback/LLM latency 系列，并为 operation、outcome、provider、errorCategory、validationResult、callbackResult 设置精确 allow-list。不得以 trip/user/plan/booking/run/correlation/request/conversation ID、model name 或自由文本作为 label。 |
| Audit | consent grant/revoke、snapshot creation、skill/run start/end、provider fallback、stale/replan、confirmation/denial、booking/callback、duplicate/out-of-order event、chat thread create/delete。audit summary 允许出现 `conversationId`、`ownerUserId`、`tripId?`、`action`、`timestamp`，但绝不含 message body、raw transcript 或任何派生片段。 |

以版本化 fixture scenarios 进行确定性 evaluation：

- Personal Agent 不读取或输出其他成员数据；
- Profile 提案未经确认不写入；
- ConsentExport 只导出允许字段；
- 所有 candidates 都被研究，选中项都引用有效 evidence ID；
- 未授权 nationality 只输出 verification gap；
- provider failure 显式降级到 Demo data 或 missing-data state；
- 模型/PlanReview 输出不能改变事实、consent、状态或 booking eligibility；
- consent/profile/constraint change 原子地使 plan 与 confirmations stale；
- duplicate event/callback 只产生一个逻辑结果；
- 无 current unanimous quorum 时不能 booking。

核心指标为：plan completeness、evidence coverage、skill schema/policy rejection rate、provider fallback rate、planning p50/p95 latency、token/cost per run、stale-to-replan success、被阻断的 unsafe action attempts，以及可选 explanation quality rubric。

## 10. 架构图

~~~mermaid
flowchart TB
  U1["成员 A"] --> PA1["Personal Travel Agent A"]
  U2["成员 B"] --> PA2["Personal Travel Agent B"]
  U3["成员 C"] --> PA3["Personal Travel Agent C"]

  PA1 --> PS["Private Skills<br/>Profile / override / consent explanation"]
  PA2 --> PS
  PA3 --> PS
  PS --> PROFILE[("Private Profile & trip override")]

  PROFILE -->|"明确 consent"| CES["ConsentExportSkill<br/>server-side policy gate"]
  CES --> SNAP[("Immutable constraint snapshot")]

  SNAP --> STA["Shared Trip Agent<br/>Skill-driven collaboration"]
  STA --> RESEARCH["CandidateResearchSkill<br/>ReadinessSkill"]
  RESEARCH --> PROVIDERS["Typed live / fixture providers"]
  PROVIDERS --> EVID[("offers / evidence / readiness")]

  EVID --> PLAN["PlanComparisonSkill"]
  PLAN --> VALID["Deterministic policy + evidence validator"]
  VALID --> REVIEW["Optional PlanReviewSkill<br/>explanation quality only"]
  REVIEW --> PLANSTATE[("Plan version / STALE state")]

  PLANSTATE --> CONF["ConfirmationService<br/>non-Agent server gate"]
  CONF --> BOOK["BookingSandboxSkill<br/>non-Agent server gate"]
  BOOK --> EXEC[("Booking execution / idempotency")]

  CES --> OBS["Audit + Logs + Traces + Metrics"]
  STA --> OBS
  CONF --> OBS
  BOOK --> OBS
~~~

## 11. 推荐实现与目录结构

### 现有模块复用与必须修正

| 现有位置 | 复用方式 | 必须修正 |
|---|---|---|
| apps/api/src/providers/types.ts | CandidateResearch/Readiness Skills 的 typed ports；已实现 ProviderOutcome 与 fallback 原因。 | 后续增加 deadline 与 cancellation。 |
| apps/api/src/providers/live-provider-factory.ts、types.ts | 生产 provider 能力边界。 | 未配置能力明确 unavailable，不生成静态报价或 evidence。 |
| apps/api/src/providers/model-gateway.ts、llm-gateway.ts、gateway-factory.ts | 唯一模型 anti-corruption layer；已包含结构化 LLM 调用、真实 provider 配置和安全 model/prompt metadata。 | 保持模型输出为 candidate；失败关闭，不使用生产 mock fallback。 |
| apps/api/src/services/consent-service.ts | ConsentExport 基础。 | 校验 field-to-scope；在 transaction 中使受影响 plan/confirmations stale。 |
| apps/api/src/services/planning-service.ts | snapshot/plan persistence。 | 支持全部 candidates，拆分 research/synthesis/activation，并持久化 all-category evidence。 |
| apps/api/src/services/visa-service.ts | ReadinessSkill 基础。 | 从 snapshot 读取实际授权 nationality；删除硬编码 US。 |
| apps/api/src/services/change-event-service.ts | event-driven replan 基础。 | 从 sharedTrips 读取真实 trip 输入；删除硬编码 Tokyo/日期/出发地。 |
| apps/api/src/services/confirmation-service.ts、booking-service.ts、middleware/sandbox-signature.ts | 控制平面 gate。 | callback signature verification、raw-body/timestamp window 与幂等已实现；后续继续加强 DB unique constraints、transactions 与 plan/trip consistency。 |
| apps/api/src/db/schema.ts | 权威状态模型。 | 增加 trip overrides、agent_runs、agent_step_runs，以及关系唯一约束与版本化 migrations。 |
| apps/api/src/utils/context.ts、observability/、audit-service.ts | correlation、Pino、process-local metrics 与 audit whitelist 基础。 | 当前已接入 Fastify 并统一敏感数据 sanitization；生产 OpenTelemetry/exporter 仍是后续工作。 |

### 推荐目录

~~~text
apps/api/src/
  agents/
    personal-travel-agent.ts
    shared-trip-agent.ts
    plan-review-agent.ts
    skill-registry.ts
    contracts.ts
  skills/
    profile-memory-skill.ts
    profile-change-proposal-skill.ts
    trip-override-proposal-skill.ts
    consent-explanation-skill.ts
    consent-export-skill.ts
    candidate-research-skill.ts
    readiness-skill.ts
    plan-comparison-skill.ts
    plan-diff-explanation-skill.ts
    plan-review-skill.ts
  services/
    planning-service.ts
    research-service.ts
    consent-service.ts
    trip-override-service.ts
    readiness-service.ts
    confirmation-service.ts
    booking-service.ts
  providers/
    types.ts
    live-provider-factory.ts
    model-gateway.ts
    llm-gateway.ts
    gateway-factory.ts
  policy/
    snapshot-policy.ts
    plan-output-validator.ts
    callback-verifier.ts
  workers/
    outbox-worker.ts
  observability/
    telemetry.ts
    redaction.ts
  db/
    migrations/
    schema.ts
~~~

### 实施顺序

1. 先修复控制平面不变量：授权变更原子失效、snapshot nationality、真实 trip replan、callback 验证、唯一约束、事务、可重复 migrations/seed；
2. 定义 Skill contracts、registry 和 deterministic policy validator；
3. 实现 Personal Agent 的 ProfileMemory、proposal、consent explanation Skills；Profile/override 写入必须经用户确认；
4. 实现 ConsentExportSkill 和 Shared Trip Agent；让 planning 覆盖全部 candidates；
5. 在持久化所有 provider/evidence/readiness 后接入 PlanComparisonSkill；模型不可用时失败关闭；
6. 在 feature flag 后接入 OpenAI Agents SDK；完成 schema/timeout/failure spike 后再启用；
7. 最后按需增加单次 PlanReviewSkill，并接入 outbox worker、OpenTelemetry 与集成测试数据库。

实施完成前，必须扩展 Vitest/API tests 覆盖上述 evaluation 场景，并将 npm run typecheck、npm run build、npm run lint 与依赖数据库的 npm test 设为实际 release gates。
