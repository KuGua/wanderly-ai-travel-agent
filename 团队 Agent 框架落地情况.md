# 团队 Agent 框架落地情况

调研对象:`apps/api/src/` 下 Agent、Skill、provider、policy、worker、tasks 全部代码与相关 `.md` 文档,以及 `docs/agent-architecture.md` 推荐实现。

## 1. 已落地的核心模块

### Agent 层(已注册)

| Agent | 文件 | 注册 Skills |
|---|---|---|
| Personal Travel Agent | `apps/api/src/agents/personal-travel-agent.ts` | 5 个:`profile.memory` / `profile.change_proposal` / `consent.explanation` / `thread.recall` / `travel.conversation` |
| Shared Trip Agent | `apps/api/src/agents/shared-trip-agent.ts` | 2 个:`plan.comparison` / `readiness.check` |

每个 Skill 都是 `Skill<I,O>` 形态(`apps/api/src/agents/contracts.ts`),通过 `registerSkill` 注册,带 `agent / allowedTools / timeoutMs / needsConfirm / version`,并有 `.md` 文档与之绑定(`name / source-of-truth / status: implemented` 是 `verify-docs.ts` 的检查点)。

### Skill 契约与注册表

- `apps/api/src/agents/skill-registry.ts`:唯一调用入口,负责注册期 scope 校验、`expectedVersion`、`AbortSignal` + `Promise.race` 超时、输入/输出 Zod parse、`SKILL_INVOKE` 审计输出 sha256。
- `apps/api/src/agents/policy-gate.ts`:`DefaultPolicyGate` 按 `personal | shared | review | public-content` 锁定 scope 白名单;personal 注册期额外禁止 `bookings` / `plan:write:propose`。
- `apps/api/src/agents/errors.ts` + `ERROR-CODES.md`:13 个 `SkillErrorCode`,已映射 HTTP,`error-handler.ts` 统一回传 `{statusCode, error, code, violations, correlationId}`。

### 控制平面(均已就位)

- 数据库:`apps/api/src/db/schema.ts` 含 `constraint_snapshots / itinerary_plans / member_confirmations / booking_executions / idempotency_records / audit_events / outbox_events` 等;`constraint_snapshots` 有 `(tripId, version)` 唯一索引。
- 政策闸口:`apps/api/src/policy/snapshot-policy.ts` 校验 `authorizedData.<memberId>.<fieldName>`;`apps/api/src/policy/plan-output-validator.ts` 实现 11 个 `PlanViolationCode`,对 LLM 输出做 Zod + `isDeepStrictEqual` 证据匹配 + source/capturedAt 溯源,失败 fail-closed。
- Booking 沙箱:`apps/api/src/services/booking-service.ts` + `apps/api/src/middleware/sandbox-signature.ts`,回调走 HMAC + timestamp 窗口 + timing-safe 比较。
- Durable Worker:`apps/api/src/workers/agent-task-worker.ts` + `apps/api/src/tasks/task-repository.ts` + `apps/api/src/tasks/handlers/conversation-task-handler.ts`。Worker 与 HTTP 请求解耦,通过 `agent_task_runs.trace_context` JSONB 把 `traceparent` 持久化,Worker 端 `parseTraceparent` 重建 span 并以 `link` 接回原 HTTP span;SSE relay 继续传递 `traceparent`。
- LLM 边界:`apps/api/src/providers/llm-gateway.ts` 是唯一真实 LLM 路径,`apps/api/src/providers/gateway-factory.ts` 不接受缺凭据或本地 mock;production 不做 mock fallback;provider 错误分类为 `NETWORK / UPSTREAM_5XX / SCHEMA_PARSE / UPSTREAM_FAILURE / TIMEOUT`,经 `SkillError` 暴露给路由和 Worker。
- 可观测性:Fastify 接入 Pino、`/metrics` 进程内文本输出、`x-correlation-id`、`traceparent` 进出 header、LLM span 属性受 `FORBIDDEN_SPAN_ATTRIBUTE_KEYS` 约束;audit summary 走严格白名单。

### Personal Agent 现有 Skill 含义

| Skill | 是否走 LLM | 是否需要用户确认 |
|---|---|---|
| `profile.memory` | 否(只读) | 否 |
| `profile.change_proposal` | 否(透传) | 是(`needsConfirm:true`,handler 不写库) |
| `consent.explanation` | 否 | 否 |
| `thread.recall` | 否(返回脱敏) | 否 |
| `travel.conversation` | 是(LLM) | 否;`SAFE_REFUSAL` 由 deterministic conversation-safety 边界产出 |

### Shared Trip Agent 现有 Skill

| Skill | 是否走 LLM | 关键校验 |
|---|---|---|
| `plan.comparison` | 是(LLM) | snapshot 必填 + `validatePlanOutput` 校验引用、来源、证据一致 |
| `readiness.check` | 否(占位返回 PENDING) | — |

`readiness.check` 当前只是返回"待用户核对官方渠道"的占位。

### Public-content(位置介绍缓存)

公共介绍功能没有走 Skill 注册,而是 `apps/api/src/location-introduction/location-introduction-cache-service.ts` 直接调 `ModelGateway.generateLocationIntroduction` 实现 7 步:缓存查找 → 租约声明 → 模型调用(在事务外)→ READY 提交 → 非 owner 202 → 失败释放;并带 `FORBIDDEN_OUTPUT_PATTERNS` 防御性过滤实时/价格/温度等表达。`public-content` 这个 agent kind 在 `policy-gate.ts` 中保留为空 scope,文档没有为它建立 Skill(当前是直接调 gateway)。

## 2. 与推荐实现的差距

### 文档列出但未落地的 Skill

- `ConsentExportSkill`(`shared/consent-export-skill.ts`):目前通过 `services/consent-service.ts:buildAuthorizedData` 直接被 `planning-service` / worker 调用,没有封装为 Skill。Agent 拓扑图把它画在服务端协作边界,但没作为可注册 Skill 暴露,意味着它不享受 timeout/audit/version 校验。
- `TripOverrideProposalSkill`(`personal/trip-override-proposal-skill.ts`):目录里完全没有。`profile-change-proposal` 已能标记 `source: "this_trip"`,但单独的 trip override storage 仍未落地。
- `PlanReviewSkill`(`shared/plan-review-skill.ts`):空缺。`AgentKind` 含 `"review"`,`policy-gate` 也定义了 `review` 白名单,但 `apps/api/src/skills/REVIEW.md` 显式声明 `status: no-skills`,没有任何 `agent: "review"` 的 Skill,`verify-docs.ts` 把"无 review Skill"作为不变量。
- `PlanDiffExplanationSkill`:未实现。
- `FlightSearchSkill` / `CandidateResearchSkill`:共享层没有对应的 Skill 文件;航班/酒店/地面 provider 在 `services/planning-service.ts` 中直接调用,未受 Skill registry 约束(因此也不在 registry 的 timeout/audit 范围)。
- 公共内容 Skill:`location-introduction` 路径绕开 registry 直接调 gateway,`public-content` agent 目前没有注册任何 Skill,scope 为空。

### 行为不完整的 Skill

- `readiness.check`:handler 直接返回每个成员的 `PENDING` 状态 + "向官方核验"文案。架构目标是接入 `VisaProvider.checkVisaReadiness`,目前还是占位实现,无法给出真实 readiness。
- `travel.conversation` 的运行时上下文由 `apps/api/src/services/conversation-context-service.ts` 在 worker 端组装(每线程 owner-only、有界窗口),Skill 内部不再依赖 `thread.recall`,这点和文档一致。但 `thread.recall` 目前只返回 `redactedSummary`,如果某些消息没标 `markedSharedByOwner` 会拿到空字符串——是按设计行为,不是 bug。

### 控制平面的剩余工作

- Plan synthesis 仍以 `plan.comparison` 的 LLM 输出为基础,经过 `validatePlanOutput` 强校验,但没有 Plan Review 这一受控反思步骤,review skill 的空白与架构文档一致,非缺陷。
- `outbox-events` 已建表;`apps/api/src/workers/` 下还没有 outbox worker(只有 `agent-task-worker.ts`)。
- 文档说"目标 OpenAI-compatible LLM 的 function-tool loop"在 feature flag 后接入,目前没有 function-tool 循环注册。`@openai/agents` 已列在 `apps/api/package.json` 的 `dependencies`,但代码里看不到使用。
- OTel trace exporter 已加 `@opentelemetry/exporter-trace-otlp-http` 与 `-proto` 依赖,`apps/api/src/observability/` 的初始化在文档里明确"未初始化 trace exporter / 生产 metrics exporter",所以目前仍是 SDK 接入 + 进程内 metrics。

## 3. 一句话总结

`Personal` 5 个 Skill + `Shared` 2 个 Skill 已经按架构契约落地,`policy-gate + skill-registry + plan-output-validator + durable worker + LLM gateway + 审计/可观测性` 这一闭环是完整的。但 `ConsentExport / FlightSearch / CandidateResearch / Readiness / TripOverride / PlanReview / PlanDiff` 这几个推荐 Skill 没实现为可注册 Skill,`readiness.check` 行为是占位,`location-introduction` 公共内容走的是 service-level 直调而非 Skill 注册,`public-content / review` 两个 agent kind 目前没有对应 Skill。