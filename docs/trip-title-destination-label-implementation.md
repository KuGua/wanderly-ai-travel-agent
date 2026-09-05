# Trip 标题目的地标签实施规范

**状态：** 已批准，待实现
**范围：** `shared_trips.name` 的目的地来源扩展——确定性国家/地区标签、跨国重名城市消歧、owner 显式触发的 LLM 标签建议，以及标题在邀请预览中的脱敏。
**前置文档：** [探索行程生命周期实施规范](exploration-trip-lifecycle-implementation.md)、[Thread 标题生命周期实施规范](thread-title-lifecycle-implementation.md)、[位置参考数据](location-reference-data.md)、[LLM Gateway 契约](../apps/api/src/providers/LLM-GATEWAY.md)

---

## 1. 目标与非目标

### 1.1 目标

1. `shared_trips.name` 在用户只表达了国家/地区级意图时也能产出有信息量的标题，而不是停留在 `行程规划` / `Trip Planner` 占位名。
2. 标题格式由 `buildTripTitle` **单点构造保证**，不依赖任何模型遵守格式约定。
3. 修复跨国重名城市恒不解析的缺陷（`巴黎`、`Paris`、`Athens`、`Milan` 等当前全部无法成为目的地）。
4. 在聊天文本路径上补齐"需要具体城市"的用户可见反馈，当前该提示只在地图选点时触发。
5. Owner 可显式请求由 Personal Agent 推断目的地标签；输出限定为**参考数据可再解析的封闭词表**，失败与被拒时确定性回落且不改写既有标题。
6. 关闭 trip 标题经邀请预览泄漏 DRAFT 探索细节的现存缺口。

### 1.2 非目标

- **不改变 `destinationCandidates` 的 city-only 契约。** 标签是展示字段，永不进入 planner、provider 查询、`constraint_snapshot` 或任何搜索入参。
- 不做 LLM 生成完整标题字符串。模型的输出面限定为一个目的地槽位值。
- 不做后台自动 LLM 命名（升级判据见 §13.4）。
- 不做主题类标签（`极光` / `海岛` 等非地理标签），见 §13.4。
- 不做 UI 语言切换后的既有标题重译（沿用 thread-title D8）。
- 不引入新的运行时依赖、数据存储或第三方服务。

---

## 2. 现状基线

### 2.1 标题合成的唯一实现

`apps/api/src/services/trip-title-service.ts` 的 `buildTripTitle` 拼接 `destinationCandidates` 与天数：

```
{destinations.join(" · ")}{行程规划|Trip Planner}｜{N}{天| Days}
```

`destinationCandidates` 为空且天数为 `null` 时退化为裸占位名。

### 2.2 三个写标题的调用点

| 场景 | 位置 | 门禁 |
|---|---|---|
| 探索页首次发消息创建草稿 | `services/exploration-service.ts:92` | 固定写入空 brief 的占位名 |
| 接受目的地提示卡 | `services/destination-cue-service.ts:194` | `trip.nameSource === "AUTO"` |
| 确认 brief 卡片 / 创建者编辑 | `routes/trips.ts:673` | `trip.nameSource === "AUTO"` |

### 2.3 缺陷与缺口

| # | 现象 | 位置 | 说明 |
|---|---|---|---|
| **B1** | 国家级输入永不进入标题 | `location-reference-resolver.ts:169` | `resolveDestinationReference` 只查 `citiesByName`；`法国` 命中 `countryCodesByName` 但不命中城市索引，返回 `null` |
| **B2** | 跨国重名城市恒不解析 | `location-reference-resolver.ts:176` | 要求匹配集合的 `countryCode` 唯一，`Paris` 跨 CA/FR/US 共 7 条 → 恒 `null`；其下一行的人口降序排序对任何跨国重名都是**死代码** |
| **B3** | 聊天文本路径无城市要求提示 | `tasks/handlers/conversation-task-handler.ts:790` | `DESTINATION_CITY_REQUIRED` 只在 `turnInput.place?.name` 存在时挂载，而 `place` 携带经纬度，仅由地图/地球选点产生 |
| **B4** | 邀请预览经标题泄漏 DRAFT 目的地 | `services/trip-invitation-service.ts:283-291` | 同一返回对象把 `destinationCandidates` / 日期在 DRAFT 时抹空，却原样返回含目的地的 `name`。注释声称"must not see its creator's unconfirmed exploration details"，被相邻行自身破坏 |
| **B5** | gateway 方法声明为可选 | `providers/model-gateway.ts:294` | `decideDestinationCue?()` 为可选。同文件 370 行上方已为 `generateThreadTitle` 写明该模式会导致"功能在所有环境恒返回 UNAVAILABLE 而编译不报错"。当前 `LLMGateway` 实现了它，属潜在回归面 |

### 2.4 既有可复用先例

| 能力 | 位置 |
|---|---|
| LLM 命名四层管线（gateway → skill → 后处理 → 路由） | `docs/thread-title-lifecycle-implementation.md` §9 及其实现 |
| gateway 出口范式（JSON mode / 重试 / span / 安全日志） | `providers/llm-gateway.ts:2308` `generateThreadTitle` |
| Skill 契约（Zod 严格 in/out、超时、`SkillError`） | `skills/personal/thread-title-suggest-skill.ts` |
| fail-closed 纯函数后处理 | `services/thread-title-suggest-postprocess.ts` |
| 路由永不抛业务异常 + `applied/reason` + `FOR UPDATE` 重读 | `routes/trip-threads.ts:415-500` |
| 进程内限流 | `routes/thread-title-suggest-rate-limit.ts` |
| `AUTO`/`MANUAL` 名称来源门禁 | `db/schema.ts:359-361`、`routes/trips.ts:502-541` |
| 有界标签计数器 | `observability/metrics.ts:650` |
| 国家名识别 | `location-reference-resolver.ts:195` `isKnownCountryName` |

---

## 3. 关键技术决策

| ID | 决策 | 理由 | 边界 |
|---|---|---|---|
| **D1** | 标题格式由 `buildTripTitle` 单点合成；模型只提供**目的地槽位值**，不产出标题字符串 | 格式由构造保证而非 prompt 遵守；模型输出面从整句缩到一个短名词，注入与泄漏面同步收缩 | `buildTripTitle` 仍是唯一可写 `shared_trips.name` 的合成函数 |
| **D2** | 新增独立列 `title_destination_label`，不复用 `name` 承载模型结果 | 标题须保持"持久化状态的投影"。若把结果烧进 `name`，后续用户确认真实城市时只能在"覆盖丢失"与"保留过期名"之间二选一；独立列使优先级成为显式规则且重算幂等无损 | 该列为展示专用，见 D3 |
| **D3** | **标签永不进入 planner 语义面**：不写 `destinationCandidates`、不进 `constraint_snapshot`、不作为任何 provider 查询入参 | 沿用 `location-reference-resolver.ts:189-194` 已确立的边界——国家是探索上下文，但无法安全确定城市、机场或供应商查询 | 以列级测试与代码评审共同保证 |
| **D4** | 目的地优先级：`destinationCandidates` > `REFERENCE` 标签 > `LLM` 标签 > 空 | 显式确认的事实优先于推断；参考数据优先于模型 | 优先级在 `buildTripTitle` 的调用方解析，不在 SQL |
| **D5** | LLM 输出限定为**封闭词表**：`{ kind: "COUNTRY" \| "CITY", value }`，且 `value` 必须能被 location-reference 再解析，否则 `REJECTED` | trip name 对全体成员可见。封闭词表使该字段**结构上不可能**承载自由文本私有内容，把泄漏面收缩到"这趟行程关于哪个国家/城市"——而这正是 trip 名称的用途 | 非地理主题标签不在本次范围（§13.4） |
| **D6** | 确定性路径（P0）自动执行；LLM 路径（P1）由 owner 显式触发 | 确定性路径是内存查表，无成本、无延迟、无隐私增量；LLM 路径的显式点击即 owner 对"读取我这段对话"的授权，与仓库既有授权模型一致 | 后台自动 LLM 命名的升级判据见 §13.4 |
| **D7** | LLM 调用**一律在数据库事务之外** | 两个写标题的路径均在 `db.transaction` 内对 trip 行持 `FOR UPDATE`；引入 2–4s 的模型调用会长时间持锁 | P1 为独立端点；未来的自动触发必须是 commit 后 fire-and-forget |
| **D8** | 跨国重名城市采用**人口支配规则**：最高人口匹配项须 ≥ 其它国家最高匹配项的 **5 倍**方可解析，否则维持 `null` | 修复 B2 且不引入错误解析。倍率 5 经真实数据集验证（§6.2） | 索引必须继续包含 `alternateNames`——中文名 `东京`/`巴黎` 仅存在于该列 |
| **D9** | 标签文本不进入 audit summary、日志、metric 标签、span attribute | 标签虽为公共数据集中的规范名，仍是私有对话的派生物；沿用 thread-title D7 | audit summary 仅 `{ source }`；metric 仅有界枚举标签 |
| **D10** | 邀请预览在 `status='DRAFT' AND name_source='AUTO'` 时返回本地化通用名 | 修复 B4。限定 `AUTO` 是因为 `MANUAL` 名由创建者自己敲入且其知晓将发出邀请，属知情选择 | 与 PRD.md 第 15 条对 thread 标题"不得进入邀请预览"的既有立场一致 |

### 3.1 与既有边界声明的关系（必须同步修改）

以下三处现文均声明 trip 标题"永不调用 LLM"，本方案落地时必须同步收窄，不得留下相互矛盾的规则：

| 位置 | 现文要点 | 要求改法 |
|---|---|---|
| `apps/api/src/routes/trips.ts:494` OpenAPI description | "it never reads chat history and never calls an LLM" | 收窄为**限定该端点**（创建者手动改名）永不调用 LLM；标签路径以本文为权威 |
| `apps/api/API.md:389-393` | "it does not read private conversation history or call an LLM" | 同上，并补充标签解析规则与新端点 |
| `docs/thread-title-lifecycle-implementation.md` §3.1 | 以"trip name 对全体成员可见"为由论证 trip 标题禁用 LLM | 改为指向本文 D5 + D10：该顾虑由封闭词表与邀请预览脱敏共同处置，而非靠全面禁用 |

---

## 4. 技术栈

**不新增任何依赖。** `TECH_STACK.md` 无需修改。

| 层 | 组件 |
|---|---|
| API | Fastify + Zod（`routes/`、`types/schemas.ts`） |
| 数据 | PostgreSQL + Drizzle（`db/schema.ts` + 手写幂等 SQL migration） |
| 参考数据 | `data/location-reference/`（GeoNames cities5000 + countries.geojson），进程内索引 |
| LLM | `providers/llm-gateway.ts` 唯一出口，经 `agents/skill-registry.ts` 调用 |
| 可观测 | `observability/metrics.ts`、`services/audit-service.ts`、`observability/telemetry.ts` |
| 前端 | Next.js + TanStack Query + next-intl |

---

## 5. 数据模型

### 5.1 Migration `0072_trip_title_destination_label.sql`

```sql
ALTER TABLE shared_trips
  ADD COLUMN IF NOT EXISTS title_destination_label  varchar(64),
  ADD COLUMN IF NOT EXISTS title_label_source       varchar(16),
  ADD COLUMN IF NOT EXISTS title_label_updated_at   timestamptz;

ALTER TABLE shared_trips
  ADD CONSTRAINT shared_trips_title_label_source_check
  CHECK (
    (title_destination_label IS NULL AND title_label_source IS NULL)
    OR title_label_source IN ('REFERENCE', 'LLM')
  ) NOT VALID;
```

**无回填。** 既有行的两列均为 `NULL`，`buildTripTitle` 对 `NULL` 标签的行为与今天完全一致，因此升级对存量数据零影响。

`NOT VALID` 的取舍与既有 `chat_threads_title_source_check` 一致：避免建约束时的全表锁；部署稳定后补 `VALIDATE CONSTRAINT`（技术债，§14）。

### 5.2 Migration `0073_trip_title_label_audit_action.sql`

按 `0070_thread_title_audit_action.sql` 的既有写法，向 audit action 枚举追加 `TRIP_TITLE_LABEL_UPDATE`。

### 5.3 Drizzle schema 同步

`apps/api/src/db/schema.ts`：

```ts
// sharedTrips
titleDestinationLabel: varchar("title_destination_label", { length: 64 }),
titleLabelSource: varchar("title_label_source", { length: 16 })
  .$type<"REFERENCE" | "LLM" | null>(),
titleLabelUpdatedAt: timestamp("title_label_updated_at", { withTimezone: true }),
```

同时向 `auditAction` 联合类型与 `services/audit-service.ts:20-25` 追加 `TRIP_TITLE_LABEL_UPDATE`。

---

## 6. 核心模块设计

### 6.1 `services/trip-title-service.ts`（修改）

新增一个可选入参，其余签名与行为不变：

```ts
export type TripTitleInput = {
  destinationCandidates: string[];
  /**
   * 展示专用的目的地标签（D2/D3）。仅在 destinationCandidates 为空时参与
   * 合成；永不进入 planner 或 provider 查询。
   */
  titleDestinationLabel?: string | null;
  travelDateStart?: string | null;
  travelDateEnd?: string | null;
  travelDays?: number | null;
  locale: TripTitleLocale;
};
```

合成规则（D4 的落点）：

```ts
const explicit = input.destinationCandidates.map(d => d.trim()).filter(Boolean);
const destinations = explicit.length > 0
  ? explicit.join(" · ")
  : (input.titleDestinationLabel?.trim() ?? "");
```

其后所有分支不变。**标签为空时输出与今天逐字节相同**，这是回归测试的判据。

### 6.2 `location-reference-resolver.ts`（修改）

**(a) 人口支配规则（修复 B2）**

`resolveDestinationReference` 现有的"`countryCode` 不唯一即返回 `null`"改为：

```
若匹配集合跨多个国家：
  top        = 人口最高的匹配项
  bestOther  = 其它国家中人口最高的匹配项
  当 top.population >= 5 * max(bestOther.population, 1) 时解析为 top
  否则返回 null（维持歧义拒绝）
```

倍率 5 由真实数据集验证得出：

| 输入 | 结果 | 说明 |
|---|---|---|
| `paris` / `巴黎` | → FR（2,138,551 vs ZA 71,319） | 修复主用例 |
| `athens` | → GR（664,046 vs US 127,315） | 倍率 10 会误拒 |
| `birmingham` | → GB（1,157,603 vs US 196,357） | 同上 |
| `florence` / `milan` / `vienna` / `london` / `moscow` / `lima` | → IT / IT / AT / GB / RU / PE | 全部正确 |
| `valencia` | `null`（VE 1,619,470 vs ES 824,340） | 真歧义，正确拒绝 |
| `barcelona` / `cambridge` / `toledo` / `santiago` | `null` | 真歧义，正确拒绝 |

> **索引约束：** `citiesByName` 必须继续索引 `alternateNames`。实测中文名 `东京`、`巴黎` **仅**存在于 GeoNames 的 `alternateNames` 列，剔除该列会使全部中文城市输入失效。
>
> **已知数据噪声：** `alternateNames` 存在跨城污染（`venice` 命中 Dayton/US，`manchester` 命中 Richmond/US），这些名字因此维持 `null`。行为保守、不产生错误解析，记为数据债（§14）。

**(b) 国家标签解析（支撑 B1）**

新增方法，与 `isKnownCountryName` 并列：

```ts
/**
 * 把一个国家/地区名解析为规范的双语标签。与 resolveDestinationReference
 * 严格分离：国家是标题与探索上下文，永远不是 planner 目的地。
 */
resolveCountryLabel(value: string): {
  countryCode: string;
  nameEn: string;
  nameZh: string;
} | null
```

实现：在构造函数已有的国家遍历中，额外建立 `countryCode → { NAME_EN, NAME_ZH }` 映射（两个字段在 `countries.geojson` 中已存在，见 `properties` 键集）。

### 6.3 `services/trip-title-destination-label.ts`（新增，纯函数）

P0 的确定性解析器，无 IO、无数据库，可单测：

```ts
export type TitleDestinationLabel = {
  label: string;
  source: "REFERENCE";
};

/**
 * 把一段用户输入解析为展示用目的地标签。仅当输入解析为国家/地区、
 * 且**不是**一个可解析的城市时返回标签——城市走 destinationCandidates
 * 的既有路径，不需要标签。
 */
export function resolveTitleDestinationLabel(params: {
  candidate: string;
  locale: "en" | "zh";
}): TitleDestinationLabel | null;
```

判定顺序：

1. `resolveDestinationReference(candidate)` 命中 → 返回 `null`（这是城市，交给既有路径）。
2. `resolveCountryLabel(candidate)` 命中 → 按 `locale` 返回 `nameZh` / `nameEn`。
3. 其余 → `null`。

### 6.4 `services/trip-title-label-service.ts`（新增）

标签的唯一持久化入口，自带短事务：

```ts
export async function applyTitleDestinationLabel(params: {
  ctx: RequestContext;
  tripId: string;
  label: string;
  source: "REFERENCE" | "LLM";
  locale: "en" | "zh";
}): Promise<{ applied: boolean; reason?: "MANUAL_LOCKED" | "NOT_DRAFT" | "UNCHANGED" | "SUPERSEDED" }>;
```

事务内步骤：

1. `SELECT ... FOR UPDATE` 读 trip 行。
2. `status !== 'DRAFT'` → `NOT_DRAFT`，不写。
3. `nameSource !== 'AUTO'` → `MANUAL_LOCKED`，不写。
4. `destinationCandidates.length > 0` → `SUPERSEDED`，不写（D4：显式目的地已胜出）。
5. 现有 `titleLabelSource === 'REFERENCE'` 且入参 `source === 'LLM'` → `SUPERSEDED`，不写（D4）。
6. 标签与现值相同 → `UNCHANGED`，不写。
7. 写 `titleDestinationLabel` / `titleLabelSource` / `titleLabelUpdatedAt`，并用 `buildTripTitle` 重算 `name`，写 `titleLocale`。
8. `recordAudit({ action: "TRIP_TITLE_LABEL_UPDATE", summary: { source } })` — **不含标签文本**（D9）。
9. `metrics.inc("trip_title_writes_total", { source, result })`。

> 既有的两个写标题点（`destination-cue-service.ts:194`、`routes/trips.ts:673`）在真实目的地落地时**必须同时把 `titleDestinationLabel` 置 `NULL`**，否则标签会在 `destinationCandidates` 被清空时意外复活。这是 D4 的对偶写入。

---

## 7. P0：确定性标签与消歧

### 7.1 触发点

唯一写入触发在对话任务处理器，覆盖聊天文本与地图选点两条来源：

`apps/api/src/tasks/handlers/conversation-task-handler.ts`，紧邻现有 `tripBriefProposal` 构造（第 866–879 行区域）之后、且在任何数据库事务之外：

```ts
// 目的地标签是展示字段，与 withoutDestination() 剥离 destinationCandidates
// 的 planner 契约并行、互不干扰（D3）。
const labelCandidate = turnInput.place?.name
  ?? proposeTripBriefFromTurn(turnInput.question)?.destinationCandidates?.[0];
```

解析出标签后调用 `applyTitleDestinationLabel({ source: "REFERENCE", ... })`。

**不改动 `withoutDestination()`。** 它剥离 `destinationCandidates` 是 planner 契约的一部分，与标签无关。

### 7.2 城市要求提示扩展（修复 B3）

`conversation-task-handler.ts:790` 的挂载条件由只看 `place` 扩展为：

```ts
...(isBriefDestinationCountry(turnInput.place?.name)
    || isBriefDestinationCountry(chatExtractedCandidate)
  ? ["DESTINATION_CITY_REQUIRED" as const] : []),
```

`ConversationResponseConstraint` 联合类型与 `llm-gateway.ts:613` 的既有提示词条目均无需改动。

### 7.3 前端：目的地待确认提示

标题显示地名而 `destinationCandidates` 为空时，用户会误以为 brief 已完整。Trip 列表卡片与工作台 header 必须在 `status === 'DRAFT' && destinationCandidates.length === 0` 时渲染"目的地待确认"标记。

该判定**不需要新增 API 字段**：`GET /trips` 与 `GET /trips/:tripId` 已返回 `status` 与 `destinationCandidates`。

新增 i18n 键 `trips.destinationPending`（`en` / `zh` 两侧）。

---

## 8. P1：LLM 标签建议

### 8.1 Gateway 方法（`providers/model-gateway.ts` + `llm-gateway.ts`）

```ts
/**
 * 必需方法，不得声明为可选。见本文 §2.3 B5 与本文件 generateThreadTitle
 * 上方关于可选方法导致功能静默恒失效的说明。
 */
generateTripDestinationLabel(params: {
  locale: "en" | "zh";
  messages: ReadonlyArray<{ text: string }>;
  signal?: AbortSignal;
  ctx?: RequestContext;
}): Promise<{ kind: "COUNTRY" | "CITY"; value: string }>;
```

实现照抄 `generateThreadTitle`（`llm-gateway.ts:2308`）的结构：JSON mode、`maxRetries` 重试、`llm.openai.parse` span、`logSafeRuntimeEvent` 安全日志、失败抛 `ModelGatewayError`。`llm.method` 取 `trip.destination.label`。

输出 Zod：`z.object({ kind: z.enum(["COUNTRY","CITY"]), value: z.string().min(1).max(64) })`。

系统提示要点（语言权威按 LLM-GATEWAY.md §User-visible language contract，本调用无"当前问题"，以服务端 `locale` 为准）：

- 从旅行者自己的消息中判断这趟行程指向哪个**国家或城市**。
- 只返回该地点的**通用名称**，不要返回短语、句子或描述。
- 无法确定单一地点时返回 `{"kind":"COUNTRY","value":""}`（由后处理拒绝）。

### 8.2 Skill `skills/personal/trip-destination-label-suggest-skill.ts`（新增）

同名 `.md` 需带 `name` / `source-of-truth` / `status` 三个 front-matter 键（`verify-docs.ts` 检查点），并在 `agents/personal-travel-agent.ts` 注册。

| 属性 | 值 |
|---|---|
| `name` | `trip.destination.label.suggest` |
| `agent` | `personal` |
| `version` | `1.0.0` |
| `allowedTools` | `[]` |
| `timeoutMs` | `4000` |
| `needsConfirm` | `false` |

输入 schema（`.strict()`），与 thread-title 完全同构：

```ts
{
  tripId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  messages: z.array(z.object({ text: z.string().min(1).max(512) })).min(1).max(3),
}
```

**禁止输入：** Profile、Personal Note、长期记忆、其他 thread 的消息、ASSISTANT 消息、provider offer、`constraint_snapshot`、consent、成员信息。

### 8.3 后处理（`services/trip-destination-label-postprocess.ts`，新增）

D5 的落点。与 thread-title 的自由文本清洗不同，此处是**再解析或拒绝**，规则更短也更强：

1. `normalize("NFKC")`、折叠空白、去控制字符与 emoji、trim。
2. 空 → `REJECTED`。
3. 长度 > 64 → `REJECTED`（不截断：截断后的地名不再是地名）。
4. `kind === "CITY"` → 必须能被 `resolveDestinationReference` 解析，否则 `REJECTED`；返回其**规范城市名**。
5. `kind === "COUNTRY"` → 必须能被 `resolveCountryLabel` 解析，否则 `REJECTED`；返回按 `locale` 的规范国家名。
6. 输出恒为参考数据集中的规范名，**不可能**是模型自由文本。
7. **写入的必须是后处理返回的规范名，而不是模型原始输出。** 后处理同时承担校验与规范化两件事：`kind="CITY"` 时返回 resolver 给出的规范城市名（`tokyo` → `Tokyo`），`kind="COUNTRY"` 时返回按 `locale` 选出的规范国家名（zh + `France` → `法国`）。因此承载它的外壳必须能把清洗结果回传给调用方；任何只能回答"接受/拒绝"的外壳签名都会迫使调用方退回使用原始输出，规范化在存储层失效（见 §17-1）。

因此 thread-title 后处理中的 URL / 邮箱 / 长数字串 / 原文回显四条规则在此**无需重复实现**——封闭词表已使这些形态无法通过第 4/5 步。

> **共用外壳的抽象时机已到。** `docs/thread-title-lifecycle-implementation.md` §14 记有："不抽公共『gateway + 后处理 + fail closed』外壳，**待第二个使用者出现再抽**"。本 skill 即第二个使用者，该文档已预授权此次抽象。在 P1 中抽出 `services/llm-suggest-envelope.ts`，承载"调用 skill → 后处理 → 映射错误为有界 reason"这条骨架；`FOR UPDATE` 重读重判与写入 + audit + metric 留在各路由，因为两个调用方的形状不同。
>
> 该外壳必须以 `<TRaw, TClean>` 两个类型参数声明，`postprocess` 回传 `{ ok: true; value: TClean }`，外壳只返回 `TClean`，原始输出不得离开外壳。
>
> **thread-title 路由的迁移尚未进行**，因此该外壳目前只有一个调用方——这正是 thread-title 文档 §14 所警告的过早抽象。迁移前它不算兑现，记为技术债（§14）。

### 8.4 限流

新增 `routes/trip-destination-label-rate-limit.ts`，逐字复用 `ThreadTitleSuggestRateLimiter` 的形态（进程内、`randomBytes(32)` salt 哈希 userId、滑动窗口）。默认 `10 次 / 小时 / 用户`，可经 `TRIP_DESTINATION_LABEL_RATE_LIMIT` 与 `TRIP_DESTINATION_LABEL_RATE_WINDOW_MS` 覆盖。

**须同步更新 `.env.example`**（AGENTS.md 强制）。

---

## 9. 接口设计

### 9.1 `POST /api/v1/trips/:tripId/title/suggest`（新增）

仅创建者可调用。业务失败一律 `200` + `applied:false` + 有界 `reason`，不向框架抛异常（沿用 `trip-threads.ts` 的既有姿态）。

**Request**

```json
{ "locale": "zh" }
```

**Response 200**

```json
{
  "trip": { "id": "uuid", "name": "法国行程规划", "nameSource": "AUTO" },
  "applied": true
}
```

**失败形态**

```json
{ "trip": { ... }, "applied": false, "reason": "UNAVAILABLE" }
```

| `reason` | 触发条件 | 是否调用模型 |
|---|---|---|
| `NOT_DRAFT` | trip 不在 `DRAFT` | 否 |
| `MANUAL_LOCKED` | `nameSource === 'MANUAL'` | 否 |
| `SUPERSEDED` | 已有 `destinationCandidates` 或已有 `REFERENCE` 标签 | 否 |
| `NO_MATERIAL` | 该 trip 的 owner 私有 thread 无 USER 消息 | 否 |
| `RATE_LIMITED` | 超出每用户配额 | 否 |
| `UNAVAILABLE` | gateway 超时 / 失败 / 输出不合 schema | 是 |
| `REJECTED` | 后处理无法把输出再解析为规范地名 | 是 |

**Errors**：`403`（非创建者）、`404`（trip 不存在）。二者刻意保持可区分，沿用 `trip-threads.ts` 既有语义。

### 9.2 `GET /trip-invitations/:token`（修改，修复 B4）

`services/trip-invitation-service.ts` 的 `getInvitationPreview` 返回体改为：

```ts
name: (trip.status === "DRAFT" && trip.nameSource === "AUTO")
  ? buildTripTitle({ destinationCandidates: [], locale: previewLocale })
  : trip.name,
```

语言由调用方显式传入，服务端不猜：`GET /trip-invitations/:inviteToken` 接受 `?locale=en|zh`，缺省 `"en"`（与 `acceptInvitationRequestSchema` 及既有 `titleLocale` 权威规则一致）。该查询 schema **不使用 `.strict()`** 且以 `safeParse` 解析——一个无关的查询参数绝不能把有效邀请变成 400。需为该 select 补上 `nameSource` 列。前端 `useInvitationPreview` 须把 locale 一并放进 query key，否则切换语言会命中上一语言的缓存。

### 9.3 契约文件同步

- `apps/api/src/types/schemas.ts`：新增 `suggestTripTitleRequestSchema` / `suggestTripTitleResponseSchema`（`reason` 为 `.strict()` 的有界枚举）。
- `apps/api/API.md`：新增本端点；改写 `:389-393` 的"never calls an LLM"表述；在"Draft brief destination validation"小节补充国家输入现在会产出展示标签但**不会**成为目的地。

---

## 10. 可观测性

### 10.1 Metrics

按 `observability/metrics.ts:650` 的既有写法注册：

```ts
metrics.registerCounter(
  "trip_title_writes_total",
  "Trip title destination-label writes by bounded source and result.",
  {
    source: ["reference", "llm", "manual"],
    result: ["applied", "rejected", "unavailable", "no_material",
             "manual_locked", "not_draft", "superseded", "rate_limited"],
  },
);
```

**标签必须是有界枚举。** `tripId` / `userId` / 标签文本一律禁止作为 metric 标签，只能出现在 trace / log 上下文（AGENTS.md 可观测性条款 + D9）。

**每个 reason 必须映射到自己的 `result` 值，不得折叠。** `rejected` 与 `unavailable` 尤其如此：持续的 `rejected` 指向 prompt 或模型回归，`unavailable` 指向 gateway 健康度；把它们并入 `superseded` 会让这两个值恒为零，同时污染"真实目的地胜出"的语义。§13.4 的 P2 立项判据依赖这些计数，折叠会让判据失效。

### 10.2 Logs / Traces

- gateway 层沿用 `logSafeRuntimeEvent`：`component: "llm"`, `operation: "trip.destination.label"`, `outcome`, `errorCode`, `latencyMs`。
- 路由层在 skill 失败与后处理拒绝两处各记一条，携带具体 `errorCode`（否则运维无法区分 TIMEOUT / 5xx / 输出不合法）。
- **标签文本与消息正文永不写入日志。**
- span 沿用 `llm.openai.parse` + `annotateLlmSpan`。

### 10.3 Audit

`TRIP_TITLE_LABEL_UPDATE`，summary 仅 `{ source: "reference" | "llm" }`。既有 `TRIP_TITLE_UPDATE`（手动改名）不变。

---

## 11. 前端改动

| # | 位置 | 改动 |
|---|---|---|
| 1 | Trip 列表卡片 / 工作台 header | `status==='DRAFT' && destinationCandidates.length===0` 时渲染"目的地待确认"标记（§7.3） |
| 2 | 工作台标题区 | 新增"用 AI 命名"入口，仅创建者且 `nameSource==='AUTO'` 时可见 |
| 3 | 同上 | 七种 `reason` 的文案；`applied:false` 时标题保持原值，不做乐观更新 |
| 4 | `apps/web/messages/{en,zh}.json` | `trips.destinationPending`、`trips.titleSuggest.*`（含七个 reason） |
| 5 | TanStack Query | mutation 成功后失效 `['trips']` 与 `['trips', tripId]`；**不新增 SSE 事件**（沿用 thread-title D6：写路径由 owner 的 HTTP 请求发起，响应体即可携带新标题） |

---

## 12. 实施阶段与依赖

### 12.1 P0 — 确定性标签与消歧（无 LLM）

| # | 工作项 | 依赖 |
|---|---|---|
| 1 | migration `0072`、`0073`；Drizzle schema 与 audit 联合类型同步 | 无 |
| 2 | `location-reference-resolver.ts`：人口支配规则（§6.2a）+ `resolveCountryLabel`（§6.2b） | 无 |
| 3 | `trip-title-service.ts`：`titleDestinationLabel` 入参（§6.1） | 无 |
| 4 | `services/trip-title-destination-label.ts` 纯函数解析器 | 2 |
| 5 | `services/trip-title-label-service.ts` 持久化入口 | 1,3,4 |
| 6 | `conversation-task-handler.ts` 触发点接入（§7.1） | 5 |
| 7 | 两个既有写标题点在真实目的地落地时清空标签（§6.4 对偶写入） | 1 |
| 8 | `DESTINATION_CITY_REQUIRED` 扩展到聊天文本（§7.2） | 无 |
| 9 | 邀请预览脱敏（§9.2） | 无 |
| 10 | 收窄三处"never calls an LLM"声明（§3.1） | 无 |
| 11 | 前端"目的地待确认"标记 + i18n | 无 |
| 12 | 文档与测试场景同步（§15） | 全部 |

**P0 完成判据**

1. 中文用户说"我想去法国" → 标题变为 `法国行程规划`，且 `destinationCandidates` 保持 `[]`。
2. 同一会话中界面明确提示需要选择具体城市。
3. `巴黎` / `Paris` / `Athens` / `Milan` 可作为目的地解析成功；`Valencia` / `Barcelona` 维持 `422 DESTINATION_UNRESOLVED`。
4. 用户随后确认 `巴黎` → 标题变为 `巴黎行程规划`，标签被清空。
5. 非成员通过邀请链接预览一个 DRAFT trip，看不到任何目的地信息。

> 第 3 项直接修复本方案调查阶段发现的 `2026-09-05` 两次 `422 DESTINATION_UNRESOLVED`（`api-2026-09-05.ndjson`，`trips.ts:643`）。

### 12.2 P1 — LLM 标签建议（显式触发）

| # | 工作项 | 依赖 |
|---|---|---|
| 1 | `generateTripDestinationLabel` gateway 方法（**必需，不加 `?`**） | P0 全部 |
| 2 | 顺带修复 B5：`decideDestinationCue` 改为必需 | 无 |
| 3 | Skill + `.md` + 注册 | 1 |
| 4 | 后处理模块（§8.3） | P0-2 |
| 5 | 抽出 `services/llm-suggest-envelope.ts` 公共外壳，thread-title 路由改为复用 | 3,4 |
| 6 | 限流器 + `.env.example` | 无 |
| 7 | `POST /trips/:tripId/title/suggest` | 3,4,5,6 |
| 8 | 前端入口与七种 reason 文案 | 7 |
| 9 | 文档与测试场景同步 | 全部 |

**P1 完成判据：** owner 在一个 `destinationCandidates` 为空、确定性路径未命中的 DRAFT trip 上点击后得到规范地名标题；gateway 不可用、后处理拒绝、`MANUAL` 锁定、超限四种情况下标题均保持原值并返回可读原因。

### 12.3 依赖关系

```
P0-1 ─┬─ P0-3 ─┬─ P0-5 ── P0-6
      │        │
P0-2 ─┴─ P0-4 ─┘         P0-7
P0-8   P0-9   P0-10   P0-11        （四项彼此独立，可并行）
                    ↓
P1-1 ── P1-3 ─┬─ P1-5 ── P1-7 ── P1-8
P0-2 ── P1-4 ─┘
P1-2   P1-6                        （独立）
```

P0 的 8/9/10/11 与 1–7 无依赖，可由不同人并行认领。

---

## 13. 边界条件与失败模式

| 条件 | 期望行为 |
|---|---|
| trip 不属于调用者 | `403`；trip 不存在 `404`。两码刻意可区分 |
| `nameSource='MANUAL'` | `applied=false, reason=MANUAL_LOCKED`，不调用 gateway |
| trip 已离开 `DRAFT` | `applied=false, reason=NOT_DRAFT`，不调用 gateway |
| 已有 `destinationCandidates` | `applied=false, reason=SUPERSEDED`（D4） |
| 已有 `REFERENCE` 标签而请求 `LLM` | `SUPERSEDED`，参考数据优先（D4） |
| owner 私有 thread 无 USER 消息 | `NO_MATERIAL`，不产生 LLM 成本 |
| LLM 超时 / 网络失败 / 输出不合 schema | `UNAVAILABLE`，标签与标题均不变 |
| LLM 返回无法再解析的地名或自由文本 | `REJECTED`，标签与标题均不变（D5） |
| 模型调用期间用户手动改名 | 事务内 `FOR UPDATE` 重读重判，走 `MANUAL_LOCKED` 出口，不覆盖用户输入 |
| 模型调用期间用户确认了真实目的地 | 同上重判，走 `SUPERSEDED` 出口 |
| 用户先说"法国"后确认"巴黎" | 标题变 `巴黎行程规划`，标签清空（§6.4 对偶写入） |
| 用户清空 `destinationCandidates` | 标签已被清空，标题回落至裸占位名；不复活旧标签 |
| 跨国重名且人口接近（Valencia / Barcelona） | 维持 `null` + `422 DESTINATION_UNRESOLVED`，不猜测（D8） |
| `alternateNames` 跨城污染（venice / manchester） | 维持 `null`，保守拒绝优于错误解析 |
| 参考数据集加载失败 | 沿用既有姿态：allow-list 不是可用性依赖，标签解析返回 `null`，对话不受影响 |
| UI 语言切换 | 既有标题不重译，沿用 thread-title D8，记为已知限制 |
| 升级前的存量 trip | 两列为 `NULL`，行为与今天逐字节一致 |

### 13.4 明确延后的能力

| 能力 | 立项判据 |
|---|---|
| 后台自动 LLM 命名 | `trip_title_writes_total{source="llm",result="applied"}` 与"确定性未命中的 DRAFT trip 数"之比低于 30%，且有用户反馈表明命名缺失造成困扰。届时形态：commit 后 fire-and-forget，门禁为 `nameSource='AUTO'` 且标签为空且该 trip USER 消息 ≥2 且**每 trip 只执行一次**（D7：绝不在事务内） |
| 非地理主题标签（`极光` / `海岛`） | 需先建立服务端所有的封闭主题词表与双语映射。在此之前 `kind` 仅 `COUNTRY` / `CITY`，以维持"输出必经参考数据再解析"这一强保证（D5） |

---

## 14. 风险与技术债

| 风险 | 影响 | 缓解 |
|---|---|---|
| 标题显示地名但 brief 无目的地，用户误判可以开始规划 | 激活时才发现走不下去 | §7.3 的"目的地待确认"标记是 P0 **硬性前置**，不可降级为后续优化 |
| 标签经 audit / log / metric 泄漏私有对话 | 违反 AGENTS.md 隐私约束 | D9；代码评审逐项核对；测试断言 audit 行与 metric 标签不含标签文本 |
| 人口支配规则误解析小众地名 | 用户得到错误目的地 | 倍率 5 已用真实数据验证（§6.2）；新增倍率边界用例的单测；保守方向恒为 `null` |
| `alternateNames` 跨城污染 | 少数城市名恒不可解析 | 数据债。需要上游数据清洗或人工别名覆盖表，不在本次范围 |
| `NOT VALID` CHECK 长期不校验 | 脏数据不被发现 | 技术债，部署稳定后补 `VALIDATE CONSTRAINT` migration |
| 进程内限流在多实例下实际额度为 N × 10/小时 | 成本超预期 | 与 `location-introduction-rate-limit.ts` / `thread-title-suggest-rate-limit.ts` 现状一致，MVP 接受，记为技术债 |
| 公共外壳抽象引入回归 | thread-title 既有功能受影响 | P1-5 必须在 thread-title 既有测试全绿的前提下合入；外壳只搬骨架，不改任何 reason 语义 |
| 邀请预览脱敏降低受邀者判断力 | 受邀者不知道要加入什么 | 已知取舍。若产品反馈强烈，退化方案为"仅在 `title_label_source IS NOT NULL` 时脱敏"，但这会保留 B4 的存量泄漏，需产品显式接受 |

---

## 15. 文档与测试同步

本方案落地必须在同一变更中完成：

| 文件 | 改动 |
|---|---|
| `docs/PRD.md` | 新增 trip 标题目的地标签的功能需求条目，并明确标签不进入 planner 与邀请预览 |
| `docs/backlog.md` | 新增用户故事与验收条件 |
| `docs/test-scenarios.md` | 改写 `TS-EXPLORE-TRIP-2`（现文断言"never calls an LLM"与确定性标题）；新增 `TS-EXPLORE-TRIP-2b` |
| `docs/exploration-trip-lifecycle-implementation.md` | §4.2.0 引用本文；关闭已过期的 `locale` 缺口标注 |
| `docs/thread-title-lifecycle-implementation.md` | §3.1 改为指向本文 D5 + D10 |
| `docs/location-reference-data.md` | 记录人口支配规则与 `alternateNames` 数据债 |
| `apps/api/API.md` | 新端点；改写 `:389-393`；补充国家输入的标签行为 |
| `apps/api/src/routes/trips.ts:494` | 收窄 description 适用范围 |
| `.env.example` | 两个限流环境变量 |

**测试覆盖要求（AGENTS.md 强制）**

- **后端单测：** `buildTripTitle` 标签为空时输出与今天逐字节相同；标签参与合成；D4 优先级四种组合。`resolveTitleDestinationLabel` 的国家命中 / 城市让路 / 无命中。人口支配规则的倍率边界（`paris`→FR、`athens`→GR、`valencia`→null、`barcelona`→null）。后处理五条规则各一例。
- **后端集成测：** 非创建者 `403`；七种 `reason` 各一例；模型调用期间并发手动改名走 `MANUAL_LOCKED`；并发确认目的地走 `SUPERSEDED`；标签在真实目的地落地时被清空；audit summary 不含标签文本；metric 标签有界；邀请预览对 DRAFT + AUTO 返回通用名。
- **前端测：** "目的地待确认"标记的渲染条件；七种 `reason` 的文案与标题不变；mutation 失败不做乐观更新。

---

## 16. 模块清单

| 动作 | 模块 |
|---|---|
| **复用（不改）** | `agents/skill-registry.ts`、`providers/gateway-factory.ts`、`observability/metrics.ts`、`services/audit-service.ts` 写入范式、`ThreadTitleSuggestRateLimiter` 形态、`DefaultPolicyGate`、`withoutDestination()` 的 planner 契约 |
| **修改** | `services/trip-title-service.ts`、`location-reference/location-reference-resolver.ts`、`services/destination-cue-service.ts:194`、`routes/trips.ts:673` 与 `:494`、`services/trip-invitation-service.ts:270-293`、`tasks/handlers/conversation-task-handler.ts:790` 与 866–879 区域、`providers/model-gateway.ts:294`、`db/schema.ts`、`types/schemas.ts`、`apps/web` 列表卡片与工作台 header、`messages/{en,zh}.json` |
| **新增** | migration `0072` / `0073`、`services/trip-title-destination-label.ts`、`services/trip-title-label-service.ts`、`services/trip-destination-label-postprocess.ts`、`services/llm-suggest-envelope.ts`、`skills/personal/trip-destination-label-suggest-skill.ts` + `.md`、`routes/trip-destination-label-rate-limit.ts`、`POST /trips/:tripId/title/suggest` |

---

## 17. 落地校正（2026-09-05）

首轮实现（`3a0195c`）落地后的代码核对发现三处偏差，均已修复。记录于此，因为其中两处的根因是本规范表述不够紧，规范正文已同步收紧。

### 17-1 外壳丢弃后处理结果（数据正确性）

`llm-suggest-envelope.ts` 的 `postprocess` 回调原签名为 `(o: TOutput) => { ok: true } | { ok: false }`，
**结构上无法回传清洗值**，外壳因此只能 `return { ok: true, output: raw }`，路由随后持久化了模型原始输出。
后果：zh 调用方在模型返回 `France` 时落库 `France` 而非 `法国`；`tokyo` 落库为 `tokyo`。

后处理的规范化能力本身有单测覆盖并通过，缺的是路由层的集成测试——这正是它被漏掉的原因。

**修复：** 外壳改为 `<TRaw, TClean>` 双类型参数，`postprocess` 回传 `{ ok: true; value: TClean }`，
原始输出不再离开外壳。规范 §8.3 增加第 7 条。

### 17-2 确定性路径缺 fail-soft

`resolveTitleDestinationLabel` 的 doc 声明"does not throw on missing datasets"，但函数体没有 `try/catch`，
而 `getLocationReferenceResolver()` 以 `readFileSync` 读四个数据文件、会抛。
调用点 `conversation-task-handler.ts` 的 `.catch()` 只覆盖异步的 `applyTitleDestinationLabel`，
同步的解析调用在其外——数据集不可读时整个对话轮次失败。

违反 §13"参考数据集加载失败 → 返回 `null`，对话不受影响"，也偏离既有写法
`trip-brief-proposal-service.ts` 的 `resolveBriefDestination`。

**修复：** 函数体整体包 `try/catch` 返回 `null`。LLM 路径不受影响——外壳的 `try` 已覆盖后处理。

### 17-3 邀请预览语言硬编码

`previewLocaleForTrip()` 恒返回 `"en"`，中文受邀者看到 `Trip Planner`。
脱敏逻辑本身正确，缺的是语言。**修复：** 见 §9.2，改为 `?locale=` 查询参数贯通到前端。

### 17-4 同批附带修复

- `reasonToMetricResult` 曾把 `REJECTED` / `UNAVAILABLE` 折叠为 `superseded`，使两个已注册的 metric 值恒为零。改为各自映射（§10.1）。
- 删除 `trip-title-label-service.ts` 的未使用 `Tx` 类型别名与 `trip-destination-label-postprocess.test.ts` 中未被使用的 synthetic resolver 构造块（两者均使 `npm run lint` 报错）。

### 17-5 本次未处理，需单独决策

| 项 | 说明 |
|---|---|
| thread-title 迁移到共用外壳 | 规范 P1-5 要求，实际未做，外壳目前只有一个调用方（§8.3 注） |
| `POST /trip-invitations/:token/accept` 不发送 `locale` | `http-travel-api.ts` 调用时不带 body，服务端恒取默认 `"en"`，被邀请者的 default thread 标题始终是英文。与 17-3 同类，但属既有缺陷，未在本批修复 |
| `UNCHANGED` → metric `superseded` | 需新增注册枚举值才能分开，会扩大改动面 |
| P1-8 前端"用 AI 命名"入口 | 属批 3；`POST /trips/:tripId/title/suggest` 目前无 UI 触发点 |

