# 私密旅行助手与行程规划流程：当前落地与边界

**状态：** 已实施（MVP）  
**读者：** 产品、设计、工程、测试与演示协作者  
**目的：** 用同一套语言说明私密对话、完整行程规划、授权与状态转换如何协作；本文件是共享说明，不替代 `TECH_STACK.md`、`docs/PRD.md` 与各专项实施契约。

## 1. 对外产品语言

用户只会看到 **Wanderly**，不会看到内部的 `Personal Agent`、`Shared Agent`、handoff 或 Worker 等名称。

| 用户看到的说法 | 含义 |
|---|---|
| 私密对话 / Wanderly 旅行助手 | 用户表达想法、补充偏好、确认行程信息的入口 |
| 确认行程信息 | 用户审核从对话整理出的结构化行程简报 |
| 开始规划 | 用户明确授权 Wanderly 用已确认信息进入完整规划流程 |
| 完整行程方案 | 由服务端快照、受控工具与规划任务生成的候选方案 |

内部代码仍保留 `Personal` 和 `Shared` 的术语，用于权限边界、审计和排障；这些名称不得出现在面向用户的聊天、按钮、错误提示、状态提示或通知中。

## 2. 两个内部职责

### 2.1 Personal：私密对话入口

Personal 是当前用户自己的私密对话入口，不是独立的旅行预订或供应商执行器。

它负责：

- 理解、简短介绍目的地，并澄清旅行意图；
- 从明确表达中整理出发地、目的地、明确日期、时长及少量关键偏好；
- 将多轮收集的信息合并为一张 **待确认的行程信息卡**；
- 在用户明确提出酒店、航班等单项需求时，直接协助当前问题，只补充真正缺失的受控条件；
- 对已激活行程，把允许字段目录内的非敏感输入转为待确认的 constraint proposal。

它不能：

- 生成逐日行程、路线、住哪里、换酒店、交通安排或供应商比较；
- 把私聊原文、Profile 或未确认偏好直接交给规划任务；
- 自行创建 snapshot、计划、预订、付款、签证申请或不可逆外部操作；
- 主动推销机票、酒店或单独搜索服务。

### 2.2 Shared：服务端完整规划能力

Shared 是内部的非对话规划能力，不直接与用户聊天。它只读取服务端构建的不可变 `constraint_snapshot`、受控搜索偏好和归一化 provider evidence。

它负责：

- 在 durable task 中调用允许的 Flight、Accommodation、Activities、Places、Readiness 等能力；
- 生成 schema 校验后的 `PROPOSED` plan；
- 在授权、约束、价格或库存变化后，使旧方案失效并执行 replan；
- 仅在完整确认条件满足时进入后续采用和 booking sandbox gate。

它不能读取私聊正文、未授权 Profile、未确认候选或任意用户原始提示；也不能自行联系用户、改变业务状态、确认方案、付款或预订。

## 3. 单人完整流程

```text
用户私密对话
  → Personal 整理候选简报（仅内存卡片）
  → 用户点击「确认行程信息」
  → DRAFT brief 写入 shared_trips
  → 用户点击「开始规划」
  → 原子事务：DRAFT → PLANNING + snapshot + 首个规划任务
  → Shared Worker 生成 PROPOSED 方案
  → 用户采用方案；后续预订仍须经过显式确认 gate
```

### 3.1 简报收集与确认

- 第一条提交的聊天消息才创建 `DRAFT` Trip、创建者 membership 和默认私有 thread。
- 从聊天提取的内容只是候选，不能直接写为行程事实。
- 前端会合并跨轮次候选。例如先说“去苏州玩三天”，后说“从上海出发，12 月 10 日左右”，会合并成同一张卡而不会互相覆盖。
- 用户点击“确认行程信息”才调用 `PATCH /trips/:tripId/draft-brief` 写入 `shared_trips`。
- “确认无误”“可以搜索”等自然语言不是开始完整规划的命令；开始规划必须通过清晰的 UI 动作，避免把酒店确认误当成整段旅行确认。

### 3.2 开始规划的原子语义

单人 Trip 的“开始规划”调用 `POST /trips/:tripId/activate`。当已有出发地、目的地、出发日期和结束日期/时长时，服务端在同一事务中：

1. 校验创建者权限与 `DRAFT` 状态；
2. 写入确认的 brief，状态变为 `PLANNING`；
3. 若仅给出日期和时长，按包含首尾日期推导结束日期；例如 `2026-12-10 + 3 天 = 2026-12-12`；
4. 写入该 MVP 首轮规划展示并确认过的基础条件：往返、1 位成人、经济舱、CNY、60 分钟报价新鲜度；
5. 创建不可变 `constraint_snapshot`；
6. 接受一个 `RESEARCH / PROPOSE_PLAN` durable task，并写入 outbox event；
7. 将 `runId` 和 `snapshotId` 返回给前端，前端订阅规划进度。

任何一步失败会回滚整个事务，不允许出现“显示已开始、实际没有规划任务”的半完成状态。

> 当前 MVP 的初始条件会在“开始规划”卡片中提前展示，点击按钮就是对这些初始条件的确认。用户后续可以调整搜索偏好；调整会触发既有 stale/replan 机制。

## 4. 多人流程与成员后续变更

多人行程的创建者也可以将 `DRAFT` 激活为 `PLANNING`，但不会因为创建者单独点击而创建共享 snapshot 或首个完整规划任务。

- 每位 required member 只能在自己的私密 thread 中看到和确认自己的候选；
- 确认后才写入 `trip_constraint_facts`，并带 `TEAM_VISIBLE` 或 `ORCHESTRATOR_CONFIDENTIAL` visibility，以及 `HARD`/`SOFT` strength；
- 不共享私聊原文；`ORCHESTRATOR_CONFIDENTIAL` 只进入服务器 projection，不能出现在其他成员 API、UI、SSE、解释或遥测中；
- 当前规划中的任一成员约束变化、授权撤回、价格/库存变化都会使依赖方案进入 `STALE`，并由服务端创建新的 snapshot 与 replan；
- 新方案始终从 `PROPOSED` 开始。所有 required members 对同一最新版本 `ACCEPT` 后才可成为 `ACTIVE`；booking 仍是另一道显式确认 gate。

## 5. 状态与数据边界

| 阶段 | 允许 | 禁止 |
|---|---|---|
| `DRAFT` | 私密对话、简报候选、创建者确认 brief、邀请同行者 | snapshot、规划任务、共享约束事实、确认、booking |
| 激活事务 | 仅由创建者明确“开始规划”触发；单人可原子创建首轮 snapshot/task | 模型或自然语言自动激活 |
| `PLANNING` / `STALE` | 成员提出并确认结构化约束、服务端规划/replan | 将私聊原文交给规划、绕过 consent 或成员确认 |
| `PROPOSED` | 查看、比较、投票/采用 | 预订或作为最终生效方案 |
| `ACTIVE` | 进入既有 booking 确认流程 | 自动支付、自动预订 |

权威状态永远在 PostgreSQL：`shared_trips`、`trip_constraint_facts`、`constraint_snapshots`、plan version、确认记录、idempotency record 与 durable task。前端状态和模型输出都不是业务真相。

## 6. Provider 与事实边界

- 模型不直接调用数据库或 provider；所有能力通过服务端 policy gate、typed adapter 与 durable task 调用。
- 价格、库存、路线、供应商 offer 都必须带来源和检查时间；没有可靠 live 数据时返回 `UNAVAILABLE`，不能拿 fixture 伪装实时结果。
- 住宿实时报价仅在对应 provider 已启用、所需条件和授权齐全时使用；当前首轮完整规划不自动带入 `hotel` capability。
- 对话安全拒绝不会声称实时价格、库存、签证结论、预订状态或航班动态，也不泄露内部角色名称。

## 7. 关键实现入口

| 领域 | 位置 |
|---|---|
| 私密对话边界与文案规则 | `apps/api/src/providers/llm-gateway.ts` |
| 简报候选提取 | `apps/api/src/services/trip-brief-proposal-service.ts` |
| DRAFT / PLANNING handoff gate | `apps/api/src/tasks/handlers/conversation-task-handler.ts` 的 `shouldExtractConversationHandoff` |
| 确认 brief 与开始规划 | `apps/api/src/routes/trips.ts` |
| 前端确认卡、开始按钮与任务订阅 | `apps/web/src/components/explore/travel-agent-chat.tsx` |
| 规划快照与任务 | `apps/api/src/services/planning-service.ts`、`apps/api/src/tasks/task-repository.ts` |
| 状态与回归场景 | `docs/test-scenarios.md` |

## 8. 当前限制

- 对话卡目前会提取明确日期与时长，但复杂自然语言日期、人数、货币、酒店星级等偏好还没有全部成为同一张简报卡的持久字段；这些仍走各自受控的搜索偏好/约束确认流程。
- 单人首轮规划的初始 flight 条件是 MVP 默认值，后续应将用户在对话中已明确给出的币种、人数、舱位等条件无损带入确认卡与持久偏好。
- 不得因为上述限制而回退到“Personal 代为编排每日行程”或“自然语言确认自动提交”的行为。

## 9. 最小验收用例

以“上海出发，12 月 10 日左右去苏州玩三天”为例：

1. 私密对话只介绍或澄清，不给 Day 1–3 行程，也不主动推销酒店或机票；
2. 确认卡应合并显示上海、苏州、2026-12-10、3 天；
3. 用户确认行程信息后，点击“开始规划”；
4. 后端应生成 `2026-12-12` 结束日期、snapshot 和唯一的 `PROPOSE_PLAN` task；
5. 前端显示 Wanderly 正在规划，不出现内部 Agent 名称；
6. 无论 provider 是否可用，都只能产生带来源的结果或 `UNAVAILABLE` gap，绝不生成伪造的实时价格/库存。
