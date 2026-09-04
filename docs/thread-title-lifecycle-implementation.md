# 私有对话 Thread 标题生命周期实施规范

**状态：** 已批准，待实现
**范围：** `chat_threads.title` 的服务端权威生命周期——创建、确定性命名、owner 手动重命名、owner 显式触发的 LLM 命名。
**前置文档：** [Trip-scoped 私有对话实施规范](trip-scoped-private-threads-implementation.md)、[探索行程生命周期实施规范](exploration-trip-lifecycle-implementation.md)、[LLM Gateway 契约](../apps/api/src/providers/LLM-GATEWAY.md)

---

## 1. 目标与非目标

### 1.1 目标

1. `chat_threads.title` 具备完整生命周期：有来源标记、有语言标记、有更新时间、可被 owner 修改。
2. 消除服务端硬编码的英文占位标题，使 default thread 的标题符合 [LLM-GATEWAY.md](../apps/api/src/providers/LLM-GATEWAY.md) §User-visible language contract 的语言权威规则。
3. 额外 thread 的标题编号权威从浏览器收回服务端。
4. Owner 可以重命名自己的 thread；重命名后自动命名永不覆盖。
5. Owner 可以显式请求由 LLM 依据本 thread 的对话内容命名，失败时确定性回落且不改写既有标题。

### 1.2 非目标

- 不做后台自动 LLM 命名（见 §12.3 升级路径与判据）。
- 不做对话主题漂移检测与标题重算。
- 不实现 `chat_messages.redacted_summary` 的服务端填充；本方案与其保持独立管线（见 §3 D5）。
- 不改变 thread 的所有权、可见性或授权模型；本方案不新增任何跨成员可见面。
- 不引入新的运行时依赖、数据存储或第三方服务（见 §4）。

---

## 2. 现状基线

### 2.1 title 的三条写入路径

| 场景 | 写入位置 | 当前值 | 问题 |
|---|---|---|---|
| 探索页首次发消息 | `apps/api/src/services/exploration-service.ts:107` | 硬编码 `"Trip Planner"` | 英文写死，中文界面中英混排 |
| 接受行程邀请 | `apps/api/src/services/trip-invitation-service.ts:377` | 硬编码 `"Personal trip scratchpad"` | 同上 |
| 用户点“新建对话” | `apps/web/src/components/trips/trip-workspace.tsx:167` | 前端计算 `新对话 {threads.length + 1}` | 标题权威在客户端；并发创建会撞名 |

### 2.2 缺失能力

- `apps/api/src/routes/trip-threads.ts` 仅有 `GET /threads`、`POST /threads`、`POST /threads/default`；**无任何 title 更新路径**，owner 无法重命名。
- `chat_threads`（`apps/api/src/db/schema.ts:684`）无 `title_source` / `title_locale` / `title_updated_at`，无法区分系统生成与用户命名。
- `apps/web/messages/{en,zh}.json` 中 `threads.newThread.placeholder` / `.submit` / `.validation` 为死键（创建流程已无标题输入框）。

### 2.3 既有可复用先例

| 能力 | 位置 |
|---|---|
| `nameSource` / `titleLocale` 列形状与语义 | `apps/api/src/db/schema.ts:348-349`（`shared_trips`） |
| 手动改名把 AUTO 转 MANUAL 的事务写法 | `apps/api/src/routes/trips.ts:492-541`（`PATCH /trips/:tripId/title`） |
| 确定性标题合成 | `apps/api/src/services/trip-title-service.ts` |
| Skill 契约（scope / 超时 / Zod / 审计） | `apps/api/src/agents/skill-registry.ts` |
| LLM 调用唯一出口 | `apps/api/src/providers/gateway-factory.ts` |
| 调用 gateway 并对输出做校验的 Skill 范式 | `apps/api/src/skills/personal/trip-constraint-propose-skill.ts` |
| 请求限流范式 | `apps/api/src/routes/location-introduction-rate-limit.ts` |
| 有界标签计数器 | `apps/api/src/observability/metrics.ts`（`registerCounter` / `inc`） |

---

## 3. 关键技术决策

| ID | 决策 | 理由 | 边界 |
|---|---|---|---|
| **D1** | `title` 是服务端权威字段，客户端不得计算或推测 | 现状由前端按 `threads.length + 1` 计算，多标签页并发会撞名；AGENTS.md 要求前端状态不得取代服务端业务状态 | 客户端仅在手动重命名时乐观更新 |
| **D2** | 按 thread 类型分治：**default thread 走确定性本地化标签，不调用 LLM**；**额外 thread 由 owner 显式触发 LLM 命名，失败回落确定性编号** | default thread 每 (owner, trip) 唯一，标题不承担区分职责，其内容边界等于 trip 本身，确定性即最优；额外 thread 的区分信息只存在于对话内容中，确定性方案在结构上无法产出 | 两类 thread 走不同代码路径，由 `is_default` 判定 |
| **D3** | LLM 命名是 **owner 显式点击触发**，不是后台自动生成 | 显式点击即 owner 对“读取我这段对话来命名”的授权，与仓库既有的显式授权模型一致；避免在“聊几轮算够”上做无依据猜测；失败可由用户重试而非静默留下坏标题 | 升级为后台自动生成的判据见 §12.3 |
| **D4** | `title_source = 'MANUAL'` 后，自动路径永不覆盖 | 与 `PATCH /trips/:tripId/title` 把 `nameSource` 置 `MANUAL` 的既有语义一致 | 唯一例外是用户在 UI 上确认覆盖后再次触发 AI 命名（§13） |
| **D5** | 与 `chat_messages.redacted_summary` / 计划中的 `summarize-chat-message` Skill **保持独立管线**，不合并、不依赖 | 两者粒度（message vs thread）、消费者（`thread.recall` vs UI 侧栏）与隐私姿态（跨边界脱敏 vs owner-only 展示）均不同；`redacted_summary` 至今未实现，依赖它会阻塞本方案 | 演进方向：若 `redacted_summary` 落地，标题生成应改为读脱敏摘要而非原文，以进一步收缩隐私面。此项为约定，不在本次实施范围 |
| **D6** | 不新增 SSE 事件传播标题变更 | 两条写路径都由 owner 的 HTTP 请求发起，响应体即可携带新标题；`agentStreamEventSchema` 是以 `runId` 为键的 discriminated union，标题变更没有对应的 run | 前端在 mutation 成功后失效 `['trips', tripId, 'my-threads']` |
| **D7** | 标题不进入 audit summary、日志、metric 标签、span attribute | 标题由私有对话派生，属 AGENTS.md 定义的敏感数据的派生物 | audit summary 仅 `{ threadId, source }`；metric 仅有界枚举标签 |
| **D8** | UI 语言切换**不**重新翻译已存在的标题 | 与 `shared_trips.name` + `title_locale` 的既有行为一致；重译需要保留生成时的结构化输入或重新调用 LLM，收益不足 | 记为已知限制（§13） |

### 3.1 与既有边界声明的关系（必须同步修改）

`apps/api/src/routes/trips.ts:494` 的 OpenAPI description 现文为：

> "Set a creator-managed trip title. This never reads chat history or calls an LLM."

该禁令成立的原因是 **trip name 对全体成员可见**——由某成员私有对话派生的标题展示给全员，构成跨信任边界的泄漏。thread title 是 owner-only 的，该理由不适用。

**实施要求：** 在 P0 中把该 description 收窄为明确限定 trip name，并以本文为 thread title 的权威规则。不得让两处规则相互覆盖或含糊。

---

## 4. 技术栈

**不新增任何依赖。** 全部能力由现有栈提供：

| 层 | 组件 |
|---|---|
| API | Fastify + Zod（`apps/api/src/routes/`、`apps/api/src/types/schemas.ts`） |
| 数据 | PostgreSQL + Drizzle（`apps/api/src/db/schema.ts`，手写幂等 SQL migration） |
| LLM | `providers/llm-gateway.ts`（唯一出口）经 `agents/skill-registry.ts` 调用 |
| 可观测 | `observability/metrics.ts`、`services/audit-service.ts`、`observability/telemetry.ts` |
| 前端 | Next.js + TanStack Query + next-intl（`apps/web/src/lib/query/`、`apps/web/messages/`） |

`TECH_STACK.md` 无需修改。

---

## 5. 数据模型

### 5.1 Migration `0069_thread_title_lifecycle.sql`

```sql
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS title_source      varchar(16) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS title_locale      varchar(8),
  ADD COLUMN IF NOT EXISTS title_updated_at  timestamptz;

-- 回填：把三种系统生成的占位标题标记为 AUTO。其余保持 MANUAL——创建流程
-- 从未提供标题输入框，因此这些行只可能来自历史 API 直调。
UPDATE chat_threads
   SET title_source = 'AUTO'
 WHERE title_source = 'MANUAL'
   AND (
     title IN ('Trip Planner', 'Personal trip scratchpad')
     OR title ~ '^新对话 [0-9]+$'
     OR title ~ '^New chat [0-9]+$'
   );

ALTER TABLE chat_threads
  ADD CONSTRAINT chat_threads_title_source_check
  CHECK (title_source IN ('AUTO', 'MANUAL')) NOT VALID;
```

**约束说明：** `NOT VALID` 使既有行不被立即全表校验，避免回填与约束创建之间的锁竞争；新写入仍受检查。部署稳定后由后续 migration `VALIDATE CONSTRAINT`（记为技术债，§14）。

### 5.2 Migration `0070_thread_title_audit_action.sql`

新增 audit action `CHAT_THREAD_TITLE_UPDATE`。**必须独立成文件**：PostgreSQL 不允许在同一事务中添加枚举值后立即使用它。写法照抄 `apps/api/migrations/0066_trip_delete_audit_action.sql` 的 schema-scoped 幂等 `DO` 块。

### 5.3 Drizzle schema 变更

`apps/api/src/db/schema.ts` 的 `chatThreads`（第 684 行起）新增：

```ts
titleSource: varchar("title_source", { length: 16 }).$type<"AUTO" | "MANUAL">().default("MANUAL").notNull(),
titleLocale: varchar("title_locale", { length: 8 }).$type<"en" | "zh" | null>(),
titleUpdatedAt: timestamp("title_updated_at", { withTimezone: true }),
```

同文件 `auditActionEnum`（第 108 行附近）新增 `"CHAT_THREAD_TITLE_UPDATE"`；`apps/api/src/services/audit-service.ts:17` 的联合类型同步。

### 5.4 字段语义

| 字段 | 取值 | 语义 |
|---|---|---|
| `title_source` | `AUTO` \| `MANUAL` | `MANUAL` 为锁：自动路径不得写入该状态的行 |
| `title_locale` | `en` \| `zh` \| `NULL` | AUTO 标题生成时的语言权威；`MANUAL` 时必须为 `NULL` |
| `title_updated_at` | timestamptz \| `NULL` | 最近一次标题写入时间；创建时为 `NULL` |

---

## 6. 系统架构与数据流

### 6.1 写入路径总览

```
路径 1  创建 default thread（确定性）
  POST /explorations/start          ─┐
  POST /trip-invitations/:token/accept ├─→ buildDefaultThreadTitle(locale)
  POST /trips/:tripId/threads/default ─┘     └─→ title_source='AUTO', title_locale=locale

路径 2  创建额外 thread（确定性编号，服务端权威）
  POST /trips/:tripId/threads
      └─→ 事务内 count(active threads) → buildIndexedThreadTitle(n+1, locale)
          └─→ title_source='AUTO', title_locale=locale

路径 3  Owner 手动重命名（锁定）
  PATCH /trips/:tripId/threads/:threadId/title
      └─→ title_source='MANUAL', title_locale=NULL

路径 4  Owner 显式 AI 命名（LLM，可失败）
  POST /trips/:tripId/threads/:threadId/title/suggest
      └─ 限流 → owner 校验 → MANUAL 检查 → 取本 thread 前 3 条 USER 消息
         → invokeSkill('thread.title.suggest') → 服务端后处理
         → 通过：写 title_source='AUTO'；不通过：不写库，applied=false
```

### 6.2 路径 4 时序与失败处理

| # | 组件 | 动作 | 失败行为 |
|---|---|---|---|
| 1 | 前端 | 点击“用 AI 命名”，按钮进入 pending 并禁用 | — |
| 2 | 路由 | 限流检查（每用户 10 次/小时） | 429，标题不变 |
| 3 | 路由 | owner 校验 + 仍为 trip member | 403，标题不变 |
| 4 | 路由 | 读 `title_source`；为 `MANUAL` 且请求未带覆盖确认则拒绝 | 200 `applied=false, reason=MANUAL_LOCKED` |
| 5 | 服务 | 读本 thread 最早 3 条 `role='USER'` 消息，每条截断 512 字符 | 少于 1 条：200 `applied=false, reason=NO_MATERIAL`（不调用 gateway） |
| 6 | Skill | `invokeSkill('thread.title.suggest', …)`，registry 负责超时与 Zod 校验 | 超时/网络/解析失败：200 `applied=false, reason=UNAVAILABLE` |
| 7 | 服务 | 服务端后处理（§9.2） | 任一规则不通过：200 `applied=false, reason=REJECTED` |
| 8 | 服务 | 单事务写 `title` / `title_source='AUTO'` / `title_locale` / `title_updated_at` + audit + metric | 事务回滚，标题不变 |
| 9 | 前端 | 失效 `['trips', tripId, 'my-threads']`，重渲染 rail | — |

**所有失败都是 fail closed：标题保持原值，绝不写入模型产出的中间态。**

---

## 7. 接口设计

### 7.1 新增 `PATCH /trips/:tripId/threads/:threadId/title`

Owner-only。

```
Body:     { "title": "签证准备" }            // trim 后 1..80 字符
Response: 200 ThreadSummary
          403 非 owner 或已失去 trip 成员资格
          404 thread 不存在或不属于该 trip
```

写入 `title_source='MANUAL'`、`title_locale=NULL`、`title_updated_at=now()`；audit `CHAT_THREAD_TITLE_UPDATE`，summary `{ threadId, source: "manual" }`。

**实现要求：** `SELECT … FOR UPDATE` 锁行后再更新，写法对齐 `apps/api/src/routes/trips.ts:513`。

### 7.2 新增 `POST /trips/:tripId/threads/:threadId/title/suggest`

Owner-only，受限流。

```
Body:     { "requestId": "<uuid>",
            "locale": "zh",
            "overwriteManual": false }        // 可选，默认 false

Response: 200 { "thread": ThreadSummary, "applied": true }
          200 { "thread": ThreadSummary,      // 标题未变
                "applied": false,
                "reason": "MANUAL_LOCKED" | "NO_MATERIAL" | "REJECTED" | "UNAVAILABLE" }
          403 非 owner
          404 thread 不存在
          429 超出限流
```

`requestId` 仅用于前端去重与日志关联，**不**创建 `idempotency_records`——标题生成可重复执行且无外部副作用。

### 7.3 修改 `POST /trips/:tripId/threads`

```
Body（现）: { "title": "Hotel ideas" }
Body（新）: { "title"?: string,          // 可选；缺省由服务端编号
              "locale"?: "en" | "zh" }   // 缺省 "en"
```

- `title` 存在 → `title_source='MANUAL'`、`title_locale=NULL`（保留既有直调客户端语义）。
- `title` 缺省 → **在同一事务内、且先取到 advisory lock 之后**，统计该 `(ownerUserId, tripId, archivedAt IS NULL)` 的 thread 数 `n`，写入 `buildIndexedThreadTitle(n + 1, locale)`、`title_source='AUTO'`、`title_locale=locale`。

> **并发正确性（必读）：** 仅仅"在同一事务内 count 再 insert"**不能**保证编号唯一。仓库未设置隔离级别，即 PostgreSQL 默认的 READ COMMITTED——两个并发事务的 `SELECT count(*)` 互相看不见对方未提交的 insert，会得到相同的 `n`。`count(*)` 不加锁。因此事务开头必须先执行
> `SELECT pg_advisory_xact_lock(hashtext(<ownerUserId>), hashtext(<tripId>))`，
> 把同一 (owner, trip) 的并发创建串行化；锁随事务结束自动释放。
> 不采用 `(owner_user_id, trip_id, title)` 唯一索引：那会连带禁止用户把两个 thread 都手动命名为同一个词，把实现约束外溢成产品限制，还需要额外的冲突重试。

### 7.4 修改 `POST /explorations/start`

`explorationStartRequestSchema`（`apps/api/src/types/schemas.ts:1396`）新增：

```ts
locale: z.enum(["en", "zh"]).default("en"),
```

服务端用该值同时决定 draft trip 的 `titleLocale` 与 default thread 的 `title_locale`。**此项同时关闭 [exploration-trip-lifecycle-implementation.md](exploration-trip-lifecycle-implementation.md) 中记录的「已知缺口（尚未修复）」**：该 DTO 此前只有 `requestId`，草稿行名与 thread 标题固定写英文。

### 7.5 修改 `POST /trip-invitations/:inviteToken/accept`

新增可选 body `{ "locale"?: "en" | "zh" }`，缺省 `"en"`，仅用于 default thread 标题语言。不改变邀请校验逻辑与响应形状。

### 7.6 `ThreadSummary` 契约扩展

`apps/api/src/types/schemas.ts:366` 的 `threadSummarySchema` 新增：

```ts
titleSource:    z.enum(["AUTO", "MANUAL"]),
titleLocale:    z.enum(["en", "zh"]).nullable(),
titleUpdatedAt: z.string().datetime().nullable(),
```

前端 `apps/web/src/lib/api/contracts.ts:92` 的 `threadSchema` 同步扩展。

---

## 8. 确定性标题算法

新建 `apps/api/src/services/thread-title-service.ts`。

**不复用 `buildTripTitle`：** trip 标题需要携带目的地与天数以在项目列表中区分不同 trip；thread rail 始终处于已知 trip 上下文内，重复目的地是冗余噪声。

```ts
export type ThreadTitleLocale = "en" | "zh";

/** default thread：每 (owner, trip) 唯一，标题不承担区分职责，只需正确且本地化。 */
export function buildDefaultThreadTitle(locale: ThreadTitleLocale): string;
//   zh → "行程规划"        en → "Trip planning"

/** 额外 thread 的初始标题；index 由服务端在事务内计算。 */
export function buildIndexedThreadTitle(index: number, locale: ThreadTitleLocale): string;
//   zh → "新对话 2"        en → "New chat 2"
```

**设计后果（有意）：** default thread 的标题与 trip brief 无关，因此 **brief 确认或变更时无需重算 thread 标题**。这消除了一整类重算路径及其竞态。

---

## 9. `thread.title.suggest` Skill 契约

### 9.1 注册与形状

新建 `apps/api/src/skills/personal/thread-title-suggest-skill.ts` 与同名 `.md`（`name` / `source-of-truth` / `status: implemented` 三个 front-matter 键是 `verify-docs.ts` 的检查点），并在 `apps/api/src/agents/personal-travel-agent.ts` 注册。

| 属性 | 值 | 说明 |
|---|---|---|
| `name` | `thread.title.suggest` | |
| `agent` | `personal` | |
| `version` | `1.0.0` | |
| `allowedTools` | `[]` | 不需要任何 scope；`DefaultPolicyGate` 的 personal 白名单无需改动 |
| `timeoutMs` | `4000` | 用户在前台等待，比 `trip.constraint.propose` 的 1500ms 宽松；超时即 `UNAVAILABLE` |
| `needsConfirm` | `false` | 触发动作本身即用户确认 |

**输入 schema（`.strict()`）**

```ts
{
  threadId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  messages: z.array(z.object({
    text: z.string().min(1).max(512),   // 服务端截断后传入
  })).min(1).max(3),
}
```

**禁止输入：** Profile、Personal Note、长期记忆、其他 thread 的消息、ASSISTANT 消息、provider offer、constraint snapshot、consent、trip 成员信息。

**输出 schema（`.strict()`）**

```ts
{ title: z.string().min(1).max(40) }
```

语言权威按 [LLM-GATEWAY.md](../apps/api/src/providers/LLM-GATEWAY.md) §User-visible language contract：本调用没有“当前问题”，因此使用服务端校验过的 `locale`。

### 9.2 服务端后处理（不得只信模型）

按顺序执行，任一步失败即 `REJECTED`：

1. Trim、折叠连续空白、移除换行与控制字符。
2. 移除 emoji 与私用区码点。
3. 按字素簇硬截断至 40 字符。
4. **拒绝**匹配 `https?://` 或 `\S+@\S+\.\S+`（URL / 邮箱）。
5. **拒绝**包含连续 6 位及以上数字（疑似证件号、卡号、金额、订单号）。
6. **拒绝**清洗后的标题是任一输入消息的子串或与之相同（防原文回显）。
7. **拒绝**清洗后为空。

### 9.3 限流

复用 `apps/api/src/routes/location-introduction-rate-limit.ts` 的进程内滑动窗口范式，新建 `thread-title-suggest-rate-limit.ts`：**每认证用户每小时 10 次**，超出返回 429。

---

## 10. 前端实施

### 10.1 契约与数据层

| 文件 | 改动 |
|---|---|
| `apps/web/src/lib/api/contracts.ts:92` | `threadSchema` 增三个字段；`createTripThreadInputSchema` 的 `title` 改为可选并增 `locale` |
| `apps/web/src/lib/api/http-travel-api.ts:272` | 新增 `renameThread(tripId, threadId, title)`、`suggestThreadTitle(tripId, threadId, input)`；`createTripThread` 不再要求 `title` |
| `apps/web/src/lib/query/hooks.ts:255` | 新增 `useRenameThread(tripId)`、`useSuggestThreadTitle(tripId)`；两者成功后失效 `queryKeys.threads(tripId)` |
| `apps/web/src/lib/query/keys.ts` | 无改动 |

### 10.2 交互

`apps/web/src/components/trips/trip-workspace.tsx`：

1. **删除**第 163–176 行 `handleCreateThread` 中的客户端标题计算，改为不传 `title`、只传 `locale`（D1）。
2. rail 条目（第 290–316 行）新增 overflow 菜单，含两项：**重命名**、**用 AI 命名**。菜单按钮需有 `aria-label`，不得只以图标区分。
3. **重命名**：行内输入框，提交后乐观更新；失败回滚并复用统一 API 错误展示。
4. **用 AI 命名**：进入 pending 并禁用；成功后由 query 失效驱动重渲染；`applied=false` 时按 `reason` 显示可恢复文案，标题保持原样。
5. `titleSource === 'MANUAL'` 时，菜单需标注 AI 命名会覆盖手动标题，用户确认后请求带 `overwriteManual: true`。

### 10.3 i18n

- **删除**死键：`threads.newThread.placeholder`、`.submit`、`.validation`；服务端接管编号后 `threads.newThread.autoTitle` 亦成死键，一并删除（`en.json` / `zh.json` 同步）。
- **新增**键：`threads.rename.*`、`threads.aiName.*`（label / pending / 四种 reason 文案 / 覆盖确认）。

---

## 11. 可观测性与隐私

### 11.1 Metrics

在 `apps/api/src/observability/metrics.ts` 注册：

```ts
metrics.registerCounter(
  "thread_title_writes_total",
  "Private thread title writes by bounded source and result.",
  {
    source: ["deterministic", "llm", "manual"],
    result: ["applied", "rejected", "unavailable", "no_material", "manual_locked"],
  },
);
```

**禁止**把 `threadId`、`tripId`、`userId`、标题文本作为标签。

### 11.2 Audit

`CHAT_THREAD_TITLE_UPDATE`，summary 严格为 `{ threadId, source: "deterministic" | "llm" | "manual" }`。

**不得包含标题文本。** 标题由私有对话派生，写入 audit 等于把私有对话内容落到审计表，违反 AGENTS.md 对私有对话的处理约束。

### 11.3 Logs / Traces

- `logSafeRuntimeEvent` 只记 `{ component, event, operation, result }`。
- 标题文本不得作为 span attribute。实施时确认是否需要向 `apps/api/src/observability/tracing.ts:51` 的 `FORBIDDEN_SPAN_ATTRIBUTE_KEYS` 补充键名。

### 11.4 传输面

标题只经由 owner 自己的 HTTP 响应返回。**不得**进入：`agentStreamEventSchema`（经 PostgreSQL NOTIFY 广播）、共享方案面、成员列表、邀请预览、任何 `TEAM_VISIBLE` 投影。

---

## 12. 实施阶段

### 12.1 P0 — 生命周期与确定性命名（无 LLM）

| # | 工作项 | 依赖 |
|---|---|---|
| 1 | migration `0069`（三列 + 回填 + CHECK）、`0070`（audit enum）、Drizzle schema 与 audit 联合类型同步 | 无 |
| 2 | `services/thread-title-service.ts`：`buildDefaultThreadTitle` / `buildIndexedThreadTitle` | 1 |
| 3 | `exploration-service.ts:107` 与 `trip-invitation-service.ts` 的 `getOrCreateDefaultThread` 改为调用 §8 函数 | 2 |
| 4 | `POST /explorations/start` 增 `locale`；`POST /trip-invitations/:token/accept` 增可选 `locale` | 3 |
| 5 | `POST /trips/:tripId/threads`：`title` 转可选，服务端事务内编号 | 2 |
| 6 | `PATCH /trips/:tripId/threads/:threadId/title` + audit + metric | 1 |
| 7 | `ThreadSummary` 契约扩展（后端 + 前端） | 1 |
| 8 | 前端：移除客户端标题计算、rail overflow 菜单、重命名交互、清死 i18n 键 | 5,6,7 |
| 9 | 收窄 `apps/api/src/routes/trips.ts:494` 的 description（§3.1） | 无 |
| 10 | 文档与测试场景同步（§15） | 全部 |

**P0 完成判据：** 中文用户在工作台看到的 default thread 标题为「行程规划」而非 `Trip Planner`；可重命名；重命名后 `title_source='MANUAL'`；两个标签页并发创建额外 thread 不产生同名。

### 12.2 P1 — Owner 触发的 LLM 命名

| # | 工作项 | 依赖 |
|---|---|---|
| 1 | `skills/personal/thread-title-suggest-skill.ts` + `.md` + 注册 | P0-1 |
| 2 | 后处理模块（§9.2），独立可单测 | P1-1 |
| 3 | `thread-title-suggest-rate-limit.ts` | 无 |
| 4 | `POST /trips/:tripId/threads/:threadId/title/suggest` | P0-6, P1-1..3 |
| 5 | 前端“用 AI 命名”入口与四种 reason 文案 | P0-8, P1-4 |
| 6 | 测试场景与文档同步 | 全部 |

**P1 完成判据：** owner 在有 ≥1 条 USER 消息的额外 thread 上点击后得到内容相关标题；gateway 不可用、输出被后处理拒绝、`MANUAL` 锁定三种情况下标题均保持原值且返回可读原因。

### 12.3 P2 — 后台自动命名（**本次不实施**）

仅当同时满足以下两条时才立项：

1. `thread_title_writes_total{source="llm", result="applied"}` 与额外 thread 创建数之比 **低于 30%**（说明用户不会主动点按钮）；且
2. 用户反馈或会话数据显示确实存在“找不到目标 thread”的问题。

届时的实现方式：在 `apps/api/src/tasks/handlers/conversation-task-handler.ts` 第 867–905 行区域挂 fire-and-forget 钩子，形态照抄 `extractConversationHandoffBatch`；触发闸门为 `title_source != 'MANUAL'` 且标题仍为系统编号且该 thread USER 消息数 ≥ 2，且**每 thread 仅执行一次**。

---

## 13. 边界条件与失败模式

| 条件 | 期望行为 |
|---|---|
| 未知 threadId，或 threadId 不属于该 tripId | 404，与既有 `requireOwnedTripThreadRead` 的语义一致 |
| threadId 存在于该 trip 但不属于调用者 | 403。两个状态码刻意保持可区分：thread id 是 UUID，猜测成本已足够高，而把「不存在」也回 403 会让 404 失去意义 |
| 调用者已被移出 trip | 403（沿用现有的成员资格失效检查） |
| `title_source='MANUAL'` 且未带 `overwriteManual` | `applied=false, reason=MANUAL_LOCKED`，不调用 gateway |
| `title_source='MANUAL'` 且带 `overwriteManual: true` | 允许覆盖，写 `title_source='AUTO'` |
| thread 无 USER 消息 | `applied=false, reason=NO_MATERIAL`，不调用 gateway，不产生 LLM 成本 |
| LLM 超时 / 网络失败 / 输出不合 schema | `applied=false, reason=UNAVAILABLE`，标题不变 |
| LLM 输出含 URL / 邮箱 / 长数字串 / 原文回显 | `applied=false, reason=REJECTED`，标题不变 |
| 并发创建额外 thread（多标签页） | 事务开头对 `(ownerUserId, tripId)` 取 `pg_advisory_xact_lock` 后再计数插入，两个 thread 得到不同编号 |
| 并发重命名同一 thread | `FOR UPDATE` 行锁串行化，后写入者胜出 |
| 归档 thread | 不参与编号计数（`archived_at IS NULL` 过滤），标题不再变更 |
| 删除 trip | `chat_threads` 随现有删除路径清理，无额外处理 |
| UI 语言切换 | 已存在标题不重译（D8，已知限制） |
| 升级前已存在的历史 thread | 由 §5.1 回填标记为 `AUTO`，可被重命名与 AI 命名覆盖 |

---

## 14. 风险与技术债

| 风险 | 影响 | 缓解 |
|---|---|---|
| 标题经 audit / log / metric 泄漏私有对话内容 | 违反 AGENTS.md 隐私约束 | §11 强制约定；代码评审逐项核对 audit summary 与 metric 标签；测试断言 audit 行不含标题文本 |
| LLM 回显对话原文作为标题 | 私有内容以更醒目形式呈现（虽仍 owner-only），标题质量差 | §9.2 第 6 条后处理规则 + 单测 |
| `NOT VALID` CHECK 约束长期不校验 | 历史脏数据不被发现 | 技术债；部署稳定后补一条 `VALIDATE CONSTRAINT` migration |
| `title_source` 回填依赖字面量匹配 | 其他历史占位文案会被误判为 MANUAL | 影响仅为该 thread 不被自动命名覆盖，用户可手动重命名恢复；不阻塞 |
| 两套“从对话生成短文本”的管线（本方案 + 未实现的 `redacted_summary`） | 未来重复实现 | D5 已约定演进方向 |
| P1 的后处理模块只有一个使用者 | 过早抽象风险 | 不抽公共“gateway + 后处理 + fail closed”外壳，待第二个使用者出现再抽 |
| 限流为进程内实现 | 多实例部署下实际额度为 N × 10/小时 | 与 `location-introduction-rate-limit.ts` 现状一致；MVP 接受，记为技术债 |

---

## 15. 文档与测试同步

本方案落地必须在同一变更中完成：

| 文件 | 改动 |
|---|---|
| `docs/PRD.md` FR-1 | thread 标题的功能需求条目 |
| `docs/backlog.md` | 用户故事与验收条件 |
| `docs/test-scenarios.md` | 新增 `TS-H1b-TITLE` 场景 |
| `docs/trip-scoped-private-threads-implementation.md` | §6.2 与 §8.2 引用本文 |
| `docs/exploration-trip-lifecycle-implementation.md` | 关闭 `titleLocale` 已知缺口，引用本文 |
| `apps/api/API.md` | `ThreadSummary` 字段、两个新端点、`POST /trips/:tripId/threads` body 变更、`POST /explorations/start` 的 `locale` |
| `apps/api/src/routes/trips.ts:494` | 收窄 description 适用范围（§3.1） |

**测试覆盖要求（AGENTS.md 强制）：**

- **后端单测：** `buildDefaultThreadTitle` / `buildIndexedThreadTitle` 的中英输出；§9.2 七条后处理规则各一例。
- **后端集成测：** 非 owner 403；成员资格失效 403；`MANUAL` 锁语义与显式覆盖；并发创建编号不撞；gateway 失败标题不变；audit summary 不含标题文本；metric 标签有界。
- **前端测：** rail 渲染新字段；重命名乐观更新与回滚；`applied=false` 四种 reason 的文案与标题不变。

---

## 16. 模块清单

| 动作 | 模块 |
|---|---|
| **复用（不改）** | `agents/skill-registry.ts`、`agents/policy-gate.ts`、`providers/gateway-factory.ts`、`services/audit-service.ts`、`observability/telemetry.ts`、`web/src/lib/query/keys.ts` |
| **修改** | `db/schema.ts`、`services/audit-service.ts`（类型）、`services/exploration-service.ts`、`services/trip-invitation-service.ts`、`routes/trip-threads.ts`、`routes/explorations.ts`、`routes/trip-invitations.ts`、`routes/trips.ts`（仅 description）、`types/schemas.ts`、`observability/metrics.ts`、`agents/personal-travel-agent.ts`、`web/src/lib/api/contracts.ts`、`web/src/lib/api/http-travel-api.ts`、`web/src/lib/query/hooks.ts`、`web/src/components/trips/trip-workspace.tsx`、`web/messages/{en,zh}.json` |
| **新增** | `migrations/0069_thread_title_lifecycle.sql`、`migrations/0070_thread_title_audit_action.sql`、`services/thread-title-service.ts`、`skills/personal/thread-title-suggest-skill.ts` + `.md`、`routes/thread-title-suggest-rate-limit.ts`、对应后端与前端测试 |
