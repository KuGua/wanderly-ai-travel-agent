# 探索会话与 Trip 生命周期 — 实施落地方案

> 在 `docs/exploration-trip-lifecycle-implementation.md` 已确认设计之上，给出可分阶段落地的具体任务清单、文件落点、依赖关系与验收条件。本文件为实施前置规划，与事实来源文件（TECH_STACK / PRD / backlog / test-scenarios）一起作为编码契约。

## 0. 关键约束回顾

- 不在 `main` 上提交；分支基于 `develop`（短命 feature 分支）。
- 后端使用 PostgreSQL（Drizzle），前端使用 Next.js，AGENTS 警告这是非标准 Next.js，**编码前必须读 `apps/web/node_modules/next/dist/docs/` 相关章节**确认 app router、layout、locale、metadata API 与 training data 是否一致；任何新文件不要使用过时 API。
- 所有 `Authorization` 仍由现有 `createAuthMiddleware` 完成；不引入新的会话/Token 概念。
- 不得把 `tripId`/`threadId` 写入 `localStorage`、`sessionStorage`、URL、Query Cache 持久层。
- 私有消息、地点、正文不得进入 audit summary、log、metric label、trace 属性（与 PRD §FR-7 一致）。
- 不修改既有 `POST /threads/:threadId/turns` 合同；Trip 仍由 `chat_threads.trip_id` 推导。

## 1. 服务端 / 数据库落地（Phase 1）

### 1.1 数据库迁移

**新增文件：** `apps/api/migrations/0013_exploration_lifecycle.sql`

```sql
-- 新增 Trip 状态 DRAFT
DO $$ BEGIN
  ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'DRAFT';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 审计枚举补两个值
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'EXPLORATION_START';
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_ACTIVATE';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- DRAFT 默认标题占位（仅展示用途，无 PII）
INSERT INTO shared_trips (id, name, created_by, status, departure_cities, destination_candidates)
SELECT gen_random_uuid(), 'Untitled exploration', u.id, 'DRAFT', '[]'::jsonb, '[]'::jsonb
FROM users u WHERE FALSE; -- 仅占位说明，运行时由 service 写入

-- 触发器：除 activate 路径外，DRAFT 不允许离开 DRAFT；activate 由 service 显式控制，
-- 数据库层只接受合法状态转移 PLANNING | CONFIRMED | BOOKED | CANCELLED | STALE
CREATE OR REPLACE FUNCTION enforce_trip_status_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('PLANNING', 'CANCELLED') THEN
    RAISE EXCEPTION 'DRAFT trip may only transition to PLANNING or CANCELLED (was %, new %)',
      OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trip_status_transition ON shared_trips;
CREATE TRIGGER trip_status_transition
  BEFORE UPDATE OF status ON shared_trips
  FOR EACH ROW EXECUTE FUNCTION enforce_trip_status_transition();
```

要点：
- `trip_status` 增加 `DRAFT`；迁移用 `ADD VALUE IF NOT EXISTS` 安全。
- `audit_action` 增加 `EXPLORATION_START` 与 `TRIP_ACTIVATE`。
- 数据库级 transition 触发器对 `DRAFT → PLANNING` 以外的更新抛出异常（防御 service 之外的路径，例如手写 SQL）。
- `shared_trips.departure_cities / destination_candidates` 已经 `NOT NULL`；Draft 允许 `[]`，但 activate 时由 service 校验非空。

### 1.2 Drizzle Schema 同步

**修改文件：** `apps/api/src/db/schema.ts`

- `tripStatusEnum` 增加 `'DRAFT'`。
- `auditActionEnum` 增加 `'EXPLORATION_START' | 'TRIP_ACTIVATE'`。
- 不增加新表；沿用 `shared_trips / trip_members / chat_threads / idempotency_records / audit_events`。

### 1.3 服务端类型 Schema

**修改文件：** `apps/api/src/types/schemas.ts`

```ts
export const tripStatusSchema = z.enum([
  "DRAFT", "PLANNING", "CONFIRMED", "BOOKED", "CANCELLED", "STALE",
]);

export const explorationStartRequestSchema = z.object({
  requestId: z.string().uuid(),
}).strict();

export const explorationStartResponseSchema = z.object({
  trip: tripSummarySchema.extend({
    departureCities: z.array(z.string()).length(0),
    destinationCandidates: z.array(z.string()).length(0),
    travelDateStart: z.null(),
    travelDateEnd: z.null(),
  }),
  defaultThread: z.object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    scope: z.literal("TRIP"),
    isDefault: z.literal(true),
  }),
});

export const tripActivationRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3),
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(2).max(5),
  travelDateStart: dateSchema.nullable().optional(),
  travelDateEnd: dateSchema.nullable().optional(),
}).strict();
```

### 1.4 探索启动服务与路由

**新增文件：** `apps/api/src/services/exploration-service.ts`

```ts
export async function startExploration(params: {
  ctx: RequestContext;
  userId: string;
  requestId: string;
}): Promise<{ trip: DraftTrip; defaultThread: DefaultThread }> {
  return await db.transaction(async (tx) => {
    // 1. idempotency：key 为 `exploration:<userId>:<requestId>`，
    //    命中即返回 cached result，不重复创建。
    const claimed = await claimIdempotency(tx, {
      key: idempotencyKey("exploration", params.userId, params.requestId),
      entityType: "exploration_start",
      ttlSeconds: 24 * 60 * 60,
    });
    if (!claimed) {
      const cached = await loadIdempotencyResult(idempotencyKey(...));
      if (cached) return cached;
      throw new ApiError(409, "Conflict", "Duplicate exploration start");
    }

    // 2. 单事务写 shared_trips(DRAFT) / trip_members(CREATOR) / chat_threads(default)
    const [trip] = await tx.insert(sharedTrips).values({
      name: "Untitled exploration",
      createdBy: params.userId,
      status: "DRAFT",
      departureCities: [],
      destinationCandidates: [],
      travelDateStart: null,
      travelDateEnd: null,
    }).returning();

    await tx.insert(tripMembers).values({
      tripId: trip.id, userId: params.userId, role: "CREATOR", isRequired: true,
    });

    const [thread] = await tx.insert(chatThreads).values({
      ownerUserId: params.userId,
      tripId: trip.id,
      scope: "TRIP",
      isDefault: true,
      title: "Untitled exploration",
    }).returning();

    await recordAudit({ ctx, action: "EXPLORATION_START",
      actorUserId: params.userId, tripId: trip.id,
      summary: { idempotencyOutcome: "created" }, tx });
    await recordAudit({ ctx, action: "TRIP_DEFAULT_THREAD_PROVISION",
      actorUserId: params.userId, tripId: trip.id,
      summary: { threadId: thread.id, source: "exploration_start" }, tx });

    const result = { trip: toDraftTrip(trip), defaultThread: toDefaultThread(thread) };

    // 3. 写回 idempotency_records.resultPayload，供重试读取。
    await completeIdempotency(tx, claimed.key, "exploration_start", trip.id, result);
    return result;
  });
}
```

**新增文件：** `apps/api/src/routes/explorations.ts`

```ts
app.post("/explorations/start", {
  schema: { body: ..., response: { 201: ..., 200: ... } },
}, async (request, reply) => {
  const ctx = createRequestContext(...);
  const { requestId } = explorationStartRequestSchema.parse(request.body);
  const result = await startExploration({ ctx, userId: request.user.id, requestId });

  const wasNew = reply.statusCode === 201; // startExploration 内部可返回 cached 标记
  reply.code(wasNew ? 201 : 200).send(explorationStartResponseSchema.parse(result));
});
```

要点：
- `requestId` 是客户端生成的 UUIDv4（同 session 内首次 Send 时落地到 Provider，刷新/重开 tab 仍唯一）。
- 返回 `201` 表示新建、`200` 表示 idempotency 重放，二者响应体完全相同。
- 不接受地点、Profile、国籍或聊天正文；只接收 `requestId`，符合最小化 PII 暴露。

### 1.5 Trip 激活（Draft → PLANNING）

**修改文件：** `apps/api/src/routes/trips.ts`

```ts
app.post("/trips/:tripId/activate", { schema: ... }, async (request, reply) => {
  const { tripId } = z.object({ tripId: z.string().uuid() }).parse(request.params);
  const body = tripActivationRequestSchema.parse(request.body);
  const ctx = createRequestContext(...);

  await db.transaction(async (tx) => {
    const [trip] = await tx.select().from(sharedTrips)
      .where(eq(sharedTrips.id, tripId)).for("update").limit(1);
    if (!trip) throw new ApiError(404, "Not Found", "Trip not found");
    if (trip.status !== "DRAFT") {
      throw new ApiError(409, "Conflict", "Only DRAFT trips can be activated");
    }
    if (trip.createdBy !== request.user.id) {
      throw new ApiError(403, "Forbidden", "Only the creator may activate the trip");
    }
    // 显式覆盖 brief
    await tx.update(sharedTrips).set({
      name: body.name,
      departureCities: body.departureCities,
      destinationCandidates: body.destinationCandidates,
      travelDateStart: body.travelDateStart ?? null,
      travelDateEnd: body.travelDateEnd ?? null,
      status: "PLANNING", // 触发器允许 DRAFT → PLANNING
      updatedAt: new Date(),
    }).where(eq(sharedTrips.id, tripId));

    await recordAudit({ ctx, action: "TRIP_ACTIVATE",
      actorUserId: request.user.id, tripId,
      summary: { briefLength: { cities: body.departureCities.length,
                                 candidates: body.destinationCandidates.length } }, tx });
  });

  const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
  return reply.code(200).send({ trip });
});
```

### 1.6 Draft 服务端 guard 改造

下列路由对 Draft Trip 必须 `409 TRIP_NOT_ACTIVE` 拒绝，无副作用（不写 audit、不分配租约、不创建 plan）：

| 文件 | 改动 |
|---|---|
| `apps/api/src/services/trip-invitation-service.ts` | `createInvitation` / `acceptInvitation` 入口加 `sharedTrips.status !== 'DRAFT'` 检查。 |
| `apps/api/src/routes/consent.ts` | `POST /consent/grant`、`POST /consent/revoke`、`GET /consent/:tripId/me` 在 `membership` 检查后加状态检查。 |
| `apps/api/src/routes/planning.ts` | `POST /planning/generate`、`POST /replan`、`GET /plans/latest` 同样。 |
| `apps/api/src/routes/confirmations.ts` | `POST /confirmations`、`GET /confirmations/:planId` 同样。 |
| `apps/api/src/routes/bookings.ts` | `POST /bookings` 同样。 |
| `apps/api/src/routes/change-events.ts` | `POST /change-events` 同样。 |

实现建议：新增轻量 helper

```ts
// apps/api/src/services/trip-status-guard.ts
export async function requireActiveTrip(tripId: string, ctx: RequestContext) {
  const [trip] = await db.select({ status: sharedTrips.status })
    .from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
  if (!trip) throw new ApiError(404, "Not Found", "Trip not found");
  if (trip.status === "DRAFT") {
    throw new ApiError(409, "Conflict", "TRIP_NOT_ACTIVE: activate the trip first");
  }
  return trip;
}
```

### 1.7 索引 / 性能

- 现有 `shared_trips` 主键索引足够，DRAFT 列表由 `created_by + status` 过滤，可在迁移中追加：
  ```sql
  CREATE INDEX IF NOT EXISTS shared_trips_created_by_status_idx
    ON shared_trips (created_by, status, created_at DESC);
  ```
- 不新增其他索引。

## 2. 前端落地（Phase 2）

### 2.1 ExplorationSessionProvider

**新增目录：** `apps/web/src/lib/exploration/`

```
exploration/
  exploration-session-provider.tsx   # Context + Provider
  use-exploration-session.ts         # 读取 hook
  start-exploration-mutation.ts      # 首条 Send 前置 start 的 mutation 封装
  exploration-session-provider.test.tsx
```

**Provider 契约：**

```ts
type ExplorationSession = {
  sessionId: string;       // crypto.randomUUID()，Provider mount 时一次性生成
  tripId: string | null;   // start 成功后写入
  threadId: string | null; // start 成功后写入
  startRequestId: string | null;
  status: "idle" | "starting" | "ready" | "error";
};

type ExplorationSessionContextValue = {
  session: ExplorationSession;
  startIfNeeded: () => Promise<{ tripId: string; threadId: string; startRequestId: string }>;
  reset: () => void;
};
```

实现要点：
- **只存 React 内存**。禁止任何持久化写入。
- `sessionId` 在 Provider mount 时一次性生成（每个浏览器 tab/刷新/账号切换都重建）。
- 监听 `useAuth().sessionRevision`；值变化时调用 `reset()` 并重建 `sessionId`。
- `startIfNeeded` 内部维护 in-flight Promise；并发调用共享同一 `startRequestId` 与同一 fetch。
- 监听 `window.beforeunload`：卸载时不做任何持久化（页面级 in-memory，无需清理）。
- 在 React `StrictMode` 下双调用必须安全（用 ref 标记已发起 / 已完成）。

### 2.2 Providers 装配

**修改文件：** `apps/web/src/app/providers.tsx`

```tsx
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AuthenticatedQueryProvider>
        <ExplorationSessionProvider>{children}</ExplorationSessionProvider>
      </AuthenticatedQueryProvider>
    </AuthProvider>
  );
}
```

`ExplorationSessionProvider` 必须在 `QueryProvider` **之内**（依赖 `useQueryClient`），但位于 `AuthProvider` **之下**（依赖 `useAuth().sessionRevision` 触发 reset）。

### 2.3 首次 Send 编排

**修改文件：** `apps/web/src/components/explore/explore-chat-host.tsx`

- 删除：
  - `useTrips()`、`trips[0]` 自动选取逻辑；
  - `useGetOrCreateDefaultTripThread`、`useTripThreads`；
  - `TripPickerChip`；
  - `autoProvisionAttemptedRef` 相关 effect。
- 新增：
  - `const exploration = useExplorationSession();`
  - 把 `effectiveThreadId` 改为 `exploration.session.threadId`、`threadStatus` 改为派生：`starting` → `"preparing"`、`ready` → `"ready"`、`error` → `"error"`。
  - `onRetryThread` 直接调 `exploration.reset(); exploration.startIfNeeded();`。
  - `onThreadInvalidated` 调 `exploration.reset()`，因为该 `threadId` 不再属于当前 session（draft trip 可能已激活）。

**修改文件：** `apps/web/src/components/explore/travel-agent-chat.tsx`

- 新增 prop（保持向后兼容，默认空实现）：
  ```ts
  onEnsureThreadForFirstSend?: () => Promise<{ threadId: string }>;
  ```
- 仅 `submitMessage` 在 `effectiveThreadId == null` 且 `onEnsureThreadForFirstSend` 存在时，先 `await onEnsureThreadForFirstSend()` 拿到 `threadId` 再走 `submitTurn`。地图点击、打开聊天和任何 effect 均不得调 start 或发送 turn。
- host 会把 Provider 写入的 `threadId` 通过 prop 传下来；本组件内不直接调 start。失败重试保留同一个 `startRequestId`，只有显式“开始新的探索”或认证会话变化才生成新 key。
- 既有 history / SSE / Stop 路径保持不变。

### 2.4 Home / Projects / Trip Workspace

**修改文件：** `apps/web/src/app/[locale]/home/page.tsx`
- `home/page.tsx` 已经是 `/home` 入口；保留 `HomeDashboard`，但增加 `DRAFT` 计数与"未保存想法"提示卡（文案来自 i18n，详见 §2.5）。

**修改文件：** `apps/web/src/components/home/home-dashboard.tsx`
- 新增 `DraftSection` 子组件：调用 `useTrips({ status: "DRAFT" })`，展示卡片"未发送任何消息也会显示，但只有您能查看"。
- 卡片 CTA：`Link href="/trips/{draftId}"`，进入 trip workspace 后展示 `ActivateDraftPanel`。

**修改文件：** `apps/web/src/components/home/trip-list.tsx`
- 列表项接受 `status: "DRAFT"`，渲染「草稿」徽标，不显示目的地/日期（draft 没有 brief）。
- 不展示"Confirm plan" / "Grant consent" 等下游 action；只渲染"继续编辑"或"开始规划"入口。

**修改文件：** `apps/web/src/components/trips/trip-workspace.tsx`
- `trip.status === "DRAFT"` 时：
  - 只渲染 `BriefEditor` + `ActivateButton`。
  - 隐藏 invitation/consent/plan/confirmation/booking UI（即便 URL 直达也按 status 渲染分支）。
  - `useActivateTrip` 调用 `POST /trips/:tripId/activate`，成功后 `queryClient.invalidateQueries({ queryKey: tripKeys.all })` 并跳转 `/trips/:tripId`。
- 非 DRAFT 路径不变。

### 2.5 i18n 新增键

文件：`apps/web/messages/en.json` 与 `zh.json`（按项目实际命名）

```
explore.session.error.start: "Couldn't start a new exploration. Please retry."
explore.session.error.idempotencyConflict: "An exploration is already in progress for this tab."
explore.session.startNew: "Start a new exploration"
trip.draft.title: "Untitled exploration"
trip.draft.activateCta: "Start planning / Invite co-travelers"
trip.draft.activateHint: "Add at least one departure city and 2–5 candidate destinations to continue."
trip.draft.empty: "No draft — start a new exploration from the home map."
trip.status.draft: "Draft"
```

## 3. 依赖顺序

```
[Phase 1.1 迁移] → [1.2 schema] → [1.3 types]
       └→ [1.4 exploration service & route] → [1.5 activate route] → [1.6 Draft guards]
              └→ [Phase 2.1 Provider] → [2.2 providers.tsx] → [2.3 chat host + travel-agent-chat] → [2.4 home/projects/trip workspace]
                                                                                                  └→ [§4 测试]
```

`chat_threads.trip_id NOT NULL` 已经在 0012 迁移中确认；本特性沿用该不变量。

## 4. 测试与可观测性

### 4.1 服务端测试

`apps/api/tests/` 新增：

| 测试文件 | 覆盖 |
|---|---|
| `exploration-start.test.ts` | 首次创建 Draft trip + member + default thread 单事务；同 `requestId` 重试返回同 trip，状态码 `200`；不同 `requestId` 第二次返回 `201` 新 trip；并发 5 次只产生 1 trip；start 失败整体回滚，无 audit / idempotency 半成品。 |
| `trip-activate.test.ts` | Draft → PLANNING 合法；非 Draft 返回 409；非 creator 返回 403；brief 不合法（出发地 0 / 候选 <2）返回 422；激活后 `itinerary_plans` 创建路径仍走原流程。 |
| `draft-guard.test.ts` | invitation / consent / planning / confirmation / booking / change-events 在 DRAFT 上全部 `409 TRIP_NOT_ACTIVE`，无副作用（不写 audit、不创建 plan、不分配租约）。 |
| `trip-status-enum.test.ts` | 数据库触发器阻止非法转移（如 `DRAFT → CONFIRMED`）；手动 `UPDATE` 也被拒绝。 |
| `idempotency-scope.test.ts` | 同一 `requestId` 不同用户互不冲突；同一用户不同 `requestId` 都创建独立 Draft。 |

更新现有 `apps/api/tests/integration.test.ts` 的小节，验证 `chat_threads.trip_id` 在 Draft 下 NOT NULL 仍然成立。

### 4.2 前端测试

`apps/web/src/lib/exploration/exploration-session-provider.test.tsx`：

- mount 一次生成 `sessionId`；卸载再 mount 得到新值。
- `auth.sessionRevision` 变化触发 `reset`，`tripId/threadId/startRequestId` 全清空且 `sessionId` 重新生成。
- `startIfNeeded` 并发调用共享同一 fetch；成功后再次调用直接返回缓存。
- 失败时 `status === "error"`；Retry 使用原 `startRequestId`，`reset()` 仅用于显式开始新的探索或服务端报告 thread 已失效。
- Provider 不会向 `window.localStorage`、`sessionStorage`、`document.cookie` 写入（通过 spy 断言）。

`apps/web/src/components/explore/explore-chat-host.test.tsx`：

- 不再依赖 `useTrips`；不再渲染 `TripPickerChip`。
- Provider 未 start 时 `TravelAgentChat` 收到 `threadStatus="preparing"` 且 `effectiveThreadId=null`。
- start 成功后，session 的 `threadId` 注入到 chat。
- `onThreadInvalidated` 调 `reset()`，session 回到 `idle`。

`apps/web/src/components/explore/travel-agent-chat.test.tsx`：

- `submitMessage` 在 `effectiveThreadId=null` 时先 `await onEnsureThreadForFirstSend()`，再走 submit。
- 已发送过的 `sessionMessages` 在 session 重置后被丢弃（host 会触发 `clearLocalSessionState`）。
- 既有 SSE / Stop / history 测试保持不变。

### 4.3 test-scenarios.md 更新

`docs/test-scenarios.md` 增加（与 §7.1 "FR-1 探索会话"对应）：

1. 进入 `/home` 不创建任何 Trip/thread/audit。
2. 同 tab 切换到 `/profile` 后回 `/home`，会话保留。
3. 关闭重开 tab 进入 `/home`，新会话；前一会话若有 Draft，仍在 `/home` 列表。
4. 首次 Send 并发触发 5 次（`Promise.all`）只产生 1 Draft；后续重试用同 `requestId` 拿同一 trip。
5. start 成功但 turn 失败：Draft 与 thread 已存在；`/trips/:draftId` 可继续发送；不会再次 start。
6. Draft 上 invitation/consent/planning/confirmation/booking 全部 `409 TRIP_NOT_ACTIVE`。
7. activate 后 `itinerary_plans` 流程正常。
8. 账号切换：旧 session `tripId/threadId` 在 `sessionRevision++` 时被清空；不向后端发任何请求。
9. `?tripId=` query 也不携带：手动测试刷新 URL 加 `?tripId=<uuid>` 不会注入到 Provider（验证 `tripId` 不来自 URL）。

### 4.4 可观测性

新增 OTel spans：
- `exploration.start`（SERVER，属性 `app.operation=exploration.start`、`app.result=created|cached`、`app.trip_status=draft`）。
- `trip.activate`（同上）。

新增低基数 metrics（`apps/api/src/observability/metrics.ts`）：
- `exploration_start_total{result=created|cached|conflict|error}`
- `trip_activation_total{result=success|conflict|forbidden|invalid|error}`
- `draft_command_rejected_total{operation=invitation|consent|planning|confirmation|booking|change_event}`

属性安全：
- span 属性只允许 `app.operation / app.result / app.trip_status / app.idempotency_outcome`。
- `tripId` / `threadId` 仅作 trace/log correlation，不作 metric label；遵守既有 `safeSetAttribute` 白名单（参考 `tests/spans-forbidden-attributes.test.ts`）。

Pino redaction：
- 沿用既有 `LOGGER_REDACTION`，确保 start/activate 路径不写入 message body、place、profile。
- audit summary 仅含 `idempotencyOutcome / briefLength` 等结构化字段，禁止包含 message / place。

## 5. 风险与控制（与方案 §7 对齐）

| 风险 | 控制 |
|---|---|
| 重复 Draft | `POST /explorations/start` 是唯一入口；effect / render 不得调用；前端 Provider 用 `startRequestId` 锁定调用。 |
| 刷新语义错误 | Provider 严格 in-memory；禁止任何持久化；测试断言 `localStorage`/`sessionStorage` 写入次数为 0。 |
| 状态绕过 | 每条协作 route/service 调用 `requireActiveTrip`；数据库触发器兜底；新增 `draft-guard.test.ts` 全量覆盖。 |
| 空数组泄漏到 planning | Draft 允许 `[]`；activate 通过 Zod schema 校验非空；既有 `POST /trips` 校验保留。 |
| 隐私泄露 | 默认 trip 名 `Untitled exploration`；start/activate DTO 与 audit 不携带正文 / place / profile；测试断言 schema `.strict()`。 |

## 6. 验证清单（实施完成后）

- [ ] `npm run --workspace apps/api migrate` 与 `npm run --workspace apps/api test` 通过。
- [ ] `npm run --workspace apps/web test` 通过；新增的 Provider / ChatHost / TravelAgentChat 测试覆盖上述行为。
- [ ] 手工验证 happy path：登录 → `/home` → 输入消息 → 列表出现 Draft → 点开 Draft → 填 brief → Activate → 邀请/同意/规划/确认/沙箱全部可达。
- [ ] 手工验证失败路径：Draft 上点邀请/同意 → 收到 409；刷新 `/home` → 同 tab 不重置，换 tab 重置；账号切换 → Provider session 清空。
- [ ] CloudWatch：`exploration_start_total{result=*}`、`trip_activation_total{result=*}`、`draft_command_rejected_total{operation=*}` 出现并按预期分布。
- [ ] `docs/exploration-trip-lifecycle-implementation.md` 的 §1-§5 在新行为下逐条可复现。

## 7. 不在本次范围

- 不改 `POST /threads/:threadId/turns` 的请求/响应。
- 不改 thread → trip 的派生方式（继续 `chat_threads.trip_id`）。
- 不引入 Redis / WebSocket / 新多 Agent；不引入 Web Push / 离线协作。
- 不修改 `localDevelopment` / `custom-local` 的鉴权路径（`AuthMode` 不变）。
- 不做 Draft 自动迁移 / 自动 activate。
