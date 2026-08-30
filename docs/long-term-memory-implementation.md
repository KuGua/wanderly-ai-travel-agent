# 长期记忆实施方案

**状态：** 已批准，待实施

**范围：** 个人长期旅行记忆、仅当前 Trip 的共享/团队记忆，以及其向 Shared Trip Agent 的受控投影。
**事实来源：** [TECH_STACK.md](../TECH_STACK.md)、[PRD.md](PRD.md)、[backlog.md](backlog.md)、[test-scenarios.md](test-scenarios.md)、[agent-architecture.md](agent-architecture.md)、[AGENTS.md](../AGENTS.md)。

## 1. 实施决策与不可变边界

### 1.1 已批准决策

1. 第一阶段只使用 PostgreSQL 中的结构化事实；不引入 vector store、embedding、RAG、自动摘要 worker 或独立 memory service。
2. 个人长期记忆默认私有。Shared Agent 不得查询个人 Profile、`preference_facts`、`memory_proposals` 或私有对话；它只消费当前 Trip 的、字段级 consent 导出的不可变 snapshot projection。
3. Team memory 只属于一个 `tripId`，没有跨 Trip 团队记忆、群组偏好档案或跨行程共享检索。
4. 低风险行为可自动聚合，但只能生成有有效期的待确认提案。用户确认前，提案不是长期事实，不进入任何 snapshot、计划或共享视图。
5. 国籍、旅行证件、出生日期、健康和无障碍信息为 form-only 敏感字段：只能由用户的 Profile 表单创建或修改；任何对话、模型或行为路径均不得提取或创建其提案。
6. 原始私聊仍只用于既有的同 owner、同 thread、有界 LLM context。它不进入长期记忆、行为聚合证据、Team memory 或 Shared Agent input。

### 1.2 记忆分类与权威性

| 类型 | 权威存储 | 可写入者 | Shared Agent 输入 | 生命周期 |
|---|---|---|---|---|
| 个人稳定事实 | `user_profiles` + `preference_facts` | owner 表单；owner 确认提案 | 仅当前 Trip consent projection | 跨 Trip，owner 可编辑/删除 |
| 行为建议 | `memory_proposals` | 服务端聚合器；owner 可确认/忽略 | 永不直接输入 | 到期、确认或忽略即终态 |
| 本次个人约束 | `trip_constraint_facts` | owner 确认 proposal 或 owner Trip command | `TEAM_VISIBLE` 或 `ORCHESTRATOR_CONFIDENTIAL` projection；后者仅供 Shared planning | 仅当前 Trip |
| 本次团队决策 | `trip_memory_facts`，`kind=GROUP_DECISION` | 已授权 Trip command | 当前 Trip snapshot 的 group section | 仅当前 Trip |
| 临时会话上下文 | `chat_messages`，Worker 内存 | 既有 conversation 流程 | 永不输入 Shared Agent | thread 删除或窗口裁剪 |

`constraint_snapshots`、plan version、confirmation 与 booking 继续是业务权威状态。记忆事实和提案不能由模型输出直接创建，也不能取代这些状态机。

## 2. 现有系统接入点

| 层 | 现有模块 | 处置 | 原因 |
|---|---|---|---|
| 数据库 | `src/db/schema.ts`、Drizzle migrations、PostgreSQL | 修改并新增表 | 已有事务、外键、审计和 snapshot 控制面；不引入新存储。 |
| Profile | `routes/profiles.ts`、`user_profiles` | 修改 | Profile 仍是敏感 form-only 字段和兼容读取入口；需要与事实服务一致失效。 |
| 偏好事实 | `preference_facts` | 修改并正式接线 | 表已存在但当前未被 profile route、consent projection 或 `profile.memory` 使用。 |
| 授权 / stale | `services/consent-service.ts`、planning invalidation | 修改 | 复用 `buildAuthorizedData` 与 `stalePlansAndConfirmationsForTrip`，扩展至 memory projection。 |
| Personal Agent | `profile-memory-skill.ts`、`profile-change-proposal-skill.ts`、Skill Registry | 修改 | 事实读取和提案只走 owner scope；模型永不直接写库。 |
| Shared Agent | `shared-trip-agent.ts`、plan comparison、snapshot policy/validator | 修改 | 保持只能读取 snapshot；增加 projection schema allow-list。 |
| 私有会话 | `conversation-context-service.ts`、conversation task handler | 复用，不修改读域 | 该路径只提供短期同 thread context，禁止成为长期记忆来源。 |
| Web | Profile form、Trip workspace、TanStack Query contracts | 修改 | 增加个人事实/建议和当前 Trip memory 视图；服务端状态仍为真相。 |
| 观测 | audit、Pino redaction、OTel、metrics | 修改 | 添加无内容的记忆事件、span 和低基数指标。 |

## 3. 目标架构与数据流

```mermaid
flowchart LR
  P["Profile form / explicit save"] --> F["PreferenceFactService"]
  B["Allow-listed behavior events"] --> A["BehaviorAggregationService"]
  A --> MP["memory_proposals\nPENDING"]
  MP -->|"owner confirms"| F
  F --> PF["preference_facts\nACTIVE"]
  T["Trip memory command"] --> TM["trip_memory_facts"]
  PF --> C["Consent + MemoryProjectionBuilder"]
  TM --> C
  C --> S["immutable constraint_snapshot"]
  S --> SA["Shared Agent / planning tools"]
  PF --> I["invalidate dependent active Trips"]
  TM --> I
  I --> ST["STALE plan + confirmations"]
```

### 3.1 个人稳定事实

1. Profile 表单或 owner 确认的 proposal 调用 `PreferenceFactService`。
2. 服务在一个 transaction 内验证字段分类、写入新 active fact、将同字段旧 fact 标记为 `SUPERSEDED`，记录无值 audit，并查找该 owner 对该 field 有生效 consent 的 active Trips。
3. 对每个受影响 Trip 调用既有 `stalePlansAndConfirmationsForTrip`。不修改历史 snapshot；后续 planning 创建新 snapshot。
4. Personal Agent 的 `profile.memory` 只读取 owner 的 active facts 和允许暴露的 Profile 字段，返回来源、更新时间和状态，不返回 proposal 的原始行为证据。

### 3.2 低风险行为建议

行为事件必须来自服务器已经确认的产品动作，不能来自 raw chat 或模型文本。MVP allow-list 仅包括：已确认的住宿风格选择、已确认的 non-red-eye 选择、已确认的兴趣类别选择和已确认的行程节奏选择。

`BehaviorAggregationService` 使用确定性阈值（同一 field/value 在至少两个独立、已完成的 owner action 中出现）创建或更新一个 `PENDING` proposal。proposal 只保存标准化字段、候选值、观察次数、置信度、有效期和非内容事件引用；不得保存聊天正文、prompt、行为时间线全文或敏感值。重复运行以 `(user_id, field_key, proposed_value_hash, status=PENDING)` 幂等合并。

### 3.3 当前 Trip memory 与 projection

- `trip_constraint_proposals` 是 Personal Agent 或 owner form 生成的候选，必须由 owner 显式确认。确认后才写入版本化 `trip_constraint_facts`；模型不得直接写事实。
- 每个 Trip fact 都有 `HARD`/`SOFT` strength 和 `TEAM_VISIBLE`/`ORCHESTRATOR_CONFIDENTIAL` visibility。后者只供 Shared planning prompt，禁止出现在同行响应、plan explanation 或 telemetry；确认 UI 必须提示结果可能被间接推断。
- `GROUP_DECISION` 是成员通过显式 Trip command 保存的无敏感协作决定（例如候选优先级或已解决的约束冲突）。它对当前 active members 可见，但仍只可写入当前 Trip。
- `MemoryProjectionBuilder` 是唯一把 active personal fact、owner-confirmed trip constraint 和 group decision 组合到 snapshot 的模块。它先调用/扩展 `buildAuthorizedData`，再应用固定 field allow-list、visibility separation 和 value schema。
- projection 写入新的 immutable `constraint_snapshots.authorized_data.memory` namespace；Shared Skill 和 plan validator 只能引用该 namespace 中的字段。禁止对 memory table 的直接 SQL/Skill 访问。

### 3.4 临时会话信息

`ConversationContextBuilder` 和 `chat_messages` 的现有行为不变：仅同 owner、同 thread、任务接收时 pin 的 sequence boundary 和固定字符/轮次预算。不得在 proposal、fact、Trip memory、outbox、idempotency、audit、logs、traces、metrics 或 SSE 中复制 message body。

## 4. 数据模型与迁移

### 4.1 `preference_facts` 扩展

保留已有 `id`、`user_id`、`profile_id`、`field_key`、`field_value` 与时间字段。新增：

| 字段 | 类型 / 约束 | 用途 |
|---|---|---|
| `category` | enum：`PREFERENCE`、`CONSTRAINT` | 强制字段分类与 UI 分组 |
| `source` | enum：`PROFILE_FORM`、`PROPOSAL_CONFIRMATION` | 可解释来源；不记录 raw conversation |
| `status` | enum：`ACTIVE`、`SUPERSEDED` | append/replace 的当前版本语义 |
| `confirmed_at` | timestamptz nullable | proposal confirmation 时间 |
| `supersedes_fact_id` | FK self nullable | 版本链 |

添加 partial unique index：每个 `(user_id, field_key)` 最多一条 `ACTIVE` fact。迁移先回填已有数据为 `PROFILE_FORM` / `ACTIVE`，在核对重复数据后才添加 unique index。用户删除必须删除该事实链中仍含个人值的记录；audit 只保存 fact ID、field category、操作和关联 ID，不保存 value。

### 4.2 `memory_proposals`（新增）

| 字段 | 说明 |
|---|---|
| `id`, `user_id`, `profile_id` | owner 归属；外键 cascade 删除 |
| `field_key`, `proposed_value` | 仅 allow-listed、非敏感字段；Zod schema 验证 |
| `source` | MVP 固定 `BEHAVIOR_AGGREGATION` |
| `observation_count`, `confidence` | 可解释、非内容聚合元数据 |
| `status` | `PENDING`、`CONFIRMED`、`DISMISSED`、`EXPIRED` |
| `expires_at`, `resolved_at`, `resolved_fact_id` | 生命周期和确认关联 |
| `created_at`, `updated_at` | 标准时间戳 |

DB CHECK 与 service allow-list 必须双重拒绝敏感 field key。`CONFIRMED` transition 必须在同一 transaction 内创建/替换 active `preference_fact`，并仅可由 `user_id` 本人执行。

### 4.3 `trip_memory_facts`（新增）

| 字段 | 说明 |
|---|---|
| `id`, `trip_id`, `owner_user_id` | 仅当前 active member；Trip cascade 删除 |
| `kind` | `PERSONAL_OVERRIDE` 或 `GROUP_DECISION` |
| `field_key`, `field_value` | 固定 schema；禁止敏感字段出现在 group decision |
| `status` | `ACTIVE`、`SUPERSEDED`、`DELETED` |
| `source` | `OWNER_SAVE` 或 `GROUP_COMMAND` |
| `supersedes_fact_id`, `created_at`, `updated_at` | 版本与时间 |

`PERSONAL_OVERRIDE` 的 active uniqueness 为 `(trip_id, owner_user_id, field_key)`；`GROUP_DECISION` 的 active uniqueness 为 `(trip_id, field_key)`。删除后不保留值；历史 immutable snapshot 不回写，但受影响 active plan 必须 stale。

### 4.4 snapshot projection 契约

新增 server-internal Zod schema，形状固定为：

```ts
type MemoryProjection = {
  members: Record<string, {
    profileFacts: Record<string, unknown>;
    tripOverrides: Record<string, unknown>;
  }>;
  groupDecisions: Record<string, unknown>;
};
```

`authorized_data.memory` 只能由 `MemoryProjectionBuilder` 写入。任何 `field_key` 必须在服务端常量 `MEMORY_FIELD_CATALOG` 中注册其 value schema、敏感级别、允许 source、是否能自动建议、是否允许 consent export。未注册字段 fail closed。

## 5. 服务、Skill 与接口设计

### 5.1 新增服务

| 服务 | 主要方法 | 责任 |
|---|---|---|
| `PreferenceFactService` | `listActive`, `replace`, `delete` | owner-only 个人稳定事实、版本转换、受影响 Trip stale |
| `MemoryProposalService` | `list`, `confirm`, `dismiss`, `expire` | proposal 生命周期与 confirmation transaction |
| `BehaviorAggregationService` | `recordEligibleEvent`, `evaluateOwner` | 仅 allow-listed action 的确定性聚合；不读聊天表 |
| `TripConstraintProposalService` | `create`, `listForOwner`, `confirm`, `dismiss` | owner-only proposal 生命周期；确认触发事实 mutation。 |
| `TripConstraintFactService` | `listForOwner`, `listTeamVisible`, `replace`, `revoke` | 当前 Trip 约束、revision、visibility/strength 与 member authorization。 |
| `MemoryProjectionBuilder` | `buildForSnapshot` | consent-aware projection；唯一共享导出点 |
| `MemoryInvalidationService` | `staleTripsForPersonalFact`, `staleTripForTripFact` | 复用现有 stale transaction，避免遗漏依赖 |

### 5.2 修改的现有模块

- `services/consent-service.ts`：让 `buildAuthorizedData` 委托 `MemoryProjectionBuilder`，仍排除 passport；consent grant/revoke 使 projection-dependent plan stale。
- `routes/profiles.ts`：Profile form 写入与对应 stable facts 保持事务一致；敏感字段只保留此 route。
- `skills/personal/profile-memory-skill.ts`：改为 owner-only active fact read，不再以 Trip consent 为读取个人长期记忆的前置条件。
- `skills/personal/profile-change-proposal-skill.ts`：只允许显式 save 意图创建用户确认 proposal；不允许敏感 key。
- `policy/snapshot-policy.ts`、`policy/plan-output-validator.ts`、Shared Skills：接受已验证的 `authorized_data.memory` 结构，只允许引用投影路径。
- `services/planning-service.ts` / task acceptance：在 snapshot 创建时调用 projection builder；commit guard 重验 projection source 未变化；REPLAN 生成 `PROPOSED` plan，不能绕过 adoption vote 激活。
  - `schema.ts`、migrations、API contracts、Web `TravelApi`：添加类型与 DTO，禁止 client-supplied owner/user IDs。

### 5.3 REST API

所有 endpoint 均使用现有 Cognito/local auth、Fastify request context、严格 Zod schema 和统一 error envelope。所有 ID 从认证身份或 URL resource authorization 推导；请求体不得携带 `userId`。

| Endpoint | 行为 | 授权与状态 |
|---|---|---|
| `GET /profiles/me/memory` | 返回 owner 的 active facts 与 pending proposals，不返回行为原始证据 | owner-only |
| `PUT /profiles/me/memory/facts/:factId` | 替换一个非敏感 stable fact | owner-only；新 fact version + stale affected Trips |
| `DELETE /profiles/me/memory/facts/:factId` | 删除个人事实 | owner-only；移除未来 projection + stale affected Trips |
| `POST /profiles/me/memory/proposals/:proposalId/confirm` | 确认 pending proposal | owner-only；幂等终态返回；创建 fact |
| `POST /profiles/me/memory/proposals/:proposalId/dismiss` | 忽略 pending proposal | owner-only；幂等 |
| `GET /trips/:tripId/memory/me` | 返回 caller 的 current-Trip overrides 与其授权状态 | active member / owner-only data |
| `PUT /trips/:tripId/memory/me/overrides/:fieldKey` | 保存或替换 caller 的 Trip override | active member；stale active plan |
| `GET /trips/:tripId/memory` | 返回当前成员可见的 group decisions 与已授权投影摘要 | active member；不得返回私有 facts/proposals |
| `PUT /trips/:tripId/memory/group-decisions/:fieldKey` | 显式保存允许的 group decision | active member；service field allow-list；stale active plan |
| `DELETE /trips/:tripId/memory/:factId` | 删除 caller own override 或有权限的 group decision | active member；stale active plan |

`PUT` body 统一为 `{ "value": <schema-specific value> }`。返回 DTO 只包含 `id`、`fieldKey`、`value`（仅对有权调用者）、`source`、`status`、`updatedAt` 与必要的 proposal metadata。不得返回 `profileId`、行为事件引用、raw chat、snapshot 全文或其他成员私有数据。

## 6. 状态、事务与失效规则

| 触发动作 | 原子写入 | 必须后果 |
|---|---|---|
| form 创建/替换 personal fact | new ACTIVE fact + old SUPERSEDED + audit | stale 所有对该 field 有 active consent 且有 active plan 的 Trips |
| proposal confirm | proposal `CONFIRMED` + active fact version + audit | 同上；不可产生两条 active fact |
| proposal dismiss/expire | proposal terminal status + audit | 不影响 Trip 或 plan |
| Trip override/group decision change | fact version + audit | stale 当前 Trip active plan/confirmations |
| consent grant/revoke | consent state + audit | stale 当前 Trip；下一 snapshot 重新投影 |
| planning acceptance | immutable snapshot + task | projection version/源事实 version 写入 run guard |
| planning commit | plan persistence | 若 consent、source fact 或 trip memory 已改变，task `STALE`，不激活 plan |

所有写 command 接收客户端 idempotency key，复用现有 `idempotency_records`。proposal confirmation、删除和 trip memory 替换必须在数据库 transaction 内锁定目标行及关联 Trip/plan 行，避免并发确认或 stale race。

## 7. 可观测性、安全与删除

新增 audit actions：`MEMORY_PROPOSAL_CREATE`、`MEMORY_PROPOSAL_CONFIRM`、`MEMORY_PROPOSAL_DISMISS`、`PREFERENCE_FACT_UPDATE`、`PREFERENCE_FACT_DELETE`、`TRIP_MEMORY_UPDATE`、`TRIP_MEMORY_DELETE`、`MEMORY_PROJECTION_CREATE`、`MEMORY_INVALIDATION`。summary 仅允许 action、field category、source、status、count、Trip/plan/run correlation ID；禁止 value、value hash、chat text、nationality、证件或事件时间线。

新增指标：

- `memory_proposals_total{outcome,source}`；
- `memory_fact_mutations_total{operation,source}`；
- `memory_projection_build_total{result}`；
- `memory_invalidation_total{scope}`；
- `memory_proposal_pending_age_ms`。

标签只能使用上述有界枚举。新增 spans `memory.proposal.aggregate`、`memory.fact.mutate`、`memory.projection.build`，属性仅包含操作、结果、source、截断/失效布尔值；ID 仅作为 trace/log correlation context。

Profile、trip memory 或 proposal 的用户删除必须删除存储值和任何未确认的 proposal；不从 immutable historical snapshot、plan 或已完成 booking 物理回写，但这些记录永不向新 Agent run 导出。删除后必须 stale 仍活跃的依赖 plan。日志、outbox、idempotency 与 audit 不得含可恢复 value，因此无需对其执行内容回填。

## 8. 开发阶段、顺序与交付物

### Phase 0 - 契约与字段目录

1. 新建 `MEMORY_FIELD_CATALOG`，确定每个 field 的 schema、分类、敏感性、允许 source、proposal eligibility 与 consent export 行为。
2. 更新本方案、TECH_STACK、PRD、backlog、test scenarios、agent architecture、API/architecture 文档与 `.env.example`（如最终引入阈值配置）。
3. 先修复现有文档验证脚本/front-matter 漂移，使 `npm run docs:verify` 成为可用门槛。

**退出条件：** 没有未分类字段；敏感字段与自动聚合边界可由单元测试证明。

### Phase 1 - 数据库与纯领域服务

1. 增加 enums、表、约束、partial indexes 和 Drizzle schema；编写可重放 migration 与旧 `preference_facts` backfill。
2. 实现 `PreferenceFactService`、`MemoryProposalService`、`TripMemoryService` 与无 I/O 的 catalog validators。
3. 覆盖 owner isolation、active uniqueness、proposal terminal idempotency、sensitive deny、hard deletion 与 concurrent replacement。

**依赖：** Phase 0。
**退出条件：** migration 在空库和升级测试库均成功，服务不依赖 LLM、聊天或 Shared Agent。

### Phase 2 - 行为建议与个人 API/UI

1. 从有限的已确认产品 action 接入 `BehaviorAggregationService`；不扫描 `chat_messages`。
2. 实现个人 facts/proposals REST contracts、Profile memory UI、TanStack Query invalidation 与 confirm/dismiss 操作。
3. 为每个 action 增加审计、指标和 redaction regression tests。

**依赖：** Phase 1。
**退出条件：** suggestion 不能绕过确认进入 active fact 或任何 plan input。

### Phase 3 - Trip memory、consent projection 与 planning guard

1. 实现 Trip override/group decision routes、member authorization 与 UI。
2. 实现 `MemoryProjectionBuilder`，将其接入 `buildAuthorizedData`、snapshot creation、snapshot policy 和 plan validator。
3. 实现 personal/trip fact change 的跨 Trip invalidation；在 planning final commit 重验 projection 源版本。

**依赖：** Phase 1；Phase 2 的 facts contract。
**退出条件：** Shared Agent 仅能从 snapshot 读取 current-Trip authorized memory；变更 race 不能激活旧 plan。

### Phase 4 - Agent、端到端与发布验证

1. 更新 `profile.memory` / change-proposal Skills 与 Shared Skill input schema。
2. 执行 TS-H1、TS-H1e、授权撤回、Worker retry、并发 idempotency、cross-user/cross-Trip 和 telemetry leakage 回归。
3. 运行 API typecheck、lint、test、docs verification；如 Web 改动，运行 Web typecheck、lint、test。

**依赖：** Phase 2、3。
**退出条件：** 三名用户可完成 Profile suggestion -> confirmation -> Trip consent -> projection -> planning -> stale/replan 的端到端链路。

## 9. 关键风险与实施注意事项

| 风险 | 控制 |
|---|---|
| 行为推断将一次妥协当作长期偏好 | 固定 allow-list、至少两次独立 action、expiry、owner confirmation；不自动写 active fact。 |
| 个人记忆经 Team path 泄露 | Shared Agent 无 direct repository/Skill；projection builder + snapshot 是唯一导出点；跨 member/Trip tests。 |
| 事实更新让旧计划继续执行 | 在每个 personal/trip/consent mutation transaction 中 stale；planning commit re-check source versions。 |
| 版本链与删除冲突 | active partial unique index；delete 去除含值记录；audit 无 value；historical snapshot 不再导出。 |
| schema 漂移导致不受控字段进入 prompt | field catalog、Zod schema、snapshot validator 和 DB enum/CHECK 四层 fail-closed。 |
| 过早引入语义检索 | Phase 1-4 明确不引入 embedding/RAG；如未来需要，必须另立 ADR 并设计 per-fact consent-aware index deletion。 |

## 10. 必须覆盖的测试

除 `TS-H1e` 外，至少新增：

1. `PreferenceFactService`：field allow-list、敏感拒绝、版本替换、删除、跨 Trip stale scope。
2. `MemoryProposalService`：阈值、expiry、同 proposal 幂等、confirm/dismiss race、确认不重复创建 fact。
3. `TripMemoryService`：member scope、owner isolation、跨 Trip denial、group decision schema。
4. `MemoryProjectionBuilder`：仅 active consent、仅 current Trip、profile/override precedence、无 direct fact leakage。
5. planning integration：snapshot source 变更、撤回授权、run retry、final commit race 均终态 `STALE`。
6. observability：所有 memory value、proposal value、raw chat 和敏感字段均不出现在 audit、logs、traces、metrics、SSE、outbox 或 idempotency result payload。

验证命令：

```powershell
cd apps/api
npm run typecheck
npm run lint
npm test
npm run docs:verify

cd ../web
npm run typecheck
npm run lint
npm test
```
