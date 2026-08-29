# 共享行程闭环页面规划

**状态：** 规划稿（未实施）
**基线：** 2026-08-29 前端现状；与 `docs/frontend-ui-plan.md`、`docs/PRD.md`、`docs/backlog.md` 一致。
**目标：** 补齐三位旅行者从创建到 booking sandbox 的可验证闭环，同时不把敏感资料、服务端状态或 provider 事实复制到浏览器状态。

## 1. 现状盘点

当前生产路由为：

| 路由 | 已有界面 | 已覆盖的职责 | 结论 |
|---|---|---|---|
| `/home` | Explore 地图 | 受控地点探索、地图降级、私有探索对话入口 | 保留；它不是“新建行程”页。 |
| `/projects` | 项目列表/仪表板 | 行程搜索、状态筛选、Profile 摘要、继续打开 trip | 保留并升级为行动收件箱。 |
| `/profile` | 私密资料表单 | 可编辑的稳定旅行偏好 | 保留；补字段来源、更新时间和 trip override 入口。 |
| `/trips/[tripId]` | 三栏工作台 | 私人 thread、Trip 概览、成员、地点、研究缺口、地图 | 保留为协作“中枢”，不承担复杂的决策详情。 |
| `/login`、`/register`、`/forgot-password` | 会话界面 | 身份与恢复 | 无需为本闭环改变信息架构。 |

此外，`TeamOrchestrationPanel` 已有约束提案/方案采纳投票的组件和 hooks，但当前没有被工作台挂载；它不能替代字段级 consent、plan compare 或 booking confirmation 页面。

当前缺口不是单纯的菜单入口，而是缺少可深链、可回退、由服务端权威状态驱动的任务页面。把它们压缩到工作台右栏会让来源、版本、个人可见性和确认门槛失去清晰边界。

## 2. 页面归类与决定

### 应加强现有页面

| 页面 | 增加内容 | 原因与入口 |
|---|---|---|
| `/projects` | 顶部 **需要你处理** 队列，按 `STALE → 待 consent → readiness 缺口 → 待确认` 排序；每项只显示服务端给出的下一步链接。`新建规划` 指向 `/trips/new`。 | 行程列表应回答“现在要做什么”，而不是仅按 Trip status 罗列。 |
| `/home` | 地点抽屉的“围绕此地规划”深链至 `/trips/new`，仅传递受控且非敏感的候选值；不要创建 Trip 或写入共享约束。 | 保持探索与业务事实边界。 |
| `/profile` | 每个字段显示“仅自己可见 / 已为某次行程授权”、来源和更新时间；增加“本次行程覆盖”入口，不能把 override 自动保存回 Profile。 | 资料页继续是私密资料真相的编辑面。 |
| `/trips/[tripId]` | 在标题下加入持久的 **行程阶段条 + 当前行动卡**：`Brief → Members → Consent → Compare → Readiness → Confirm → Sandbox`。卡片只链接到下列专页；右栏保留安全摘要、成员和研究缺口。挂载经过改造的 TeamOrchestrationPanel 作为“团队约束/采纳”小节。 | 工作台适合恢复上下文与导航，不适合比较、个人敏感核验或不可逆确认。 |

### 必须新建的 P0 页面

| 路由 | 页面与核心界面 | 为什么独立 | 服务端/API 前置 |
|---|---|---|---|
| `/trips/new` | **创建行程向导**：基本信息 → 成员 → 两至三个受控候选/两个出发地 → 复核。显示 `Step n of 4`；主操作为“开始私人探索对话”。 | 创建涉及连续输入和可恢复校验，不能放在地图抽屉。 | 当前 lifecycle 规定首条私聊才原子创建 `DRAFT` Trip；此页的草稿必须只在内存中，提交时走既有 start+chat 边界。若改为直接 `POST /trips`，须先更新 PRD/生命周期文档。 |
| `/trips/join/[tripId]`（建议最终改为不可猜测的 invitation token） | **接受邀请**：旅行摘要、成员身份、接受/拒绝、隐私说明；成功后的唯一主操作是“设置共享范围”。 | 外部访问入口、授权前状态和邀请效期需要清晰隔离。 | invitation read/accept/decline 的最小安全响应；不能依靠 URL 中可猜测 trip ID 授权。 |
| `/trips/[tripId]/consent` | **字段级授权**：按“旅行偏好、预算护栏、出发/舒适限制、国籍/入境准备”分组；每项写清使用者、用途、产生能力。撤回用确认对话框并展示其使哪些 plan/readiness/confirmations 过期。 | 这是敏感的、有副作用的权限任务，不能伪装成成员列表的开关。 | 当前 consent API 需返回当前 scope、field metadata 和安全的 invalidation impact。证件字段在 MVP 不收集/不展示。 |
| `/trips/[tripId]/plans/[planId]` | **候选方案比较**：2–3 个目的地列式比较；每列含价格/货币、按出发地的服务、来源、采集时间、报价失效时间、已授权约束、`UNAVAILABLE` 缺口；明确选中态与文字化取舍。 | 这是核心决策，桌面需要横向对照、移动端需要分段比较；右栏无法安全承载。 | 方案读取模型需要标准化 candidate/service/evidence 结构，不能让 UI 解析原始 provider payload。 |
| `/trips/[tripId]/readiness` | **我的入境准备**：只显示当前用户；目的地/已选路线的 checklist、官方来源、检查时间、下一步和不确定性。未授权国籍时只显示“需要授权”的缺口。 | readiness 是个人敏感信息，团队页只能显示聚合状态。 | owner-scoped readiness 读取；路线变更/过期/撤回后的权威状态。不得返回同伴国籍或 checklist。 |
| `/trips/[tripId]/replan/[planId]` | **重规划 diff**：旧版只读，新版 proposal；按“保留 / 变化 / 需要你输入”分组，顶端给出触发因素和受影响服务/准备事项。无可行替代时显示阻塞限制与对应恢复入口。 | `STALE` 的原因与旧/新证据必须同时可见，避免静默替换。 | 结构化 old/new diff、trigger、affected categories、可安全展示的 action model；旧 plan 永远 comparison-only。 |
| `/trips/[tripId]/confirm/[planId]` | **三人确认**：固定摘要、服务/总价/来源、三位 required member 的状态，只有 `Confirm this plan` 与 `Needs changes`。持续显示 `No automatic charge`。 | 明确的人类确认边界和状态等待页，不能藏在 plan 卡。 | current plan/version、成员确认状态及 server booking eligibility；API 成功后再刷新状态。采纳投票与 booking confirmation 必须分开。 |
| `/trips/[tripId]/booking/[planId]` | **Booking sandbox 结果**：逐服务 request 状态、sandbox reference 或安全错误、重复/乱序 callback 说明；成功文案为“已生成 sandbox 参考号”，绝不称“已预订”。 | 结果需要可回看、可轮询且不能与真实支付混淆。 | 读取 booking execution/result，且由服务端 `bookingGate=OPEN` 决定是否可以发起。 |

### 新建但可延后至 P1 的页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/trips/[tripId]/activity` | **安全活动时间线** | 授权授予/撤回、snapshot、规划、stale、确认、sandbox 的脱敏摘要；不显示私聊、国籍、证件、prompt、原始 provider payload。需专用 audit read model。 |
| `/help/data-boundaries` | **数据边界帮助页** | 解释“私密资料 vs 本次共享”“来源与采集时间”“STALE”“UNAVAILABLE”“No automatic charge / sandbox”，可从 consent、compare、readiness、confirm 反复深链。静态 Server Component 即可。 |

## 3. 推荐的闭环导航

```text
Explore / Projects
       ↓
Create wizard → private first message creates DRAFT → Trip workspace
       ↓                                             ↓
  Invite / Join  ───────────────────────────────→ Consent
                                                     ↓
                                              Candidate comparison
                                              ↙                 ↘
                                  My readiness              STALE → Replan diff
                                              ↓                 ↓
                                           Confirm ←──────── ACTIVE proposal
                                              ↓
                                   Booking sandbox result
                                              ↓
                                  Activity timeline / archive
```

工作台阶段条应根据服务端 action model 高亮唯一的“下一步”。它不能根据前端猜测的 `planId`、本地时间或缓存值切换状态。

## 4. 统一组件与交互准则

- 复用一套 `TripSubnav`（概览、比较、准备、活动）和 `TripActionCard`；`consent`、`replan`、`confirm`、`booking` 使用全宽任务页，避免三栏布局挤压表单或 diff。
- 创建向导采用明确步骤指示；授权撤回、Needs changes、确认提交均使用确认对话框和就地结果反馈。
- 所有 facts 使用一个 `EvidenceMeta`：`来源`、`captured_at/checked_at`、`expires_at`（适用时）、`UNAVAILABLE` 理由；不提供 fallback fixture。
- 所有页面准备 `loading.tsx`、空态、错误态、无权访问态。慢查询由路由 loading/Suspense 展示稳定骨架；领域 mutation 仍通过 Fastify API，而非 Server Action。
- 沿用现有 Wanderly 手帐式 token（深色描边、纸张表面、青绿色 highlight、Lucide SVG）。本次 UI 设计检索得到的 Aurora/橙色建议不应覆盖已落地的 `docs/prototype-design-system.md`；后者是项目的既有视觉事实来源。
- 每个交互目标至少 44px、普通文字对比度至少 4.5:1、有可见焦点、移动端单列不横向滚动，并尊重 `prefers-reduced-motion`。

## 5. 实施批次与验收

1. **闭环入口：** `/trips/new`、invite/join、consent，升级 `/projects` 行动队列和 workspace 阶段条；验收默认不共享、邀请接受不等于 consent、撤回立即让依赖项变 stale。
2. **计划决策：** candidate comparison、个人 readiness、replan diff；验收每个事实都有来源/时间，缺失服务为 `UNAVAILABLE`，同伴 readiness 不可见。
3. **不可逆边界：** confirm 与 booking sandbox result；验收三人当前版本确认前 gate 闭合、Needs changes 阻断、重复/乱序 callback 只产生同一组 reference。
4. **可解释性：** activity timeline 与 data-boundaries help；验收审计可关联但无敏感内容。

每一批变更都需要同步 `docs/test-scenarios.md`，覆盖 375/768/1024/1440 宽度、未授权访问、数据缺失、`STALE`、成员拒绝、重复 callback 和来源/时间展示。新增 API 前先更新 `docs/frontend-ui-plan.md` 的 API 就绪度；任何缺少契约的界面只能显示中性 `UNAVAILABLE`/恢复路径，不能假装已实现。
