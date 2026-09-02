# 成员对话候选到 Shared Agent 交接实施规范

**状态：** 已实施；`0057_fix_conversation_handoff_batch_invariants.sql` 与 `0058_allow_terminal_handoff_provenance_redaction.sql` 修复批次版本、成员读取与私聊删除不变量。
**事实来源：** `TECH_STACK.md`、`docs/PRD.md`、`docs/backlog.md`、`docs/test-scenarios.md`。本文件定义成员私有对话到 Shared Agent 的交接实现，并取代旧 Team Agent 文档中“owner-only / 人工结构化录入”的交互约定；不改变既有 DRAFT Personal Research 的私有 provider 查询边界。

## 1. 固定决策与不变量

1. 任一当前 active Trip member 都可在**自己拥有的私有 thread**中与 Personal Agent 对话、生成候选并确认交接；该用户不必是 Trip creator。
2. 调用者只能确认其自身 thread、其自身候选和其自身 Trip 事实。成员、浏览器或模型不得代替其他成员确认，也不得确认整段对话。
3. 删除人工 `OWNER_FORM` 结构化录入和“手动发起 Shared 重规划”的 UI；不删除服务端结构化事实、显式交接确认、consent、immutable snapshot、`STALE` 或自动 `REPLAN`。
4. 对话原文、模型 prompt/response 与 Personal Research evidence 永不进入 Shared Agent。只有字段目录校验通过、由成员明确确认的结构化事实可进入 snapshot。
5. `nationality`、旅行证件、出生日期、健康与无障碍字段仍为 form-only；Personal Agent 不得从对话生成候选。现有专用 consent 路径保持不变。
6. 首次交接接受 `PLAN`；已有 ACTIVE/PROPOSED plan 的事实变更使其原子进入 `STALE`，并在服务端接受 `REPLAN`。前端统一显示“生成最新共享方案”，不显示或要求用户操作 replan。
7. Shared Worker 仍只可在 immutable snapshot 下调用 typed provider adapters；所有价格、库存、路线和 readiness 继续要求来源与采集时间，失败返回 `UNAVAILABLE`。
8. `PROPOSED → ACTIVE` 的全体 required-member adoption，以及 `ACTIVE` 后的 booking confirmation 均保留，且与成员对话交接确认严格分离。

## 2. 技术架构

继续使用现有单体部署边界：Next.js/React/TypeScript + TanStack Query，Fastify API，PostgreSQL/RDS + Drizzle，PostgreSQL lease/outbox durable Worker，受限 Skill Registry、ModelGateway、OpenTelemetry/Pino 和鉴权 SSE。不得引入自由 Agent-to-Agent 协议、Redis、Kafka、Temporal、Step Functions、WebSocket、向量数据库或 RAG。

```text
member-owned private thread
  -> Personal Agent extracts catalog-bounded candidate batch
  -> trip_constraint_proposals (member-private, no raw transcript)
  -> member selects / confirms batch in private chat UI
  -> one DB transaction
       validate membership + thread ownership + catalog + consent
       write immutable trip_constraint_facts revisions
       stale prior plans/confirmations when applicable
       create immutable constraint_snapshot
       accept PLAN or REPLAN durable task
  -> Shared Worker: snapshot + fresh provider evidence + validator
  -> PROPOSED plan -> required-member adoption -> ACTIVE
  -> existing booking confirmation -> sandbox only
```

## 3. 模块改动

| 处置 | 模块 | 实施要求 |
| --- | --- | --- |
| 复用 | `chat_threads`、`chat_messages`、conversation context service | 保持 owner-only 与有界服务端上下文；不新增 session 表、不接受浏览器 history。 |
| 复用 | `trip_constraint_proposals`、`trip_constraint_facts`、field catalog、snapshot builder | 继续作为候选、权威事实与 Shared 最小投影边界。 |
| 复用 | `ConstraintProposalService` 的 stale 事务、`acceptPlanningTask`、Worker lease/outbox、plan validator | 批量交接调用同一失效、快照与 durable task 路径。 |
| 复用 | adoption、booking、provider adapters、audit、metrics、tracing | adoption/booking 语义和 provider fail-closed 行为不变。 |
| 修改 | `trip.constraint.propose` skill 与 conversation task handler | 将当前空实现替换为 structured output 抽取；仅输出 allow-list 字段和候选 batch，先经 Zod/catalog 再持久化。 |
| 修改 | `constraint-proposal-service.ts`、`team-orchestration.ts` | 增加 member batch confirm；将“owner”授权检查改为 active member + candidate owner + thread owner 的三重等值检查。 |
| 修改 | `travel-agent-chat.tsx`、query hooks/API contracts | 以私聊候选卡替代人工 form；成功后刷新 trip/plan/run query，SSE 仅显示安全状态。 |
| 新增 | batch 迁移、handoff service/route、候选卡与 E2E | 见第 4–8 节。 |
| 下线 | `OWNER_FORM` 创建入口与手动 replan UI | 仅移除客户端入口；历史 `OWNER_FORM` facts 和审计记录保持可读、可失效。 |

## 4. 数据模型与状态

### 4.1 Migration

在 `trip_constraint_proposals` 增加以下字段，保留现有行兼容：

| 字段 | 类型/约束 | 用途 |
| --- | --- | --- |
| `batch_id` | UUID, nullable for legacy, indexed | 同一对话轮产生的一组候选。 |
| `origin_thread_id` | UUID FK `chat_threads`, nullable for legacy | 证明候选来自成员自己的 thread。 |
| `origin_run_id` | UUID FK `agent_task_runs`, nullable for legacy | 关联可审计的抽取 run；不存 prompt/message。 |
| `candidate_version` | integer, default 1, positive | 防止陈旧 UI 覆盖最新候选。 |

新候选必须满足：`owner_user_id = agent_task_runs.created_by_user_id`、`origin_thread_id` 属于该用户且绑定同一 `trip_id`。DB check 无法覆盖跨表关系时，交接事务必须 `FOR UPDATE` 重新验证。

候选状态沿用 `PENDING → CONFIRMED | DISMISSED`。交接成功时，所有已选 `PENDING` 候选转为 `CONFIRMED`，每项创建或替换一个 immutable `trip_constraint_facts` revision；未选项保持 `PENDING` 或由成员显式 dismiss。`trip_constraint_facts`、`constraint_snapshots` 与计划表不改变 schema 语义。

### 4.2 禁止持久化

不得新增原始 transcript、LLM rationale、自由文本共享说明、passport/document 值或模型推断的敏感属性。`safeRationale` 仅可在成员私有 DTO 中出现，且不得引用或复述聊天文本。

## 5. API 与事务设计

### 5.1 候选生成（内部调用）

`conversation-task-handler.ts` 在完成普通对话回复后，仅对 active Trip member 的同 owner thread 调用 `trip.constraint.propose`。输入只包含服务端构建的 bounded context、当前 Trip brief 与允许的非敏感 Profile hints。模型输出必须满足 strict Zod，再以 `parseConstraintField` 校验。

有效候选以 `source_kind='PERSONAL_AGENT'`、同一 `batch_id` 写入 `trip_constraint_proposals`；仅在 `PLANNING` 或 `STALE` Trip 的普通模型对话完成后抽取。`DRAFT` 只允许私有探索，终态 Trip 不抽取交接候选。一个新 batch 的所有候选使用同一个 batch-level `candidate_version = 1`；`batch_id` 为新 UUID，不能覆盖其他 batch。低置信度、缺失值、字段不在目录中或校验失败时不写候选，只在私聊中追问。生成候选不得调用 provider、snapshot、Shared Skill 或 plan service。

### 5.2 成员批量确认

新增：`POST /trips/:tripId/constraint-handoffs/:batchId/confirm`。

请求必须严格校验：

```ts
{
  requestId: UUID,
  candidateVersion: number,
  selections: Array<{
    proposalId: UUID,
    visibility: 'TEAM_VISIBLE' | 'ORCHESTRATOR_CONFIDENTIAL',
    strength: 'HARD' | 'SOFT'
  }>
}
```

该接口不接受 value、userId、threadId、snapshotId、planId、provider 参数或任意 JSON。成员可在 UI 中取消单项选择，但最终值仅来自已持久化且 catalog-validated proposal。`ORCHESTRATOR_CONFIDENTIAL` 仍须展示残余推断风险确认；批量确认不构成国籍/证件或 provider-only nationality 授权。

事务顺序：

1. `FOR UPDATE` 锁定 Trip、batch proposals 与相关 active facts；验证 Trip 可规划、actor 是 active member、actor 等于 proposal owner、origin thread owner 且所有对象同 Trip。
2. 验证 candidate version、每项 `PENDING` 状态、field catalog、visibility/strength 兼容性，以及 profile-derived 项目的 field-level consent。
3. 写入 facts 新 revision 并将被替代 facts 标为 `SUPERSEDED`；候选转为 `CONFIRMED`。
4. 如果已有 ACTIVE/PROPOSED plan，调用既有 `stalePlansAndConfirmationsForTrip`。首次 plan 不作无意义 stale。
5. 基于当前 required members 和事实创建 immutable snapshot；以稳定 idempotency key 接受 `PLAN`（无当前 plan）或 `REPLAN`（存在当前 plan）任务。
6. 写 value-free audit event、outbox/telemetry，并返回 `{ runId, snapshotId, operation, status: 'QUEUED' }`。

同一 `requestId` 必须返回首次结果，不能创建第二个 fact revision、snapshot 或 task。成员移除、consent 撤回、候选被替代、并发 handoff 或 task 最终写入时，现有版本/lease/manifest guard 必须 fail closed 为 `STALE` 或 conflict。

### 5.3 读取接口

新增 member-private read：`GET /trips/:tripId/constraint-handoffs/:batchId`，仅仍是当前 Trip member、且为 batch candidate `owner_user_id` 的成员本人可读取。成员移除后读取与确认均 fail closed。成员共享 workspace 继续只使用既有 `GET /trips/:tripId/constraints` 的 `TEAM_VISIBLE` DTO；不得新增 confidential candidate 或 snapshot read API。

## 6. Shared 编排与状态管理

`PLAN` / `REPLAN` 的语义不对 UI 公开：两者均显示为“生成最新共享方案”。Worker 必须：

- 使用刚接受 task 绑定的 snapshot 和 preference versions；
- 为 snapshot 内全部 destination candidates 构建 provider research matrix；
- 使用 run-scoped evidence 和 deterministic `plan-output-validator`；
- 产出 `PROPOSED`，不直接激活；
- 由现有 adoption vote 转为 `ACTIVE`，再由现有 booking confirmation 进入 sandbox。

候选确认不授权 Shared Agent 使用 Personal Research evidence，也不跳过 provider freshness。后续成员 handoff、事实更新、授权/成员/报价变化仍应自动 stale 并接受新的 `REPLAN`；前端不提供“沿用旧方案”或“手工 replan”操作。

## 7. 前端行为

在 `TravelAgentChat` 内展示 member-private candidate card：字段名、规范化候选值、强度、visibility 选择、缺口、残余推断提示与“确认并生成共享方案”按钮。不得展示原始模型理由、其他成员候选、snapshot 或 provider authority。

确认成功后：关闭/标记已确认候选卡，订阅或轮询 run 的安全阶段，invalidate trip/constraints/plans/agent-run query keys。卡片可逐项取消选择；“稍后处理”只隐藏当前浏览器卡片，不改变服务端 `PENDING` 状态。删除私有 thread 时服务端必须先将该 thread 的 `PENDING` handoff candidates 标为 `DISMISSED`，再删除正文；终态 proposal 的 origin FK 可被清空，不能阻断私聊删除。浏览器不在 Zustand、localStorage 或 sessionStorage 保存候选值、授权、snapshot 或任务真相。

Shared workspace 保留 proposal plan、adoption vote、ACTIVE/STALE 比较与 booking confirmation；移除人工 `OWNER_FORM` 和显式 replan CTA。

## 8. 实施阶段与依赖

| 阶段 | 内容 | 前置 | 完成标准 |
| --- | --- | --- | --- |
| 0 | 同步事实来源、OpenAPI DTO、测试矩阵 | 本文批准 | PRD/stack/backlog/tests 一致；无运行时变化。 |
| 1 | 修正当前 planning handler 全候选覆盖；补回归 | 0 | 不再以 `candidates[0]` 作为唯一生成目标；所有候选在 result 中可比较。 |
| 2 | batch migration、Drizzle schema、repository/service pure tests | 0 | legacy rows 兼容；跨 user/thread/trip 数据库服务层拒绝。 |
| 3 | Personal candidate extraction、持久化和 owner-safe read | 2 | 仅目录允许的非敏感候选可被写入；抽取失败不产生共享状态。 |
| 4 | batch confirm transaction、snapshot/PLAN/REPLAN integration | 2–3 | 幂等、并发、撤回和 stale guard 通过；一次确认最多一个 task。 |
| 5 | 私聊候选卡、移除 form/replan UI、query/SSE recovery | 4 | 任意 active member 可从自己的私聊完成交接；不会泄露其他成员数据。 |
| 6 | E2E、observability、迁移升级验证与 rollout | 1–5 | 第 9 节全部通过；审计/trace/log 无敏感值。 |

## 9. 强制验证

1. 任意非 creator active member 可在自己的 thread 确认候选并创建 Shared task；creator 不是必需角色。
2. 成员 A 无法读取、确认、dismiss 或替换成员 B 的 batch/proposal/fact；thread/trip mismatch 返回 403/409。
3. 未确认、dismissed、陈旧或 catalog-invalid candidate 永不进入 fact、snapshot、Shared prompt 或 plan。
4. 对话无法生成或确认 nationality、证件、健康、无障碍字段；既有表单/consent 测试继续通过。
5. 批量确认的重复请求、并发请求和 Worker lease recovery 最多产生一个可用 task/result；后到 callback 不能覆盖新版本。
6. 已有 ACTIVE/PROPOSED plan 时 handoff 原子 stale 旧 plan、confirmations 和投票，并只接受一个最新 replan；无 plan 时接受 PLAN。
7. Shared Worker 覆盖所有 destination candidates，provider 缺口为 `UNAVAILABLE`，Personal evidence 不可作为 Shared evidence。
8. 机密约束不出现在其他成员 API/UI、plan JSON、说明、SSE、audit、log、trace 或 metric labels；允许的 residual inference warning 必须展示。
9. `PROPOSED` 不能 booking；所有 required adoption 后才 ACTIVE；现有全员 booking confirmation 仍是 sandbox 前置条件。

## 10. 观测、风险与发布注意事项

新增 value-free audit actions：`MEMBER_CONVERSATION_CANDIDATES_CREATED`、`MEMBER_CONVERSATION_HANDOFF_CONFIRMED`、`MEMBER_CONVERSATION_HANDOFF_REJECTED`。新增低基数 metrics：`conversation_handoff_candidate_batch_total{result}`、`conversation_handoff_confirm_total{operation,result}`；不得以 trip/run/user/thread ID 或字段值作为标签。新增 spans：`conversation.candidate.extract`、`trip.constraint.handoff.confirm`。

主要风险与控制：模型抽取错误由候选卡与 catalog validation 拦截；确认范围过宽由逐项 visibility/敏感字段 form-only 限制；并发交接由 transaction、idempotency、snapshot manifest 与 lease guard 拦截；计划过期由自动 stale/replan 保证。不得为“减少步骤”放宽这些控制，也不得删除历史事实、审计或 snapshot；回滚时仅关闭候选卡/confirm route feature gate，既有 facts 和计划状态机照常运行。
