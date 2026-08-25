# Wanderly 前端原型开发交接

**状态：** 前端实施交接稿  
**基线：** 2026-08-24  
**受众：** Next.js / React 前端开发者、API 开发者、测试人员  
**范围：** 登录后的探索首页与“我的项目”页；不改变现有授权、方案版本、确认与预订沙箱的服务端权威边界。

## 1. 交接目标与参考原型

本交接将两个独立 HTML 原型收敛为同一产品体验：

| 目标页面 | 原型 | 产品目的 | 生产路由建议 |
|---|---|---|---|
| AI 探索首页 | [`assets/explore-map-prototype.html`](../assets/explore-map-prototype.html) | 从地图产生旅行灵感，再进入受控规划 | `/home` |
| 我的项目 | [`assets/projects-prototype.html`](../assets/projects-prototype.html) | 继续待办规划、回看完成项目和历史版本 | `/projects` |

原型是视觉和交互参考，**不是 API 契约，也不是可直接复制进生产的实现**。生产页面必须使用 Fastify API 返回的服务端状态；不得以原型 fixture 或本地 UI state 伪造行程、授权、计划、价格、签证或预订事实。

产品用语中可将 `shared_trip` 展示为“项目”；数据库、API 和业务不变量仍沿用 `trip` / `plan version`，不得另建第二套“项目”权威模型。

## 2. 不可违反的业务与数据边界

1. **地图不是全球目的地搜索或实时 OTA。** 地图可展示真实地理底图和固定候选/私有灵感标记；任意坐标点击只能保存私有灵感或请求后续加入候选，不能生成真实价格、库存、签证结论或预订结论。
2. **Fixture-first。** 地点、推荐、航班、住宿、地面交通和 readiness 的展示均需要 `source` + `captured_at`，或清晰的 `Demo data` 标签。
3. **权限优先于个性化。** 不显示、不推断、不在推荐文案中泄露其他成员未授权的 Profile、国籍、证件或私有对话。
4. **服务端是权威。** `constraint_snapshot`、plan version、`STALE`、确认与 booking eligibility 仅以 API 返回为准；前端不得自行把状态改成“已确认”“可预订”或“已过期”。
5. **历史不等于当前可用。** 过往项目为只读档案；必须显示其历史版本/时间，不能暗示历史价格、库存或 readiness 仍然有效。
6. **无真实支付或预订。** 所有 action 只可通向既有的确认和 sandbox 流程；文案持续保留 `No automatic charge` 边界。

## 3. 统一视觉系统

两页必须共享下列 token，统一为“温暖的旅行探索工具”，而非地图页像消费产品、项目页像企业后台。

```css
:root {
  --color-ink: #102a43;
  --color-muted: #627d98;
  --color-paper: #fffaf3;
  --color-card: #fffdf9;
  --color-line: #e8e1d8;
  --color-sea: #073d50;
  --color-teal: #0b8a88;
  --color-coral: #ef7654;
  --color-sun: #f6bd60;
  --color-lime: #d6edc7;
  --shadow-raised: 0 18px 50px rgb(16 42 67 / 13%);
}
```

| 元素 | 规范 |
|---|---|
| 应用框架 | 桌面 88px 深海蓝左侧栏；移动端改为 62px 顶栏。品牌、探索、项目、收藏、当前用户在两页位置一致。 |
| 字体 | 使用项目既有的现代 sans-serif。正文最小 16px、行高至少 1.5；标题可紧凑但不可小于 24px。 |
| 卡片 | 暖白表面、`1px` 浅边框、`22–24px` 圆角、柔和阴影。卡片状态不可只凭色彩区别。 |
| 主操作 | 珊瑚橙背景、白字、最小 44px 高；hover 仅改变色彩/轻微 elevation，不能移动其他元素。 |
| 图标 | 仅 Lucide React 或同一套 SVG 线性图标；有可见文字的装饰性图标设 `aria-hidden`，图标按钮需可访问名称。 |
| 焦点 | 所有键盘可达控件使用不少于 `2px`、与背景对比度至少 `3:1` 的可见 focus ring；原型中的黄色环可作为基线。 |
| 动效 | 150–300ms 交互反馈；列表可 250–350ms 向上淡入。`prefers-reduced-motion: reduce` 时直接呈现最终状态，禁止持续装饰动画。 |

使用 4/8px 间距节奏。需要维持 375px、768px、1024px、1440px 下的无横向滚动布局。

## 4. 公共应用 Shell

### 4.1 导航

| 导航项 | 路由 | 行为 |
|---|---|---|
| 探索地图 | `/home` | 页面状态为 active；返回新加坡/当前探索状态。 |
| 我的项目 | `/projects` | 页面状态为 active；加载当前成员可见项目。 |
| 收藏地点 | 后续 P1 | MVP 仅保留不可操作占位或隐藏，不能伪造已持久化收藏。 |
| 用户头像 | 后续 Profile 入口 | 应可访问地标识当前演示用户；不得将用户选择放入 URL query。 |

导航应由 `AppShell` 统一实现，避免两个页面复制导航 CSS 和交互。移动端顶部导航保留最多 5 个入口。

### 4.2 数据、加载和错误

- 静态 shell 使用 Server Component；地图、筛选、搜索、抽屉和 mutation 用 Client Component。
- 每条路由提供 `loading.tsx`，列表/地图使用稳定尺寸的 skeleton，避免 CLS。
- API 请求通过统一 typed fetch client，自动添加 `Authorization: Bearer <Cognito access token>`、生成 `X-Request-Id`（UUID v4）、转发上一次响应中的 `X-Correlation-Id`，解析标准错误体和 `x-correlation-id`；不得直连数据库或通过 Server Action 绕开 Fastify。
- 服务端契约：每个响应（含 2xx 与错误体）回显 `x-correlation-id`（服务器生成的 UUIDv4，作为审计/日志的权威标识）；客户端送入 `X-Request-Id` 时，服务端将其原样回显在 `x-request-id` 响应头，并写入 Pino 子 logger 的 `clientRequestId` 绑定，但不替换服务器生成的 `correlationId`。`X-Correlation-Id` 入站仅作为日志上下文线索，不影响服务器生成的 correlationId。
- API 失败显示中性且可恢复的错误状态；未授权状态不透露隐藏项目、成员或 Profile 是否存在。

## 5. 探索首页 `/home`

### 5.1 页面结构

```text
AppShell
└─ ExploreMapPage
   ├─ ExploreTopBar（AI 身份、回到新加坡、帮助）
   ├─ MapSurface（动态加载）
   │  ├─ CurrentLocationBot（新加坡）
   │  ├─ FixtureDestinationMarkers
   │  ├─ PrivateInspirationMarker（会话内/已保存时）
   │  └─ FlightRouteOverlay
   ├─ ExplorePromptCard（地图未选择前）
   ├─ ExploreDrawer（进度、推荐、来源与 CTA）
   └─ AccessibleDestinationList（地图不可用时的等价入口）
```

### 5.2 地图与降级

1. 使用 MapLibre GL JS 的浏览器端动态 import，并将地图 bundle 从首屏静态 shell 中分离。
2. 初始中心固定为 Singapore (`103.8198, 1.3521`)；MVP 不请求浏览器定位权限。
3. 生产必须使用已审批的地图 style/tile provider、许可和 attribution。原型使用的 demo tiles **不得**直接当作生产数据源。
4. 地图容器需在加载前预留固定/响应式高度；加载失败、WebGL 不可用、低性能设备或减弱动态效果时，呈现静态地图背景和同等可操作的目的地列表。
5. 地图点选不能是唯一操作方式：候选地点需有键盘可达按钮列表；每个标记有名称和状态文字替代。

### 5.3 探索状态机

| 状态 | 触发 | 可见内容 | 允许操作 |
|---|---|---|---|
| `IDLE` | 初次进入 / 回到新加坡 | 机器人在新加坡轻微待机、探索提示、固定候选快捷入口 | 选地点、回到新加坡、打开帮助 |
| `SELECTED` | 用户点击候选标记或坐标 | 抽屉标题/目标更新 | 取消、确认探索 |
| `TALKING` | 已确认目标 | 1–1.5 秒人类与机器人对话气泡；抽屉 step 1 | 取消；不阻塞焦点或页面读取 |
| `FLYING` | 对话结束 | 新加坡至目标的路线、飞机/机器人沿路径移动；抽屉 step 2 | 取消/跳过动画 |
| `EXPLORING` | 动画完成或减弱动态模式 | 地图聚焦目标、抽屉 step 3、推荐和 CTA | 保存灵感 / 围绕受支持候选进入规划 |
| `MAP_UNAVAILABLE` | 加载失败 | 无障碍地点列表、可恢复提示 | 选择 fixture 地点、重试地图 |

动效只表达状态转换；不可让用户等待动画后才可使用核心功能。减弱动态效果下可直接进入 `EXPLORING`，同时文字显示“已抵达”。

### 5.4 地点类型与 CTA

| 类型 | 数据 | 抽屉内容 | CTA |
|---|---|---|---|
| 固定候选 | 服务端候选/版本化 fixture | 已授权匹配原因、来源/时间或 `Demo data`、可验证缺口 | `查看候选方案` / `围绕此地规划` |
| 私有灵感 | 当前用户保存的灵感 | “未验证的灵感”标识；不显示价格/库存/readiness | `保存为私有灵感` |
| 任意空白坐标 | 临时 client marker | 明确说明没有可验证候选数据 | `保存为私有灵感` 或以后请求加入候选 |

空白坐标不修改共享约束、现有计划或确认。任何持久化灵感必须走授权后端模型；如果 API 未提供，MVP 只能作为会话内临时 marker，并明确说明刷新后消失。

## 6. 我的项目 `/projects`

### 6.1 页面结构

```text
AppShell
└─ ProjectsPage
   ├─ PageHeader（标题、说明、新建规划）
   ├─ ProjectSummary（继续规划 / 进行中 / 已完成 / 已归档）
   ├─ ProjectFilters（状态 chips + 搜索）
   ├─ AttentionProjectCard（仅在有操作时）
   ├─ ProjectArchiveGrid
   │  └─ ProjectCard × n
   ├─ EmptyState / ErrorState / LoadingSkeleton
   └─ ToastRegion
```

### 6.2 视觉与层级

- 头部使用 `YOUR TRAVEL ARCHIVE` 小标题、`我的项目` 大标题与一句解释；右侧（移动端改为全宽下方）为 `新建规划` 珊瑚橙按钮。
- 摘要区使用一个有小机器人的“需要继续规划”主卡，加三张数量卡。数量应由同一服务器列表/summary 响应提供，不能与项目列表分离后出现矛盾。
- “继续出发”使用比普通卡更高的强调卡：左侧为不携带事实的路线抽象图，右侧呈现状态、项目名、说明、成员数量、日期、`Demo data` 和唯一下一步。
- 档案项目采用三列卡片网格（tablet 两列、mobile 一列）。每卡包含抽象目的地色带、项目名、状态、日期、成员数、最后更新/当前 version 与 `打开`/`回看` 操作。
- 不使用未获授权的旅游照片或人物照片；目的地视觉可使用自制 CSS/SVG 图形、经过许可的资产或不含事实承诺的色带。

### 6.3 状态映射与排序

前端展示状态必须由服务端返回或服务端定义的映射得出：

| 展示分组 | 进入条件 | 卡片文案示例 | 主操作 |
|---|---|---|---|
| 需要你处理 | 当前成员有待授权、readiness 缺口、待确认、`STALE` plan 或其他 action required | `方案 v2 已过期`、`等待你的确认` | 跳转到准确恢复路由 |
| 进行中 | 可访问且未完成的 `PLANNING` 项目 | `正在规划` | 打开项目工作台 |
| 已完成 | 服务端确认已完成/sandbox 结果可回看 | `已完成` | 只读回看 |
| 已归档 | 服务端返回归档/历史视图 | `已归档` | 查看历史版本 |
| 已取消 | 仅在有可读记录时显示 | `已取消` | 查看只读摘要 |

默认排序：需要你处理（按严重性与更新时间）→ 进行中（`updatedAt` 降序）→ 已完成/归档（最近更新时间降序）。不得依据客户端时间或本地缓存猜测状态。

### 6.4 筛选、搜索和空态

- 筛选 chip 必须是原生 `<button>`，显示 `aria-pressed`，使用 `role="group"` 和清晰标签。手机端允许换行，不能把标签裁剪成不可读状态。
- 搜索仅匹配服务端已经授权返回的项目 `name` 和候选地点摘要；不得搜索其他成员资料或任何私密内容。
- 若项目数较多，筛选/搜索/分页应由服务端执行；前端不加载全量私密行程再过滤。
- 无项目：显示“还没有旅行项目”与 `从地图开始探索` / `新建规划` 两个入口。
- 无筛选结果：保留当前筛选与搜索内容，显示“没有匹配的项目”和清除筛选操作。
- 异步数量更新应使用一个上下文化 `role="status" aria-atomic="true"`，例如“显示 3 个项目”；不能让每个数字变成竞争的 live region。

## 7. 路由与深链接

| 来源 | 操作 | 目标 |
|---|---|---|
| 探索固定候选 | 查看方案 | `/trips/[tripId]/plans/[planId]` |
| 探索固定候选 | 围绕此地规划 | `/trips/new`，仅传递非敏感的受控候选选择 |
| 项目主卡 | 复核方案 | `/trips/[tripId]/replan/[planId]` 或 API 指定的恢复入口 |
| 项目进行中卡 | 打开项目 | `/trips/[tripId]` |
| 项目待确认 | 确认 | `/trips/[tripId]/confirm/[planId]` |
| 项目已完成/归档 | 回看 | `/trips/[tripId]` 的只读历史视图 |

“下一步”路由由服务端 action model 提供时，前端直接使用；没有 action model 前，只能基于已知、当前版本的安全链接展示入口，不可猜测 `planId`。

## 8. API 合同与当前缺口

现有 `GET /trips` 已安全返回成员可见的基础 trip 摘要：`id`、`name`、`status`、出发地、候选目的地、日期、成员数、成员角色和 `createdAt`。这足以渲染基础列表，但**不足以**实现原型的权威状态和排序。

### 8.1 必需的项目摘要 API 扩展

扩展 `GET /trips` 或新增专用、同样受成员鉴权的 `GET /projects`。推荐以一个响应完成项目页，不让浏览器对每张卡再逐一请求详情：

```ts
type ProjectSummary = {
  id: string;
  name: string;
  tripStatus: "PLANNING" | "CONFIRMED" | "BOOKED" | "CANCELLED" | "STALE";
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart: string | null;
  travelDateEnd: string | null;
  memberCount: number;
  role: "CREATOR" | "MEMBER";
  createdAt: string;
  updatedAt: string;
  displayState: "ACTION_REQUIRED" | "IN_PROGRESS" | "COMPLETED" | "ARCHIVED" | "CANCELLED";
  latestPlan: {
    id: string;
    version: number;
    status: "DRAFT" | "ACTIVE" | "STALE" | "SUPERSEDED";
    generatedAt: string;
    isDemoData: boolean;
  } | null;
  nextAction: {
    type: "REVIEW_PLAN" | "GRANT_CONSENT" | "CHECK_READINESS" | "CONFIRM_PLAN" | "VIEW_PROJECT" | "VIEW_HISTORY";
    label: string;
    href: string;
  } | null;
};
```

约束：

- `displayState`、`latestPlan` 与 `nextAction` 必须由服务端根据授权、snapshot、plan、confirmation 和 booking 状态派生。
- `nextAction.href` 不得包含敏感字段、私密 Profile 或可被猜测后越权的 ID。
- 所有时间使用 ISO 8601；前端以 `Intl.DateTimeFormat` 显示。
- 不向列表返回他人的授权字段、国籍、私聊、证件、完整 audit payload 或 provider 凭据。
- 列表需要 `limit`、cursor、`status`、`q` 的服务端分页/筛选契约；MVP fixture 数量小但不应锁死全量加载设计。

### 8.2 探索 API 后续缺口

MVP 可由版本化 fixture 提供最多 6 个推荐地点和 2–3 个候选地点。投入持久“私有灵感”前，需先定义成员私有的写入/读取 API、授权规则、删除行为、来源标记及审计事件。没有该 API 时，探索 marker 只能是页面会话状态。

## 9. 推荐组件与状态管理

| 组件 | 职责 | 状态来源 |
|---|---|---|
| `AppShell` | 导航、当前演示用户、响应式布局 | 会话/API client；不存业务真相 |
| `ExploreMap` | 延迟加载地图、camera、marker 渲染 | Client UI state + 已授权 fixture/API |
| `ExploreJourney` | 上述状态机、动效与抽屉进度 | Local UI state；不持久化 plan |
| `DestinationDrawer` | 展示来源、时间、数据标签和可用 CTA | API / fixture payload |
| `ProjectsQuery` | 获取分页项目摘要 | TanStack Query |
| `ProjectSummaryCards` | 数量与 attention 入口 | 同一 projects response |
| `ProjectFilters` | URL-safe UI 筛选、搜索输入 | React state / URL search params；不存敏感用户资料 |
| `ProjectCard` | 展示安全摘要和 action | `ProjectSummary` |
| `ProjectArchive` | 服务端分页、加载/空/错误态 | TanStack Query |

Mutation 成功后，只失效最小相关 query key：`["projects"]`、`["trip", tripId]`、`["plan", planId]`、`["confirmations", planId]` 等。不得仅通过乐观本地修改把项目状态改为 `STALE`、`CONFIRMED` 或 `BOOKED`。

## 10. 无障碍、性能与可观测性

### 10.1 无障碍验收

- 文本对比度至少 4.5:1；非文本控件/焦点边界至少 3:1。
- 所有可点击目标最小 44×44px；桌面 hover 不是唯一状态或唯一操作方式。
- 地图、抽屉、筛选、搜索、卡片 CTA 和关闭操作均可键盘使用。抽屉开启后焦点移至抽屉标题或关闭按钮；关闭时回到触发元素。
- 抽屉/Toast 使用适当的 `aria-expanded`、`aria-controls`、`role="status"`，不要滥用 `aria-live`。
- 地图交互的所有业务 action 有列表/按钮替代；非关键动画在减弱动态下跳过。
- 在 375px、768px、1024px、1440px 及 200% 文字缩放下检查，不能出现水平滚动、截断 chip 或被固定导航遮挡的内容。

### 10.2 性能验收

- 地图引擎、地图样式、标记图片和非首屏档案卡延迟加载；为地图与 skeleton 预留布局空间。
- 不使用无限装饰动画；飞行路线只在明确状态转换期间执行。
- 长项目列表服务端分页；客户端不要因搜索/filter 导致全量 re-render。
- 若引入地图 provider、图片或字体，检查来源许可、CSP、加载失败与 bundle 体积。

### 10.3 安全遥测

仅记录低基数、无敏感数据的事件，例如：`explore_destination_selected`、`explore_fixture_cta_opened`、`projects_list_loaded`、`projects_filter_changed`、`project_next_action_opened`。可在 trace/log 上关联 `trip_id`、`plan_version`、`run_id`，但不得作为 metric 标签。不得记录坐标、搜索词、Profile、国籍、证件、私聊、完整 API 响应或 provider token。

## 11. 测试与验收清单

### 11.1 组件与 E2E

1. `/home` 初始定位 Singapore，机器人/提示可见，固定候选和键盘等价入口均可启动探索。
2. 候选地点遵循 `IDLE → TALKING → FLYING → EXPLORING`；减弱动态时直接显示终态而不阻塞 CTA。
3. 空白地图坐标绝不出现价格、库存、签证或预订事实；只能临时保存为灵感/提示后续请求。
4. 地图加载失败时可通过地点列表继续操作；无障碍语义不丢失。
5. `/projects` 只显示当前演示用户有成员资格的项目；切换 demo user 清空相关 Query cache。
6. 项目卡严格显示 API 的 `displayState`、`latestPlan.version`、`isDemoData` 和 `nextAction`；不得凭客户端条件造状态。
7. 筛选 chip 使用鼠标、键盘和 screen reader 均可操作；搜索/无结果状态的数量播报准确。
8. `STALE` 项目优先展示，且 CTA 通向 API 指定的复核/授权/确认入口。
9. 历史项目不提供确认、预订或伪实时价格操作；只读状态清晰。
10. 视觉检查覆盖 375/768/1024/1440；检查 focus、对比、移动端筛选换行、抽屉与底栏不遮挡。

### 11.2 现有文档/测试同步

实施 API 或行为变化时，需同步更新：

- `docs/frontend-ui-plan.md`：将探索页/项目页规格和 API 就绪度改为实际状态；
- `docs/backlog.md`：增加项目列表与安全探索的验收；
- `docs/test-scenarios.md`：加入上述探索、项目列表、权限、`STALE`、历史只读与 fallback 场景；
- API OpenAPI schema、路由测试和前端组件/E2E 测试。

## 12. 实施顺序

1. 建立共享 `AppShell`、design token、typed API client、演示用户和路由 loading/error shell。
2. 完成 `/projects` 的 API summary contract、项目列表、状态/筛选/搜索/空态与只读链接；先验证权限和 `STALE` 排序。
3. 完成 `/home` 的静态 fallback、fixture 标记、抽屉和可访问地点列表。
4. 在此基础上延迟接入 MapLibre、镜头与探索状态机；只在地图可用时启用飞行动效。
5. 接入真实 action links、来源标签、loading/error、遥测与全链路测试。

开发者完成时，应能稳定展示原型对应视觉，且 Alice、Bob、Chen 只看到各自获准项目；地图失效不阻塞规划；每个旅行事实保有来源标识；三人授权、plan 版本和确认/预订边界仍完全由服务器控制。
