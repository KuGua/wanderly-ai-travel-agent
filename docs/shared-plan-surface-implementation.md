# 共享方案面（Shared Plan Surface）实施规范

**状态：** Approved for implementation
**范围：** Trip workspace 内承载 Shared Trip Agent 输出的、trip 内全体 active member 可见的只读界面；PLAN/REPLAN run 的生命周期展示、方案版本链展示与 adoption vote 入口。
**事实来源：** `TECH_STACK.md`、`docs/PRD.md`、`docs/backlog.md`、`docs/test-scenarios.md`、`docs/agent-architecture.md`、[Team Agent 协作编排实施规范](team-agent-orchestration-implementation.md)、[成员对话候选到 Shared Agent 交接实施规范](member-conversation-handoff-implementation.md)、[Trip 绑定私有对话线程实施方案](trip-scoped-private-threads-implementation.md)。

本文件实现 `team-agent-orchestration-implementation.md` §7 中第 2–5 项（成员约束面板、方案比较视图、adoption vote 控件、查询失效规则）。§7 第 1 项（私聊候选卡）已由 `member-conversation-handoff-implementation.md` 实现，不在本文范围内。

---

## 1. 固定决策与不变量

1. **共享方案面是只读广播面，不是会话。** 它没有输入框，不接受任何成员写入的消息，不创建 `chat_threads` 行，不写 `chat_messages`。产品形态上它作为一个置顶条目出现在 thread rail 顶部，实体是一个 trip-scoped 只读视图。这不构成 `docs/PRD.md` §非目标中的"产品内原生群聊"，也不违反 `docs/agent-architecture.md` 中"Shared Agent 不向用户开放聊天入口"的边界。

2. **不新增数据库表、列、枚举、迁移或服务端路由。** 全部内容由现有 member-scoped REST 读组合而成。唯一的服务端改动是 §3.2 中对既有 `pinnedSession` 投影的收紧。

3. **可见范围 = 当前 Trip 的 active member。** 授权判定完全由服务端既有检查承担（`requireRunAccess`、`listTripPlans` 的 membership 前置、`getLatestAuthorizedPlanningRun`、`assertMember`）。前端不做、也不得复制任何授权判断；成员被移除后所有读取 fail closed 为 `403`。

4. **渲染数据源白名单。** 共享方案面只可渲染下列四个来源的字段：
   - `GET /trips/:tripId/plans` 的响应（已经过 `redactPlanForViewer`）；
   - `GET /trips/:tripId/constraints` 的 `teamVisibleFacts`；
   - `GET /planning/:tripId/run/latest` 的 `run.{runId,operation,status,createdAt,updatedAt,finishedAt,errorCode,resultPlanId}`；
   - `GET /plans/:planId/adoption-votes` 的计数 DTO。

   **禁止**渲染：`GET /trips/:tripId/constraints/owner` 的 `allFacts`、`trip.pendingBriefProposal`、`agent_task_runs.researchIntentDraft` 及其任何投影、`tripBriefProposal`、Personal Research 结果、任何 `chat_messages` 正文、任何模型自由文本理由。

5. **不展示触发者身份。** 共享面文案只陈述状态（"正在生成最新共享方案" / "方案已更新"），不出现"由某成员触发"。约束面板仍按 `team-agent-orchestration-implementation.md` §1.3 只显示 `TEAM_VISIBLE` fact 的字段名与来源类别，不显示成员归属。

6. **SSE 是加速通道，REST 是真相。** 与 `member-conversation-handoff-implementation.md` §7 一致：SSE 只驱动阶段文案与查询失效，所有可见结果一律由 REST 重建。SSE 不可用时功能必须靠轮询完整降级。

7. **自动切换视图只对触发本次 run 的成员生效，且只在 run 到达终态（`turn.completed` / `SUCCEEDED` / `FAILED` / `CANCELLED`）时生效。** 其他成员只得到未读标记，视图不被抢占。理由：`TravelAgentChat` 的输入草稿是组件内 state，抢占会丢失用户正在输入的内容。

8. **未读状态是纯客户端 UI 偏好。** 存 `localStorage`，键为 `wanderly.sharedPlan.lastSeen.<tripId>`，值为已读的最高 plan `version`（整数）。它不是业务真相，丢失只影响红点，不影响任何服务端状态。浏览器不得保存 plan 内容、约束值、snapshot、run authority 或投票结果。

9. **URL 是选中态的唯一真相。** `/trips/:tripId?view=shared` 与既有 `/trips/:tripId?thread=<uuid>` 互斥。**不得**使用 `thread=shared` 之类的哨兵值——现有代码把 `thread` 查询参数当作 thread UUID 匹配。

10. **Phase 0 是硬前置。** 交付本功能其余阶段之前，必须先完成 §3.2 对 `pinnedSession` 的收紧。

---

## 2. 技术栈与系统架构

### 2.1 技术栈

沿用现有边界，不引入任何新依赖、新运行时组件或新环境变量：

- Web：Next.js 16 / React 19 / TypeScript、TanStack Query（服务端状态唯一来源）、Tailwind + 仓库既有 `wanderly-*` 设计 token、`next-intl`。
- API：Fastify 5、`/api/v1` 前缀、Cognito / local-dev 身份中间件。
- 数据：PostgreSQL + Drizzle（**本方案只读**）。
- 异步：既有 `agent_task_runs` lease Worker、PostgreSQL `LISTEN/NOTIFY` → `AgentStreamRelay` → 鉴权 SSE。

明确不引入：WebSocket、Redis、Kafka、Temporal、Step Functions、trip 级 SSE 通道、全局客户端业务状态（Zustand/Redux）、新的 provider。

### 2.2 架构位置

```text
apps/web  /trips/[tripId]
  ├─ ?thread=<uuid>   → TravelAgentChat        （既有，成员私有，owner-only）
  └─ ?view=shared     → SharedPlanView         （新增，trip 全员可见，只读）
                            │
                            ├─ GET /planning/:tripId/run/latest      run 生命周期
                            ├─ GET /agent-runs/:runId/events (SSE)   安全阶段事件
                            ├─ GET /trips/:tripId/plans              proposed/active/stale
                            ├─ GET /trips/:tripId/constraints        teamVisibleFacts
                            ├─ GET /plans/:planId/adoption-votes     票数
                            └─ POST /plans/:planId/adoption-votes    投票
apps/api
  （无新路由；授权由 requireRunAccess / assertMember / listTripPlans 既有检查承担）
```

### 2.3 为何不需要新的权限模型

`apps/api/src/tasks/task-repository.ts#requireRunAccess` 已经区分两类 run：

| operation | 授权范围 |
|---|---|
| `CONVERSATION` | `run.createdByUserId === userId`（owner-only） |
| `PERSONAL_RESEARCH` | `run.createdByUserId === userId`（owner-only） |
| `PLAN` / `REPLAN` / `RESEARCH` | `trip_members` 存在该 `(tripId, userId)` |

因此 `GET /agent-runs/:runId` 与 `GET /agent-runs/:runId/events` 对 PLAN/REPLAN run 已经是 trip-member 可见；`getLatestAuthorizedPlanningRun`、`listTripPlans`、`team-orchestration.ts#assertMember` 同理。本方案不扩大任何授权范围。

---

## 3. 模块处置

### 3.1 复用（不改动）

| 模块 | 路径 | 复用点 |
|---|---|---|
| Run 授权 | `apps/api/src/tasks/task-repository.ts#requireRunAccess` | PLAN/REPLAN 的 member-scoped 读与 SSE 授权 |
| 最新规划 run | `apps/api/src/tasks/task-repository.ts#getLatestAuthorizedPlanningRun`；路由 `GET /planning/:tripId/run/latest` | 已注册、已 member-scoped，前端接上即可 |
| 方案列表与脱敏 | `apps/api/src/services/plan-listing-service.ts`（`listTripPlans` / `redactPlanForViewer`） | proposed / active / stale 分组 + 机密字段剥离 |
| 团队可见约束 | `apps/api/src/routes/team-orchestration.ts` 的 `GET /trips/:tripId/constraints` | 只回 `TEAM_VISIBLE` facts |
| Adoption vote | `apps/api/src/services/plan-adoption-service.ts` + `GET/POST /plans/:planId/adoption-votes` | 投票读写与 quorum |
| SSE 中继 | `apps/api/src/tasks/agent-stream-relay.ts`、`apps/api/src/routes/agent-runs.ts` | 多成员并发订阅同一 runId |
| Web API client | `apps/web/src/lib/api/http-travel-api.ts` 的 `getLatestPlanningRun` / `subscribeAgentRun` / `listTripPlans` / `listAdoptionVotes` / `castAdoptionVote` | 方法与 Zod 契约均已存在 |
| Query keys | `apps/web/src/lib/query/keys.ts` 的 `tripKeys.planningRun`、`teamOrchestrationKeys.{plans,votes,constraintsMembers}` | 无需新增 key |

### 3.2 修改

| # | 模块 | 改动内容 |
|---|---|---|
| M1 | `apps/api/src/routes/trips.ts`（`GET /trips/:tripId` 的 `pinnedSession` 投影，约 673–715 行） | **Phase 0。** 当前只做 membership 检查，却把 `agent_task_runs.research_intent_draft` 的 `destinationCandidates` 投影给任意成员；该字段由 owner-only 的 `POST /trips/:tripId/personal-research/...` CAS 路径写入，源自成员私聊。与 `docs/draft-personal-research-implementation.md` §5"跨用户、同 Trip 的其他 member…一律 fail closed"冲突。改法：`pinnedSession` 仅在 `pinnedRun.createdByUserId === request.user.id` 时返回完整 DTO；否则返回 `null`。不改 DTO 形状（已是 `.nullable()`）。 |
| M2 | `apps/web/src/lib/api/travel-api.ts` | 将 `listTripPlans` / `listAdoptionVotes` / `castAdoptionVote` 由可选成员（`?`）改为必选。它们目前是可选的，调用点用 `!!api.listTripPlans` 兜底；共享方案面强依赖这三者，可选性会把缺失变成静默空态。改为必选后删除相关 `!` 非空断言。 |
| M3 | `apps/web/src/lib/query/hooks.ts#useLatestPlanningRun` | 当前活跃期 `1_500` ms、终态 `false`。终态改为 `60_000` ms，使非触发者能发现新 run。新增 `enabled` 参数，仅在 workspace 挂载时开启。 |
| M4 | `apps/web/src/lib/query/hooks.ts#useConfirmConstraintHandoffBatch` | `onSuccess` 追加 `qc.invalidateQueries({ queryKey: tripKeys.planningRun(tripId) })`；并把 mutation 返回的 `{ runId, operation }` 透传给调用方。 |
| M5 | `apps/web/src/components/explore/travel-agent-chat.tsx` | 新增可选 prop `onSharedRunStarted?: (input: { runId: string; operation: "PLAN" \| "REPLAN" }) => void`。`HandoffCardHost` 的 `onConfirmed` 由 `() => void` 改为接收 confirm 响应并上抛；当前实现丢弃了 `runId`（约 1091 行）。除此之外不改动聊天逻辑。 |
| M6 | `apps/web/src/components/trips/personal-research/conversation-handoff-card.tsx` | `onConfirmed` 签名改为 `(result: ConstraintHandoffConfirmResponse) => void`，在 `mutation.mutate(payload, { onSuccess })` 中把响应传出。 |
| M7 | `apps/web/src/components/trips/trip-workspace.tsx` | 见 §7.1：rail 顶部置顶条目、`?view=shared` 路由分支、中栏条件渲染、未读红点、把 `onSharedRunStarted` 接到 `TravelAgentChat`。 |
| M8 | `apps/web/src/lib/observability/ui-diagnostics.ts` **和** `apps/api/src/routes/ui-diagnostics.ts` | 新增 action：`shared_plan.view_open`、`shared_plan.vote_cast`。**两端必须同时改**：服务端 `actions` 常量目前比客户端 `UI_ACTIONS` 短，客户端已声明但服务端未收录的 action（如 `conversation.handoff_confirm`）会被 `422` 拒绝。本次一并补齐两者差集。 |
| M9 | `apps/web/messages/en.json`、`apps/web/messages/zh.json` | 新增 `trips.sharedPlan.*` 命名空间（§7.4）。既有 `teamOrchestration.*` 中被复用的键保持不动。 |

### 3.3 新增

| # | 文件 | 职责 |
|---|---|---|
| N1 | `apps/web/src/components/trips/shared-plan/shared-plan-view.tsx` | 共享方案面主容器。编排数据、决定 5 种顶层状态（§7.2），不含展示细节。 |
| N2 | `apps/web/src/components/trips/shared-plan/shared-plan-status-bar.tsx` | run 生命周期条：阶段文案、`UNAVAILABLE`/失败恢复提示、最后更新时间。 |
| N3 | `apps/web/src/components/trips/shared-plan/plan-proposal-card.tsx` | 单个方案卡：目的地、航班/住宿/活动摘要、来源与采集时间、`publicExplanationTokens` 渲染、adoption vote 控件。由 `TeamOrchestrationPanel.tsx` 的 `ProposalAdoptionCard` 提取后按 `wanderly-*` 设计 token 重写。 |
| N4 | `apps/web/src/components/trips/shared-plan/plan-version-trail.tsx` | 版本链：由 `version` + `replacedByPlanId` + `staleReason` 渲染 stale → proposed/active 的顺序，作为"时间线"的替代表达。 |
| N5 | `apps/web/src/components/trips/shared-plan/team-constraints-panel.tsx` | `TEAM_VISIBLE` 约束面板（`team-agent-orchestration-implementation.md` §7.2）。只显示 `fieldKey` + 来源类别 + revision。 |
| N6 | `apps/web/src/lib/query/hooks.ts#useSharedPlanFeed` | 组合 hook：latest run + plans + teamVisible constraints，统一暴露 `{ run, plans, constraints, phase, isBusy }`，并按 run 状态调整 plans 的 `refetchInterval`。 |
| N7 | `apps/web/src/lib/trips/shared-plan-read-state.ts` | localStorage 已读位点读写，全部包 `try/catch`，读失败按"未读为 0"降级。 |
| N8 | 测试 | `shared-plan-view.test.tsx`、`plan-proposal-card.test.tsx`、`shared-plan-read-state.test.ts`；`trip-workspace.test.tsx` 增补置顶条目与路由分支用例。 |

### 3.4 下线

| 模块 | 处置 |
|---|---|
| `apps/web/src/components/trips/team-orchestration/TeamOrchestrationPanel.tsx` | 孤儿组件（全仓库无 import）。Phase 3 把 `ProposalAdoptionCard` 的数据编排逻辑提取到 N3 后**删除整个目录**，同时删除其残留的 `void dismissMutation;` 之类的死引用。依据 `AGENTS.md`"删除已停用、已被替代且不再被任何运行路径引用的代码"。 |
| `apps/web/src/components/trips/personal-research/solo-plan-proposal-card.tsx` | 同为未挂载组件，但属于 Solo/Personal 路径，**不在本方案范围**。保留，并在本文 §12 记录为待确认的独立技术债。 |

---

## 4. 数据模型

**本方案不改动数据库 schema，不新增迁移。**

### 4.1 只读投影的数据来源

| 表 | 读取列 | 经由 |
|---|---|---|
| `itinerary_plans` | `id, version, status, snapshot_id, plan_data, replaced_by_plan_id, stale_reason, created_at` | `listTripPlans` → `redactPlanForViewer` |
| `agent_task_runs` | `id, operation, status, generation_attempt, created_at, updated_at, finished_at, error_code, result_plan_id` | `getLatestAuthorizedPlanningRun` / `getAuthorizedAgentRun` |
| `trip_constraint_facts` | `id, field_key, strength, visibility, revision`（仅 `visibility='TEAM_VISIBLE'`） | `listFactsForMembers` |
| `plan_adoption_votes` | 聚合计数 | `getVoteSummary` |
| `trip_members` | 授权判定 | 各服务的 membership 前置 |

### 4.2 `planData` 渲染契约

`plan_data` 的结构由 `apps/api/src/policy/plan-output-validator.ts#planOutputSchema` 定义并在持久化前强制校验。前端只允许消费以下字段：

```ts
{
  destination: string;
  destinationCandidatesEvaluated?: string[];
  flights: FlightOffer[];        // 含 origin/destination/segments/totalPrice/currency/source/capturedAt/expiresAt
  stays: StayOffer[];
  activities?: ActivityEvidence[];
  hotels?: HotelOffer[];
  generatedAt: string;
  constraintReferences?: string[];
  publicExplanationTokens?: string[];
}
```

规则：

- **每一项价格必须与币种成对渲染**，并附 `source` 与 `capturedAt`；`expiresAt` 已过期的 offer 必须标注过期，不得静默展示（`AGENTS.md` fixture-first 与事实边界）。
- `publicExplanationTokens` 是服务端 allow-list token（形如 `SATISFIES_ALL_PRIVATE_CONSTRAINTS`），**前端按 token 渲染本地化固定文案**，不得展示原始 token，也不得由前端拼接任何解释性自由文本。未知 token 静默跳过。
- `constraintReferences` 只用于"引用了 N 项已授权约束"的计数展示，不展开具体路径。
- `flights` / `stays` / `activities` / `hotels` 任一为空都表示该能力本次 `UNAVAILABLE`，必须显式渲染缺口，不得省略。**航班不再例外**：`.min(1)` 已于 2026-09-05 移除（见 [规划器韧性与有界反思实施规范](planner-resilience-and-reflection-implementation.md) §3.1.1），一次被拒的航班请求不应再把整份方案连同其余已验证的结果一起拿走。前端 `PlanProposalCard` 的 `FlightsSection` 本就有空数组分支，无需改动。方案整体必须至少引用一条证据——四类全空的卡片不是方案，服务端在持久化前拒绝。

### 4.3 唯一的客户端持久化

```
key:   wanderly.sharedPlan.lastSeen.<tripId>
value: "<整数 plan version>"
```

写入时机：共享方案面处于可见状态且 `plans` 查询成功时，写入当前最高 `version`。读取失败、值非法或 `localStorage` 不可用时一律按"未读位点 = 0"处理，不阻塞渲染。

---

## 5. 接口契约

本方案不新增接口。以下为消费的既有契约（web 侧类型见 `apps/web/src/lib/api/contracts.ts`）。

### 5.1 `GET /api/v1/planning/:tripId/run/latest`

授权：trip member，否则 `403`。

```ts
{ run: AgentRun | null }
// AgentRun.operation ∈ PLAN | REPLAN（该端点按 operation 过滤）
// 渲染仅使用：runId, operation, status, createdAt, updatedAt, finishedAt, errorCode, resultPlanId
```

### 5.2 `GET /api/v1/agent-runs/:runId/events`（SSE）

授权：PLAN/REPLAN run 对 trip member 开放。事件序列：

```
turn.started → run.phase{RESEARCHING} → run.phase{PERSISTING} → turn.completed{resultPlanId}
失败路径：turn.failed{code,retryable} | turn.cancelled | turn.stale{code}
恢复路径：run.phase{RETRYING}
```

前端处理规则：收到任一事件即刷新 `tripKeys.planningRun(tripId)`；收到 `turn.completed` 额外失效 `teamOrchestrationKeys.plans(tripId)` 与 `constraintsMembers(tripId)`。**不得**把事件负载直接渲染为结果。

### 5.3 `GET /api/v1/trips/:tripId/plans`

授权：路由层 `assertMember` → 非成员 `403`；`listTripPlans` 内部再做一次 membership 检查并回空分组，属防御性冗余。

```ts
{
  tripId: string;
  proposed: ListedPlan[];   // 一个 destination candidate 一条
  active: ListedPlan[];
  stale: ListedPlan[];
}
```

### 5.4 `GET /api/v1/trips/:tripId/constraints`

```ts
{ tripId: string; teamVisibleFacts: TripConstraintFact[] }
```

### 5.5 `GET | POST /api/v1/plans/:planId/adoption-votes`

```ts
// GET
{ planId, votesAccepted, votesRequired, hasBlocker, currentUserDecision: "ACCEPT" | "NEEDS_CHANGES" | null }
// POST  body: { decision: "ACCEPT" | "NEEDS_CHANGES" }，带 Idempotency-Key
{ planId, outcome: "CAST" | "ADOPTED" | "BLOCKED", votesAccepted, votesRequired }
```

### 5.6 `GET /api/v1/trips/:tripId`（M1 修改）

`pinnedSession` 由"任意成员可见"收紧为"仅 pinned run 的 `createdByUserId` 可见"，其余成员得到 `null`。响应 schema 不变。

---

## 6. 数据流与状态管理

### 6.1 端到端流程

```text
成员 A 在自己的私有 thread 确认候选 batch
  POST /trips/:tripId/constraint-handoffs/:batchId/confirm
  └─ 服务端单事务：facts revision → stale 旧 plan/confirmations/votes
                   → immutable snapshot → accept PLAN | REPLAN
  └─ 返回 { runId, snapshotId, operation, status: "QUEUED" }
        │
        ├─ A 的浏览器（M4/M5/M6）：拿到 runId
        │    → 切到 ?view=shared
        │    → subscribeAgentRun(runId) + invalidate planningRun
        │
        └─ B / C 的浏览器：useLatestPlanningRun 的 60s 基线轮询
             → 发现 run.runId 变化或 status 非终态
             → subscribeAgentRun(同一 runId)，轮询提速到 1.5s
             → 未读红点亮起（不抢占其当前视图）
        │
Worker：turn.started → RESEARCHING → 逐 candidate generatePlan → PERSISTING → turn.completed
        │
全体成员：invalidate teamOrchestrationKeys.plans(tripId)
        → GET /trips/:tripId/plans
        → 渲染 proposed[]（每个 destination 一条）
        → required member 投票 → 全票 ACCEPT → ACTIVE
```

### 6.2 轮询与订阅预算

| 查询 | 无活跃 run | run 处于 `QUEUED`/`RUNNING`/`CANCEL_REQUESTED` |
|---|---|---|
| `tripKeys.planningRun(tripId)` | 60 s（M3 新增） | 1.5 s（既有） |
| `teamOrchestrationKeys.plans(tripId)` | 不轮询，仅事件/失效驱动 | 5 s |
| `teamOrchestrationKeys.constraintsMembers` | 不轮询 | 事件驱动失效 |
| SSE `subscribeAgentRun` | 不订阅 | 订阅，`AbortSignal` 随视图卸载中止 |

所有轮询仅在 workspace 挂载期间生效；页面隐藏时依赖 TanStack Query 默认行为，不额外实现可见性检测。

### 6.3 状态归属

| 状态 | 归属 | 说明 |
|---|---|---|
| 当前选中视图（`shared` / thread id） | URL | 可分享、可刷新恢复 |
| run 状态、plan、约束、票数 | TanStack Query 服务端缓存 | 唯一真相来自 REST |
| SSE 阶段文案 | 组件局部 state | 仅装饰；刷新后由 REST 重建 |
| 未读位点 | `localStorage` | UI 偏好，非业务真相 |
| inspector 开合、卡片展开 | 组件局部 state | — |

**禁止**：把 plan 内容、约束值、snapshot、投票权威或 run authority 写入 `localStorage`、`sessionStorage` 或任何全局客户端 store。

---

## 7. 前端实现

### 7.1 Rail 置顶条目与路由（M7）

在 `trip-workspace.tsx` 左栏"新建对话"按钮之下、`threads.sectionLabel` 分组之上，插入一个独立的置顶区块：

```tsx
<button
  type="button"
  aria-current={view === "shared" ? "page" : undefined}
  onClick={() => selectSharedView()}
  data-testid="shared-plan-rail-item"
>
  {t("sharedPlan.railTitle")}          // "共享方案" / "Shared plan"
  {t("sharedPlan.railSubtitle")}       // "全体成员可见" / "Visible to all members"
  {unread ? <span data-testid="shared-plan-unread" /> : null}
</button>
```

- 该条目**始终显示**，即使 trip 尚无任何 plan（此时点进去是空态，见 §7.2.a）。它是功能的发现入口。
- `selectSharedView()`：`params.delete("thread"); params.set("view", "shared"); router.push(...)`。
- 选择任一私有 thread 时：`params.delete("view"); params.set("thread", id)`。
- 中栏渲染分支：`view === "shared" ? <SharedPlanView tripId={tripId} /> : <TravelAgentChat ... />`。
- 中栏 header 的标题在共享视图下显示 `t("sharedPlan.headerTitle")`，副标题显示成员数，不显示 thread 标题。
- 现有"URL 指向未知 thread 时回落到默认 thread"的 effect 必须在 `view === "shared"` 时跳过，否则会把共享视图弹回私聊。

### 7.2 `SharedPlanView` 的五种顶层状态

| 状态 | 触发条件 | 呈现 |
|---|---|---|
| a. 空态 | 无 run 且 `proposed/active/stale` 全为空 | 说明共享方案由私聊中确认约束触发；提供"回到我的对话"链接。**不提供**手动 replan 按钮（`member-conversation-handoff-implementation.md` §6 禁止）。 |
| b. 进行中 | `run.status ∈ QUEUED\|RUNNING\|CANCEL_REQUESTED` | 状态条 + 阶段文案；若已有 `active`/`stale` 方案则同时展示，标注"正在生成更新" |
| c. 有方案 | `proposed.length > 0` 或 `active.length > 0` | 版本链 + 方案卡列表 + 约束面板 |
| d. 失败 | `run.status ∈ FAILED\|CANCELLED` 或 `errorCode != null` | 按 `errorCode` 映射到本地化固定文案（见 §11.3）；**不渲染 errorCode 原文之外的任何服务端消息** |
| e. 无权限 | 任一查询返回 `403`/`410` | 复用既有统一错误处理，显示"无权限或成员资格已失效"，不泄露具体对象状态 |

### 7.3 方案卡渲染规则（N3）

按 `destination` 一卡。卡内分区：

1. **头部**：目的地、`status` 徽标（`PROPOSED` / `ACTIVE` / `STALE`）、`version`、`generatedAt`。
2. **航班**：按 `origin` 分组（多出发地），每条显示 `segments` 摘要、`totalDuration`、`totalPrice` + `currency`、`cabin`、`source` + `capturedAt`；`expiresAt` 已过期时加过期标记。
3. **住宿 / 酒店 / 活动**：存在则渲染，缺失渲染 `UNAVAILABLE` 缺口条目，说明"本次未获得可验证数据"。**不得**用其他候选或历史数据填补。
4. **说明**：`publicExplanationTokens` → 本地化固定文案；`constraintReferences.length` → "已引用 N 项团队约束"。
5. **投票区**（仅 `PROPOSED`）：`votesAccepted / votesRequired`、`hasBlocker`、当前用户 `currentUserDecision`；`ACCEPT` / `NEEDS_CHANGES` 两个按钮，带 `Idempotency-Key`。文案必须明确区分 **adoption vote** 与 **booking confirmation**，并说明旧方案不可恢复（`team-agent-orchestration-implementation.md` §7.4）。
6. `STALE` 卡：只读，无投票按钮，显示 `staleReason` 的本地化映射。

### 7.4 i18n

新增命名空间 `trips.sharedPlan.*`，en/zh 双份，键覆盖：

```
railTitle, railSubtitle, headerTitle, headerSubtitle,
empty.title, empty.body, empty.backToThread,
status.queued, status.researching, status.persisting, status.retrying,
status.completed, status.failed, status.cancelled, status.lastUpdated,
plan.statusBadge.{PROPOSED,ACTIVE,STALE}, plan.version, plan.generatedAt,
plan.flights, plan.stays, plan.hotels, plan.activities,
plan.unavailable, plan.offerExpired, plan.constraintCount,
explanation.<TOKEN>            // 每个 allow-list token 一条固定文案
staleReason.<reason>           // 每个已知 stale_reason 一条固定文案
vote.accept, vote.needsChanges, vote.tally, vote.blocked,
vote.notBooking, vote.noRestore, vote.casting, vote.error,
constraints.heading, constraints.empty, constraints.strength.{HARD,SOFT},
error.forbidden, error.generic
```

`explanation.*` 与 `staleReason.*` 采用"未知键静默跳过"策略，不回落为原始 token。

### 7.5 可访问性与响应式

- 置顶条目与 thread 条目同属 rail 的可聚焦控件，`aria-current="page"` 表达选中。
- 未读红点必须有 `aria-label`（"有未读的共享方案更新"），不能只靠颜色。
- 共享视图在 `md` 以下与私聊共用同一中栏区域；rail 在 `md` 以下已隐藏，需在中栏 header 提供切回入口。
- 方案卡内的宽内容（航段表）必须放在 `overflow-x: auto` 容器内，页面本身不得横向滚动。

---

## 8. 观测性

**不新增服务端 metrics、span 或 audit action** —— 本方案不新增服务端行为。

### 8.1 前端诊断（M8）

新增两个 action，**必须同时**加入 `apps/web/src/lib/observability/ui-diagnostics.ts#UI_ACTIONS` 与 `apps/api/src/routes/ui-diagnostics.ts#actions`：

| action | 触发点 | outcome |
|---|---|---|
| `shared_plan.view_open` | 用户选中置顶条目 | `success` |
| `shared_plan.vote_cast` | adoption vote 提交完成 | 按结果 |

同一改动中补齐两端既有差集（客户端已声明、服务端缺失的 `conversation.handoff_confirm`、`research.*`、`setup.*`），否则这些事件持续被 `422` 拒绝。

`screen` 使用既有枚举值 `"trip"`。事件仍不得携带 trip/plan/run/user ID 或任何字段值。

### 8.2 关联

共享视图的 API 请求沿用既有 `TravelApi` 的 correlation / client-request ID 注入；SSE 的 trace 关联由服务端 `sse.stream` / `sse.event.*` span 承担，前端不额外埋点。

---

## 9. 实施阶段与依赖

| 阶段 | 内容 | 依赖 | 出口标准 |
|---|---|---|---|
| **0** | M1：收紧 `GET /trips/:tripId` 的 `pinnedSession` 投影；补 API 集成回归 | 无 | 非 pinned-run owner 的成员拿到 `pinnedSession: null`；既有 owner 场景不回归 |
| **1** | M2、M3、M7（置顶条目 + `?view=shared` 路由 + 分支）、N1 只读骨架（接 `useTripPlans` + `useLatestPlanningRun`，无投票）、N7、M9 首批文案 | 0 | 任一成员可从 rail 进入共享视图，看到 proposed/active/stale 方案；空/加载/错误/无权限四态可达 |
| **2** | N2、N6、SSE 订阅与失效规则、M4/M5/M6（触发者自动切换） | 1 | A 确认候选后自动进入共享视图并看到阶段推进直至方案出现；B 刷新后同样看到 |
| **3** | N3、N4、N5（含投票）、删除 `TeamOrchestrationPanel` 目录 | 2 | 三成员投票 → `ACTIVE` 可跑通；`NEEDS_CHANGES` 阻止激活；仓库无孤儿组件 |
| **4** | 未读红点、非触发者的 60s 发现路径、M8 诊断 | 2 | B 在 A 触发后 ≤5 s 看到红点且视图不被抢占 |
| **5** | 完整 i18n（en/zh）、N8 测试、`docs/test-scenarios.md` 场景、发布回归 | 1–4 | §10 全部通过；`npm run typecheck && npm run lint && npm test`（web 与 api）与 `npm run docs:verify` 通过 |

**依赖说明**：阶段 0 与阶段 1 之间没有代码依赖，但阶段 0 是**发布前置**——共享面把"成员看到他人触发的内容"变成主路径，必须先关闭同类越权面。阶段 3 依赖阶段 2 的 `useSharedPlanFeed`。阶段 4 可与阶段 3 并行。

**最小可交付**：阶段 0 + 阶段 1 已独立解决"Shared Agent 输出无返回位置"这一核心问题，可单独发布。

---

## 10. 强制验证

### 10.1 API（阶段 0）

1. 成员 B 读取 `GET /trips/:tripId`，其中 pinned run 由成员 A 创建 → `pinnedSession === null`；A 自己读取 → 正常返回。
2. 无 pinned run 时两者均为 `null`，不报错。
3. 既有 trip detail 回归（成员列表、`callerRole`、brief 字段）不变。

### 10.2 Web

4. 非 trip 成员访问 `/trips/:tripId?view=shared` → 统一 `403` 文案，不渲染任何方案、约束或 run 字段。
5. 成员 B（非触发者）在 A 确认候选后，60 s 内 `useLatestPlanningRun` 拾取新 run；红点出现；**B 的中栏仍停留在其原本的私有 thread**，输入框内容不丢失。
6. 成员 A（触发者）在 run 到达终态时自动切到共享视图；run 仍在进行时不切换。
7. `?view=shared` 与 `?thread=<uuid>` 互斥：设置其一即清除另一；刷新后视图恢复正确。
8. `plans` 为空时渲染空态且不出现手动 replan 按钮。
9. 方案卡对缺失的 `stays`/`hotels`/`activities` 渲染 `UNAVAILABLE` 缺口，不省略、不替代。
10. 每个价格均与币种、`source`、`capturedAt` 同时出现；`expiresAt` 已过期的 offer 带过期标记。
11. 未知 `publicExplanationTokens` / `staleReason` 静默跳过，不渲染原始 token。
12. `localStorage` 不可用（抛异常）时视图正常渲染，未读位点按 0 处理。
13. `localStorage` 中不存在 plan 内容、约束值、snapshot、投票结果或 run authority。
14. adoption vote：重复提交同一 `Idempotency-Key` 不产生第二票；`NEEDS_CHANGES` 后卡片保留且不显示 booking 入口。
15. 共享视图渲染树中不出现 `constraintsOwner`、`pendingBriefProposal`、`researchIntentDraft`、`tripBriefProposal` 或任何 `chat_messages` 派生数据（以组件 props 类型 + 快照测试双重约束）。
16. 共享视图不显示任何成员姓名与"由谁触发"的表述。

### 10.3 回归

17. 既有私聊、handoff 候选卡、thread rail、trip detail、adoption 服务端测试全部保持绿色。
18. `npm run docs:verify` 通过。

---

## 11. 边界条件

### 11.1 前置条件缺失

`apps/api/src/services/constraint-proposal-service.ts` 在接受 REPLAN 前要求本 Trip 至少存在一条已确认的 `trip_search_preferences`（`PLAN_ENABLE_HOTEL=true` 时还要求 `trip_stay_search_preferences`）。缺失时 handoff confirm 直接抛 `FORBIDDEN`，**根本不会创建 run**。该偏好目前只在私聊的航班搜索确认流程中写入（`travel-agent-chat.tsx` 调用 `saveTripSearchPreferences`）。

处理：共享面在这种情况下停留在空态 a；错误由候选卡的既有错误路径呈现，不由共享面二次解释。**实施前必须在开发库上实测一次完整链路**，确认能产出 `PROPOSED` 行：

```sql
SELECT operation, status, error_code FROM agent_task_runs
 WHERE operation IN ('PLAN','REPLAN') ORDER BY created_at DESC LIMIT 10;
SELECT status, count(*) FROM itinerary_plans GROUP BY status;
```

若十次触发中产出 `PROPOSED` 少于一次，先修 planning 管线，再投入本方案的展示层。

### 11.2 Trip 状态

- `DRAFT`：不产生 handoff 候选，也不会有 PLAN/REPLAN run。置顶条目仍显示，点进去是空态 a，文案说明需先激活行程。
- `PLANNING` / `STALE`：正常路径。
- `CONFIRMED` / `BOOKED` / `CANCELLED`：只读展示既有 `ACTIVE`/`STALE` 方案，隐藏投票控件。

### 11.3 Run 异常终态

| `errorCode` | 呈现 |
|---|---|
| `PLANNING_DATA_UNAVAILABLE` | "本次未获得足够的可验证数据"，列出缺口能力 |
| `STALE_SNAPSHOT_GUARD` | "有更新的约束变更，正在按最新输入重新生成" |
| `POLICY_DENIED` | "该规划请求已失效"，不解释具体原因 |
| `EXPIRED` / `RETRY_EXHAUSTED` / `CANCELLED` / `INTERNAL` | 各自本地化固定文案 |

任何情况下不得渲染服务端异常 message 原文。

### 11.4 并发与顺序

- 一次 run 会为每个 destination candidate 生成一条 `PROPOSED`（`planning-task-handler.ts` 的循环），因此 `proposed` 通常是多条，卡片必须按 `destination` 并列展示，不能只取 `proposed[0]`。
- 新的 handoff 会 stale 掉进行中的 proposed 与其投票。共享面收到 `plans` 刷新后，必须以服务端返回的分组为准重绘，不做本地合并。
- SSE 断线：`subscribeAgentRun` 的 `AbortSignal` 中止后不自动重连；由 `useLatestPlanningRun` 的轮询兜底恢复。
- 同一成员多标签页：各自独立轮询与订阅；未读位点以最后写入者为准，允许不一致。

### 11.5 成员资格变化

成员被移出后，`GET /trips/:tripId`、`/plans`、`/planning/:tripId/run/latest`、`/agent-runs/:runId` 均 `403`。共享视图进入状态 e，不缓存也不残留任何已渲染内容（错误态必须清空数据区）。

---

## 12. 风险与注意事项

| 风险 | 控制措施 |
|---|---|
| planning 管线产不出 `PROPOSED`，展示层变成常驻错误页 | §11.1 的实测门槛作为阶段 1 的准入条件 |
| 自动切换抢占正在输入的私聊 | 只对触发者、只在终态切换（§1.7）；测试 10.2.5 / 10.2.6 固化 |
| 顺手把 owner-only 数据渲染进共享面 | §1.4 白名单 + 组件 props 只接受 `ListedPlan[]` / `teamVisibleFacts`，**不接受 `tripQuery.data.trip` 整体**；测试 10.2.15 |
| 非触发者延迟过大影响演示 | 活跃期 1.5 s 轮询 + SSE；仍不足时才评估 trip 级 SSE（需改 `AgentStreamRelay` 的 subscribe 键，属独立变更） |
| 用户混淆 adoption vote 与 booking confirmation | 独立文案、独立按钮、`PROPOSED` 卡不出现任何 booking 入口（§7.3.5） |
| 前端诊断被服务端静默拒绝 | M8 要求两端 allow-list 同步并补齐既有差集 |
| 把共享面逐步演化成群聊 | §13 非目标写死；任何"在共享面发言"的需求必须先修改 `docs/PRD.md` 非目标与 `docs/agent-architecture.md` 的 Agent 边界 |

**已知技术债（本方案不处理，单独记录）**：`solo-plan-proposal-card.tsx` 与 `useStartPlanning` / `useLatestPlan` 属于 Solo/Personal 路径的未挂载代码，需在 Personal Trip Orchestrator 的后续变更中决定挂载或删除。

---

## 13. 非目标

- 成员在共享面发送消息、@提及、评论或任何形式的成员间对话；
- 共享的 `chat_thread` / `chat_messages`、跨成员可读的会话历史；
- Shared Agent 的用户可见聊天入口或追问能力；
- trip 级 SSE 通道、WebSocket、推送通知、邮件通知；
- 新的持久化时间线表（`trip_shared_events`）——仅在"必须保留每一轮 replan 的先后与原因"成为确认需求时另行立项；
- 手动触发 replan 的 UI；
- 在共享面展示 `ORCHESTRATOR_CONFIDENTIAL` 值、成员归属或由其派生的自由文本。
