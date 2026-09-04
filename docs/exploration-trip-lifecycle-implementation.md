# 探索会话与 Trip 生命周期实施方案

**状态：** 已实施
**范围：** `/home` 探索入口、私有对话初始化、Trip 草稿及从探索进入协作规划。  
**关联事实来源：** `TECH_STACK.md`、`docs/PRD.md`、`docs/backlog.md`、`docs/test-scenarios.md`。

## 1. 固定行为

1. 新标签页、关闭后重新打开或整页刷新进入 `/home`，开始新的探索会话。
2. 同一标签页内站内路由切换到项目、资料等页面再返回 `/home`，继续同一探索会话。
3. 地图浏览、坐标点击、聊天打开/关闭均不创建或持久化 Trip。
4. 仅用户提交第一条聊天消息时，服务端创建 `DRAFT` Trip、创建者 membership 与默认私有 thread，并在该 thread 接受该消息。
5. “开始新的探索”仅替换当前内存会话；不删除、归档或改变既有 Trip。
6. Draft 只能进行创建者私有探索与编辑 brief；创建者点击“开始规划/邀请同行者”且 brief 合法后，才激活为 `PLANNING`。
7. 含至少一条用户消息的 Draft 显示在“我的项目”，只能通过明确项目入口恢复；`/home` 不自动选择历史 Trip。

## 2. 目标架构

```text
Next.js LocaleLayout
└─ AppProviders
   └─ ExplorationSessionProvider（仅内存）
      ├─ /home → ExploreChatHost
      │  └─ first Send → POST /explorations/start → POST /threads/:threadId/turns
      ├─ /projects → 仅读成员可见的 Trip
      └─ /trips/:tripId → 显式恢复历史 Trip

Fastify POST /explorations/start
└─ PostgreSQL 单一事务
   ├─ shared_trips (DRAFT)
   ├─ trip_members (creator)
   ├─ chat_threads (creator default)
   ├─ idempotency_records
   └─ audit_events
```

### 2.1 前端会话边界

新增 `ExplorationSessionProvider`，挂载在现有认证与 Query Provider 边界内：

```ts
type ExplorationSession = {
  sessionId: string;       // crypto.randomUUID()；每个 Provider 生命周期唯一
  tripId: string | null;   // start 成功后写入
  threadId: string | null; // start 成功后写入
  startRequestId: string | null;
};
```

- 只能存 React 内存；禁止 URL、`localStorage`、`sessionStorage` 和持久 Query cache。
- `LocaleLayout` 下客户端路由保留 Provider；刷新、关闭/新开标签页和认证账号切换都重建 Provider。
- 认证 `sessionRevision` 改变时强制 reset；不得让后登录用户重用旧 session 的 ID。
- `tripId`/`threadId` 仅是 UI 上下文；数据库和服务端仍是 membership、thread ownership、task Trip 归属的唯一权威。
- 地图的“开始探索”只打开聊天面板并保留所选地点作为输入提示；不得通过 effect、自动问句或任何地图事件调用 start/turn 接口。
- 可见的“开始新的探索”操作只调用 `reset()`；进行中的 turn 期间必须禁用，避免切换 UI 上下文而遗漏仍在运行的任务。

### 2.2 服务端约束

- 继续由 `chat_threads.trip_id` 推导 conversation task 的 `tripId`；既有 `POST /threads/:threadId/turns` 不接收客户端 `tripId`。
- 探索创建仅经 `POST /explorations/start`；不接受地点、Profile、国籍或聊天正文。
- Draft 禁止 invitation、consent、snapshot、planning/replan、confirmation、booking。每个服务端命令都必须 guard，而非仅隐藏前端入口。
- 消息正文、地点和 Profile 不得写入 audit summary、日志、trace 或 metric label。

## 3. 数据模型与状态机

### 3.1 Trip 状态

将 PostgreSQL `trip_status` 扩展为：

```text
DRAFT | PLANNING | CONFIRMED | BOOKED | CANCELLED | STALE
```

复用 `shared_trips`，不创建第二套 exploration/project 模型。

| 字段 | `DRAFT` 规则 |
|---|---|
| `id` | 数据库 UUID |
| `created_by` | 当前认证用户 |
| `status` | `DRAFT` |
| `name` | 服务端生成的非敏感默认标题，后续可编辑 |
| `departure_cities` / `destination_candidates` | `[]` |
| `travel_date_start/end` | `null` |

已有 JSON `NOT NULL` 约束保留；仅 Draft 可以空数组。创建/激活 `PLANNING` 时必须至少有一个出发地和两个候选目的地。

### 3.2 复用对象

- `trip_members`：复用唯一 `(trip_id, user_id)`；创建者是 `CREATOR`、`is_required=true`。
- `chat_threads`：复用 `TRIP` scope 和每成员每 Trip 默认 thread 的唯一约束。
- `idempotency_records`：以 `(authenticated user ID, start requestId)` scope 复用，防双击、超时重试、并发。
- `audit_events`：复用 `TRIP_CREATE` 与 `TRIP_DEFAULT_THREAD_PROVISION`；新增 `EXPLORATION_START`、`TRIP_ACTIVATE`，summary 仅含 ID、状态与 idempotency 结果。

## 4. API 合同

### 4.1 开始探索

`POST /api/v1/explorations/start`

请求：

```json
{ "requestId": "uuid-v4" }
```

首次响应 `201`，同一 requestId 重试响应 `200`，响应体一致：

```json
{
  "trip": { "id": "uuid", "name": "Trip Planner", "status": "DRAFT", "departureCities": [], "destinationCandidates": [], "travelDateStart": null, "travelDateEnd": null },
  "defaultThread": { "id": "uuid", "tripId": "uuid", "scope": "TRIP", "isDefault": true }
}
```

实现：在单一数据库事务中写 Trip、membership、default thread、审计及 idempotency result；失败全回滚。相同 requestId 必须返回同一资源。页面 mount、地图事件及 SSE 订阅不得调用该接口。

### 4.2 首条消息

1. 首次 Send 生成并缓存 `startRequestId`，调用 start。
2. 成功后写 Provider 的 `tripId`/`threadId`，失效 `['trips']`、Trip detail 和 thread query keys。
3. 使用独立、稳定的 conversation `requestId` 调用既有 turn endpoint，并复用既有 Worker/SSE 流程。
4. start 成功但 turn 失败时保留 Trip/thread；后续重试不得重新 start。start 超时用同一 `startRequestId` 重试。

### 4.2.0 自动标题的语言由调用方提供

`buildTripTitle` 只拼接 brief 里的显式字段，语言完全取决于请求里的 `titleLocale`；服务端不猜测。因此**每一个会写标题的前端调用点都必须显式传入当前界面语言**，包括：

- `PATCH /trips/:tripId/draft-brief`（用户在对话里确认 brief 卡片）；
- `POST /trips/:tripId/activate`（用户点「开始规划」）。

这两个命令都由 `TravelAgentChat` 发出，而它有**两个挂载点**：探索页的 `ExploreChatHost` 和行程工作台的 `TripWorkspace`。`titleLocale` 的 prop 默认值是 `"en"`，所以漏传不会报错，只会静默产出英文标题——2026-09-03 前 `TripWorkspace` 正是漏传方，中文用户在工作台确认 brief 后得到 `新加坡 Trip Planner｜4 Days`：目的地来自用户自己的话，其余是默认语言。新增挂载点时必须一并传入。

> 已知缺口（修复已排期，未实现）：`POST /explorations/start` 的请求体只有 `requestId`，草稿行名固定写入 `"Trip Planner"` / `titleLocale: "en"`，同一事务创建的 default thread 标题同样固定为英文 `"Trip Planner"`（`exploration-service.ts:107`）。在确认第一份 brief 之前，中文用户的行程列表与工作台 thread rail 里全是英文占位名。修复方案是为该 DTO 增加 `locale` 字段，并由服务端同时决定 draft trip 的 `titleLocale` 与 default thread 的 `title_locale`；实施合同见 [Thread 标题生命周期实施规范](thread-title-lifecycle-implementation.md) §7.4。

### 4.2.1 线程状态与提示语

Explore 的线程是懒创建的，因此「还没有线程」是常态而非等待。Session 的四个状态与聊天界面的 `ChatThreadStatus` 一一对应，不得合并：

| Session (`ExplorationSessionStatus`) | `ChatThreadStatus` | 界面 |
|---|---|---|
| `idle`（尚未发送首条消息） | `idle` | 不渲染任何横幅；输入框可用，其 placeholder 已在邀请输入 |
| `starting`（start 请求进行中） | `preparing` | “正在准备你的私人对话…” |
| `ready` + 有 `threadId` | `ready` | 不渲染横幅 |
| `error` | `error` | “私人对话暂不可用。” + 重试（复用同一 `startRequestId`） |

`idle` 与 `preparing` 曾被合并，导致探索页在用户发出第一条消息之前一直显示「正在准备」——描述了一件没有任何人开始的工作。判断标准是横幅必须描述真实进行中的动作。

Trip workspace 是另一回事：它要么已有线程，要么正在拉取线程列表或自动创建默认线程，因此不存在 `idle`，全部等待期都如实报告为 `preparing`。该页显式传入 `threadStatus`，不依赖 `TravelAgentChat` 的默认值——组件本身无法区分「还没有线程」和「线程正在路上」，只有发起方知道。

### 4.3 激活正式规划

新增 `POST /api/v1/trips/:tripId/activate`，仅 creator 可调用，提交 name、出发地、2–5 候选地及可选日期。事务内校验 Draft、写完整 brief、状态变为 `PLANNING` 并记录 `TRIP_ACTIVATE`。Draft 上 invitation、consent、planning/replan、confirmation、booking 返回 `409` + `TRIP_NOT_ACTIVE`，无副作用。

## 5. 工程模块

| 分类 | 模块 | 改动 |
|---|---|---|
| 新增 | `apps/web/src/lib/exploration/*` | Provider、context/hook、首次发送初始化 mutation、auth reset |
| 修改 | `apps/web/src/app/providers.tsx` | 在现有认证/Query 边界内挂载 Provider |
| 修改 | `ExploreChatHost` | 移除 `useTrips()`/`trips[0]` 自动选取和 Trip picker；改为读取 Session |
| 修改 | `TravelAgentChat` | 在首发前 await `onEnsureThreadForFirstSend`；地图选择只预填问题，不自动发送；提供禁用态的“开始新的探索”，其余 history、SSE、Stop 均复用 |
| 修改 | projects/Trip workspace | `DRAFT` 与进行中项目共用工作台；creator 在私有对话确认完整 brief 后，可在同一工作台显式 activate；旧项目仅显式打开 |
| 修改 | Drizzle schema/migration/types | `DRAFT` enum、创建/激活 DTO 与数据库 migration |
| 新增 | exploration route/service/schema | start 的原子事务、idempotency、审计、OpenAPI |
| 修改 | invitation/consent/planning/confirmation/booking | Draft 服务端状态 guard |
| 复用 | thread service/task repository/Worker/ModelGateway/SSE | 不改变 thread→Trip 推导、持久 task 和模型权限边界 |

## 6. 实施顺序

1. **合同与迁移：** 更新状态 enum、Zod/domain/OpenAPI、迁移和事实来源文档。
2. **服务端生命周期：** start service/route/idempotency/audit，activate command，所有 Draft guard 和集成测试。
3. **Explore 会话：** Provider、首次 Send 编排、重试状态、“开始新的探索”、Query invalidation 与前端测试。
4. **项目与激活 UX：** Draft 卡片、workspace 编辑、显式 activate、错误状态与 i18n。
5. **回归和发布：** API/Web/跨用户/Worker-SSE 回归，更新 API reference、监控与 runbook。

Phase 2 依赖 Phase 1 的 start contract；Phase 3 依赖 start 与 activate contract。不得先在前端伪造 Draft 或把 `tripId` 放入客户端持久存储。

## 7. 测试、指标与风险

必须测试：空浏览零写入；首发并发/重试只创建一个 Draft；start 成功/turn 失败不重复；站内导航保持、刷新/新标签不保持；账号切换清空；Draft 所有协作命令拒绝；激活后正常协作；跨 owner 访问拒绝。

新增 `exploration.start`、`trip.activate` spans。安全属性仅限 `app.operation`、`app.result`、`app.trip_status`、idempotency outcome；ID 仅作 trace/log 关联，不作 metric label。新增低基数指标：`exploration_start_total{result}`、`trip_activation_total{result}`、`draft_command_rejected_total{operation}`。

主要风险与控制：

- 重复 Draft：只允许受 idempotency 保护的用户动作触发 start，禁止 effect/render 触发。
- 刷新语义错误：禁止 `sessionStorage`。
- 状态绕过：每条协作 route/service 都进行服务端状态检查。
- 空数组泄漏到规划：仅 Draft 允许；activation 和原有正式创建保持完整 brief 校验。
- 隐私泄露：default title、start DTO 和审计均不携带正文、地点或 Profile。
