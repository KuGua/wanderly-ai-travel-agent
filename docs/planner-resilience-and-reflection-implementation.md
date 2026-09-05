# 规划器韧性与有界反思实施规范

**状态：** 已批准，分阶段实施中（P0 门禁、review scope 与 research-summary 读取面已于 2026-09-03 落地；P1–P4 仍待实施）
**范围：** Shared/Personal 规划链路的门禁语义、provider 韧性策略、对话回合预算拆分，以及确定性 critic 驱动的有界 repair 循环。
**事实来源：** `TECH_STACK.md`、`docs/PRD.md`、`docs/backlog.md`、`docs/test-scenarios.md`、`docs/agent-architecture.md` 与本文件。本文件与 `docs/agent-architecture.md` §5/§6 冲突时，以本文件为准；与 `TECH_STACK.md` 的 MVP 边界冲突时，以 `TECH_STACK.md` 为准。
**不在范围内：** 自由 Agent-to-Agent 通信、常驻/自触发 Agent、向量库/RAG、Redis/Temporal/Step Functions、新的 provider 接入、真实支付或预订。

---

## 1. 固定决策与不变量

以下决策已确认，实施期间不再讨论。

1. **研究完整性与商业依据是两个独立门禁。** 「这一格搜过没有」与「这个方案有没有可引用的商业证据」不得由同一个布尔值表达。
2. **一个 provider 不可用不终结整轮规划。** 已尝试但 `UNAVAILABLE` 的能力降级为 `service_gap`，任务终态为 `COMPLETED_WITH_GAPS`。
3. **零商业证据的目的地不产出 plan。** 它产出不带商业 authority 的 research summary（`planning_research_results`，`result_plan_id = NULL`），不进入 `PROPOSED`，因而不进入 adoption vote、confirmation 与 booking sandbox。代码注释中反复引用的「Spec §10.6 —— 不给盲飞分支出方案」在 `docs/` 下已无对应章节（悬空引用）；**该规则自本文件起由 §1.3 与 §3.1 承载**，实施时应把相关注释的引用改指本文件。
4. **反思是确定性的。** critique 由服务端校验器产出，模型只负责按 critique 修正输出。模型的自我评价不得成为事实、授权或安全判断的来源。
5. **repair 预算与 tool 预算相互独立。** repair 轮次不消耗 `MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS`，反之亦然。
6. **重试只发生在无副作用的读路径。** 声明了 `retry` 策略的 Skill 不得持有任何写 scope；注册期强制。
7. **critique 不回显模型值与快照内容。** 只允许稳定 code、字段路径和固定模板文案，与 `PlanValidationError.violations` 的既有纪律一致。
8. **本方案不新增数据库迁移。** 所有状态复用既有表与枚举。
9. **PlanReviewSkill 不在本期实施。** `review` 的 policy scope 同期收窄为只读，消除休眠越权面。

---

## 2. 技术栈与系统架构

### 2.1 复用（不改动）

Next.js/React/TanStack Query · Fastify/TypeScript · PostgreSQL + Drizzle · 进程内 durable Worker（PG lease + transactional outbox）· Skill Registry · 单一 `ModelGateway` 边界 · `snapshot-policy.ts` + `plan-output-validator.ts` 双层校验 · constraint snapshot / plan version / STALE / adoption vote / confirmation / idempotency 状态机 · OpenTelemetry + Pino。

**不引入任何新基础设施、新依赖或新外部服务。**

### 2.2 模块处置

| 处置 | 模块 | 改动要点 |
|---|---|---|
| 修改 | `services/flight-research-matrix-service.ts` | `complete` 语义对齐；新增 `hasCommercialFlightAuthority()` |
| 修改 | `services/planning-service.ts` | `beforeFinal` 双门禁；`generatePlan` 返回判别联合；research-summary 分支 |
| 修改 | `tasks/personal-trip-orchestrator-service.ts` | `missingDestinations` 由抛错改为 research-summary 分支 |
| 修改 | `agents/contracts.ts` + `agents/skill-registry.ts` | `Skill.retry` 契约与执行；注册期写 scope 校验 |
| 修改 | `agents/policy-gate.ts` | `review` scope 收窄为 `["snapshot:read"]` |
| 修改 | 7 个无重试 provider adapter | 接入统一韧性策略 |
| 修改 | `tasks/task-repository.ts` | retry 时延长 `expires_at`，并加生命周期上限 |
| 修改 | `tasks/handlers/conversation-task-handler.ts` | 回合预算拆分为 model / tool 两个时钟 |
| 修改 | `providers/llm-gateway.ts` | tool loop 增加 repair 分支 |
| 修改 | `apps/web` 文案与 research-summary 渲染 | 见 §8.3 |
| 新增 | `config/resilience-policy.ts` | 单一处声明每能力的 timeout / retry / 是否可降级 |
| 新增 | `services/plan-critique.ts` | 确定性 critic |
| 删除 | `apps/web/src/lib/api/http-travel-api.ts#getResearchResult` | 对应的 `/trips/:tripId/research-results` 路由从未存在，属死代码 |

### 2.3 目标数据流

```text
constraint snapshot
   │
   ▼
tool loop（maxTurns=8，已有）
   │  每次 tool 失败 → 结构化 UNAVAILABLE + service_gap + 失败记忆（已有，勿回退）
   ▼
beforeFinal
   ├─ Gate A 研究完整性：所有 cell ≠ MISSING
   │     失败 → FlightResearchIncompleteError（PLANNING_DATA_UNAVAILABLE，不可重试）
   ├─ （Gate B 商业依据已于 2026-09-05 移除，见 §3.1.1）
   └─ 输出 schema / policy / evidence 校验
         失败 → plan-critique → 回灌 → repair 预算（≤2）
                  预算耗尽 → 原错误照常抛出
   │
   ├─ 通过 ────► PROPOSED plan + service_gaps + COMPLETED_WITH_GAPS/COMPLETED
   └─ 零可引用证据 ─► planning_research_results（result_plan_id = NULL）
                      + COMPLETED_WITH_GAPS
                      经 GET /trips/:tripId/research/latest 呈现
```

---

## 3. 阶段 P0 — 门禁语义重构

> **实施记录（2026-09-03）：** 航班矩阵已改为以 `MISSING` 判定研究不完整，
> 并以独立 LIVE evidence 门禁判断目的地是否具备商业依据。Personal Trip
> Orchestrator 在没有任何合格目的地时写入 plan-less research summary；review
> scope 已收窄为只读；web 已删除不存在的 historical research-result 客户端路径，
> 复用 `/research/latest`。本文件后续 P1–P4 的 retry、deadline 与 repair 工作尚未落地。

### 3.1 `flight-research-matrix-service.ts`

当前 `evaluateFlightResearchCompleteness` 返回 `complete: cells.every(c => c.outcome === "LIVE")`（第 46 行），与 hotel（第 36 行）、activities（第 49 行）、accommodation（第 41 行）、navigation（第 60 行）的 `every(c => c.outcome !== "MISSING")` 相反。

**改动 1 —— 对齐语义：**

```ts
return { complete: cells.every((cell) => cell.outcome !== "MISSING"), cells };
```

**改动 2 —— 新增商业依据判定：**

```ts
/**
 * 商业依据门禁。研究完整性只说明每一格都被尝试过；一个 plan 能不能对某个
 * 目的地作出商业主张，取决于该目的地是否存在至少一格 LIVE 证据。
 * 二者分离前，一格 UNAVAILABLE 会以 PLANNING_DATA_UNAVAILABLE 终结整轮。
 */
export function hasCommercialFlightAuthority(
  cells: ReadonlyArray<FlightResearchCell>,
  destinationId: string,
): boolean {
  return cells.some((cell) => cell.destinationId === destinationId && cell.outcome === "LIVE");
}
```

`FlightResearchIncompleteError` 保留，语义收窄为「工具循环没有覆盖到某一格」——这是循环自身的缺陷，仍为不可重试的 `PLANNING_DATA_UNAVAILABLE`。

`flightMatrixToGaps()`（第 55 行）在本次改动前不可能收到 `UNAVAILABLE` 单元格，因此在 plan 路径上恒返回空数组。改动后它开始生效，无需修改。

### 3.2 `planning-service.ts`

**`beforeFinal` 顺序（约第 900–935 行）：**

```ts
const matrix = await evaluateFlightResearchCompleteness({ ... });
if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);   // Gate A
if (!hasCommercialFlightAuthority(matrix.cells, params.destination)) {          // Gate B
  throw new CommercialAuthorityMissingError("flight", params.destination);
}
```

`CommercialAuthorityMissingError` 是本模块内部的控制流信号，**不得逃逸到 Worker**：`generatePlan` 捕获它并切换到 research-summary 分支。

`validateProviderCoverage`（第 351 行）保持不变——`missingOrigins` 是结构性缺口，仍为硬门禁。

#### 3.1.1 Gate B 已移除（2026-09-05，产品决定）

**上文 §3.1/§3.2 描述的 Gate B 不再存在。** 用户决定：航班 provider 返回 4xx 也必须产出方案。

理由来自 trip `8a634324`：serpapi 对每一次航班搜索返回 HTTP 400（我们的请求被拒，不是「这条航线没航班」），Shanghai 因此没有 LIVE 航班证据，Gate B 把整轮降级为 research summary——**而同一轮已经拿到了 16 条真实住宿、5 条带价格与评分的真实活动**。一个能力被拒，把其余所有已验证的结果一起拿走了。

新的判定：

| 旧 | 新 |
|---|---|
| 目的地需同时有 LIVE 航班**与**住宿覆盖 | 目的地有**任一**能力的 LIVE 证据即可（`coverage.evaluatedDestinations`） |
| 推荐目的地缺住宿覆盖 → 抛 `PLANNING_DATA_UNAVAILABLE` | 记为 `stay/NO_RESULTS` gap |
| 目的地无 LIVE 航班 → 不产出 plan | 记为 `flight/NO_RESULTS` gap |
| `planOutputSchema.flights` 为 `.min(1)` | 允许空数组 |
| `validateProviderCoverage` 对任何未覆盖 origin 硬拒 | 零航班时放行（整个能力不可用）；**有航班但某 origin 未覆盖仍硬拒**——那意味着告诉一位成员有路可走、另一位没有 |

保留的下限：**方案必须引用至少一条 provider 证据**。所有能力可以各自不可用，但一张只写着目的地名字、不含任何可验证事实的卡片不是方案，是 `AGENTS.md` 禁止的 `Demo data` 形状。这类运行仍写 research summary，由 `PlanEvidenceUnavailableError`（原 `CommercialAuthorityMissingError`）触发，reason 为 `NO_CITABLE_EVIDENCE`。

`hasCommercialFlightAuthority()` 随之成为死代码并已删除；上文 §3.1「改动 2」的代码块是历史记录，不再是当前实现。

**`generatePlan` 返回值改为判别联合：**

```ts
export type PlanSynthesisOutcome =
  | { outcome: "PLAN"; planId: string; gaps: ServiceGapInput[] }
  | { outcome: "RESEARCH_SUMMARY"; researchResultId: string; gaps: ServiceGapInput[];
      reason: "NO_COMMERCIAL_FLIGHT_AUTHORITY" | "NO_STAY_COVERAGE" };
```

research-summary 分支必须与既有 plan 分支保持同等的事务纪律：

- 在同一事务内写 `planning_research_results`（`status = "COMPLETED_WITH_GAPS"`、`result_plan_id = NULL`）与 `RESEARCH_RESULT_RECORDED` audit；
- 在同一事务内以 lease 守卫把 `agent_task_runs` 置为 `COMPLETED_WITH_GAPS`，`result_plan_id = NULL`，`error_code = NULL`；
- **不写 `itinerary_plans` 行**，不触碰任何既有 plan 的状态；
- 已收集的 `provider_offers` / `source_evidence` 照常持久化——它们是本轮真实取得的证据。

调用方（`personal-trip-orchestrator-service.ts` PROPOSE_PLAN 分支、`tasks/handlers/planning-task-handler.ts`）按 `outcome` 分派；`RESEARCH_SUMMARY` 时跳过 solo auto-accept，因为没有可采用的 plan。

### 3.3 `personal-trip-orchestrator-service.ts`

第 221 行附近的第二处硬拒绝：

```ts
if (coverage.missingDestinations.length > 0) { throw ... PLANNING_DATA_UNAVAILABLE }
```

改为同一模式：只有当**推荐目的地本身**缺住宿覆盖时才降级为 research-summary（`reason: "NO_STAY_COVERAGE"`）；其余候选缺覆盖记为 `service_gap`，不阻断合成。

#### 3.3.1 Gap code 的归属：供应商 vs 我们自己（2026-09-05 补）

同一个 catch 还承担了「把失败的能力翻译成 gap code」这件事，而它的 `classifyError`
按 `err.message` 做子串匹配、兜底 `UPSTREAM_FAILURE`。`SkillError` 是带类型码的，
文本匹配意味着任何不含关键词的失败都会被报成供应商故障。

Trip `8a634324`（2026-09-05）：`accommodation` 与 `places` 的
`provider_search_runs` 都是 `LIVE`、`provider_offers` 落了 16 条真实住宿，
而共享方案面写着「服务提供方暂时不可用」。真实原因是两个 skill 的输出契约拒绝了
自己的合法结果（见 `docs/test-scenarios.md` TS-SKILL-OUTPUT-CONTRACT），抛出的
`OUTPUT_INVALID` 的文本不含任何关键词，于是掉进兜底。这与本仓库
`docs/shared-agent-findings.md` #21 是同一类错误：有类型码就不要读文本。

固定下来的语义：

| 来源 | Gap code |
|---|---|
| 供应商本身故障 / 网络 / 5xx | `UPSTREAM_FAILURE` |
| 供应商超时 | `UPSTREAM_TIMEOUT` |
| 配额 | `RATE_LIMITED` |
| 供应商 4xx 拒绝（我们的参数） | `PROVIDER_REQUEST_REJECTED` |
| **我们自己的 Skill 契约拒绝了合法结果** | **`SKILL_CONTRACT_VIOLATION`** |
| 授权/scope/快照缺失，调用未发出 | `SEARCH_CONSTRAINTS_INCOMPLETE` |

`SKILL_CONTRACT_VIOLATION` 是 `InternalGapCode`，刻意不在
`ProviderUnavailableCode` 内：没有任何 adapter 可以产出它，只有编排层给自己的失败
分类时会产生。它必须被**端到端**接受——服务端持久化的 `serviceGapSchema`、
Web 的镜像 enum、以及详情页的文案表——否则新值会在某一层解析失败并让整个界面变白，
这正是 `TS-PROVIDER-4XX` 已经记过的陷阱。

同一处 catch 此前**不记任何日志**，所以这类失败在 worker 日志里完全不可见，
唯一的痕迹是那条说谎的 gap code。现在编排层与 skill registry 的终态失败分支各记一条
`logSafeRuntimeEvent`，只带受控字段（能力/skill 名、类型码、attempt、耗时），
不带异常消息——异常消息可能夹带供应商或用户文本。

#### 3.3.2 Turn 预算耗尽降级为 research summary（2026-09-06）

`TOOL_CALL_MAX_TURNS` 原本经 `agent-task-worker.ts` 的 `classifyTaskError` 判为
不可重试 → run `FAILED`，不写 summary、不写 plan。

Trip `24a0799f`（2026-09-05）：8 次 provider 搜索 7 次 LIVE，库里落了
**28 条航班 offer、10 条 Nuitee 酒店报价、16 条住宿、4 条活动**，
`planning_research_results` 0 行、`itinerary_plans` 0 行，屏幕上只有
「规划过程中调用供应商的时间用完了」。

日志里的原因很清楚：模型在 turn 1 并行发了五个调用（两次 flight.search 拿到 LIVE、
hotel.search 拿到 LIVE、accommodation.discover 与 activities.search 因一次性守卫
被拒），随后 **turn 2–10 连续五次重复调用 flight.search**，在已经做完的那两格之间
来回横跳。`flightResultCache` 让这些重复 0ms 返回、不花配额，**但每次仍然消耗一个
turn**。`appendFlightProgress()` 每轮都在推「Do not call flight.search again」，模型不听。

**Turn 预算耗尽是模型没能停手，不是这一轮什么都没找到。** 与 §3.1.1 的判断同源：
局部问题不得升级为整轮失败并丢弃已验证的证据。`generatePlan` 现在把
`ModelGatewayError{code: "TOOL_CALL_MAX_TURNS"}` 与 `PlanEvidenceUnavailableError`
走同一条 `persistResearchSummary` 分支，reason 为 `TOOL_BUDGET_EXHAUSTED`，
run 落 `COMPLETED_WITH_GAPS`。

**不产出 plan 是对的**：模型没有给出选择，我们不能替它合成一个推荐——那是编造。
但它一路取得的证据必须能被看见。

### 3.4 `policy-gate.ts`

```ts
review: ["snapshot:read"],   // 移除 "plan:write:propose"
```

`docs/agent-architecture.md` §3 已声明 review「无 DB/tool write 权限」。当前无 review skill 注册，此改动零运行时风险。

**必须同批修改** `apps/api/src/skills/REVIEW.md`：该文件声明 `source-of-truth: ../agents/policy-gate.ts`，其正文逐字引用了 `review: ["snapshot:read", "plan:write:propose"]`，而 `npm run docs:verify`（CI 的 `apps-api.yml:70`）校验文档中枚举的 allow-list 确实存在于源文件。只改其一必然导致 CI 失败。REVIEW.md 中「When added, each must ... declare `allowedTools: ["snapshot:read", "plan:write:propose"]`」一句同样需要改写为只读 scope。

### 3.5 Web 层

`apps/web/src/components/explore/travel-agent-chat.tsx` 第 1464–1488 行的 errorCode 映射已存在（`docs/shared-agent-findings.md` #13 记为「未修」，实际已修，见 §9）。本阶段需要：

| 键 | 动作 | 说明 |
|---|---|---|
| `planningDataUnavailable` | 改写 | 现文案专指「房价没能拿到」；Gate A 失败后它的语义是「研究没有覆盖到某条航线」 |
| `planningCompletedWithGaps.message` / `.detail` | 新增 | `COMPLETED_WITH_GAPS` 且有 plan 时的横幅，按 `service_gaps` 的 capability 列出缺口；必须使用嵌套对象，不能把 `.` 写进 JSON key |
| `planningResearchSummaryOnly.message` / `.reasonFlight` | 新增 | `result_plan_id = NULL` 时的横幅，说明查到了什么、为什么没有方案；必须使用嵌套对象，不能把 `.` 写进 JSON key |
| `planningToolBudgetExhausted` | 新增 | `TOOL_CALL_MAX_TURNS` 当前落入通用 `planningFailed` |

`en.json` 与 `zh.json` 必须同批提交（`docs/i18n.md` 的 parity 要求）。

read surface 复用既有 `GET /trips/:tripId/research/latest`（`routes/research.ts:214`）——它已是 member-scoped、mode-agnostic，返回 `serviceGaps`、`offers` 与可空的 `resultPlanId`，**无需新增端点**。web 侧 `useLatestResearchResult` 已存在，只需处理 `resultPlanId === null` 分支。

**Web 镜像必须逐字段对齐（2026-09-05 补）。** `apps/web` 的 `researchResultSchema` 是 `.strict()` 且此前缺 `offers`，而服务端两个 research 端点都恒定发送该数组（API schema `.default([])`）。结果是**每一个**响应都解析失败：共享方案面的 gaps 面板静默丢掉能力清单，`/trips/:id/runs/:runId` 详情页整页变成一句通用错误——对着一次它已经拿到手的运行结果。同批还补齐了能力枚举缺失的 `places` / `readiness`。服务端的 `serviceGaps` 在响应契约里是 `z.record` 松类型，Web 侧是严格枚举；这条不对称是这类缺口的温床，任何一侧新增取值都必须同批更新另一侧（见 `docs/test-scenarios.md` TS-GAP-ATTRIBUTION）。

---

## 4. 阶段 P1 — 韧性策略统一

### 4.1 `config/resilience-policy.ts`（新增）

```ts
export interface CapabilityResiliencePolicy {
  readonly capability: ServiceCapability;
  readonly timeoutMs: number;
  /** 1 = 不重试。上限 3。 */
  readonly maxAttempts: number;
  readonly retryOn: readonly ProviderUnavailableCode[];
  readonly backoff: { readonly baseMs: number; readonly jitterMs: number; readonly rateLimitedMs: number };
  /** false 表示该能力缺失是结构性缺口，不可降级为 gap。 */
  readonly degradesToGap: boolean;
}
```

统一判定规则：

| 类别 | `UNAVAILABLE.reason` | 是否重试 |
|---|---|---|
| 瞬态 | `UPSTREAM_TIMEOUT`、`UPSTREAM_FAILURE` | 是，最多 1 次，`baseMs` + jitter |
| 配额 | `RATE_LIMITED` | 是，但使用 `rateLimitedMs`（默认 20000）自有时钟，不用指数退避 |
| 确定性 | `NO_RESULTS`、`NOT_CONFIGURED`、`SEARCH_CONSTRAINTS_INCOMPLETE`、`INVALID_PROVIDER_RESPONSE`、`PROVIDER_NOT_APPROVED` | 否 |

`RATE_LIMITED` 的处理与 `providers/llm-gateway.ts:230` 已验证的 `isRetryableUpstreamError` 纪律一致（`docs/shared-agent-findings.md` #21/#23）：**每分钟配额立即重试只是再花一次配额。**

### 4.2 Skill 契约扩展

`docs/agent-architecture.md` §3 声明 Skill 契约包含「timeout / retry / fallback 规则」，而 `agents/contracts.ts:185` 的 `Skill<I,O>` 只有 `timeoutMs`。补齐：

```ts
export interface SkillRetryPolicy {
  readonly maxAttempts: number;                 // 1..3
  readonly retryOn: readonly SkillErrorCode[];  // TIMEOUT | NETWORK | UPSTREAM_5XX | UPSTREAM_FAILURE
  readonly backoffBaseMs: number;
  readonly rateLimitedDelayMs: number;
}

export interface Skill<I, O> {
  // ...既有字段
  readonly retry?: SkillRetryPolicy;
}
```

`skill-registry.ts` 的执行要求：

1. **每次 attempt 独享一个完整的 `timeoutMs` 时钟**，不共用；
2. 调用方 `options.signal` 触发的 abort **永不重试**（那是取消，不是能力不可用）；
3. `INPUT_INVALID` / `OUTPUT_INVALID` / `POLICY_DENIED` / `TOOL_NOT_ALLOWED` **永不重试**；
4. `SkillInvocationRecord` 增加 `attempts: number`，进入既有 audit summary；
5. **注册期强制**：`registerSkill` 在 `skill.retry !== undefined` 且 `skill.allowedTools` 含任一写 scope（`plan:write:*`、`bookings`、`places:write` 等）时抛 `SkillError("POLICY_DENIED")`。这条把「重试只发生在无副作用读路径」变成编译-注册期不变量，而不是靠约定。

据此，`trip-place-skill.ts`（`places.adopt`，有写副作用）不得声明 retry；`flight.search` / `hotel.search` / `activities.search` / `places.search` / `navigation.route` / `accommodation.discover` 可以。

### 4.3 Adapter 接入

当前 11 个 adapter 中仅 3 个有 `maxRetries`（nuitee-hotel、serpapi-hotel、viator-mcp-activities）。下列 7 个只有 timeout，需接入统一策略：

`amadeus-flight-provider` · `serpapi-flight-provider` · `flightapi-flight-provider` · `ors-place-provider` · `ors-navigation-provider` · `opentripmap-place-provider` / `opentripmap-accommodation-provider` · `amadeus-transfer-provider`

三个航班 adapter 优先——航班是唯一挂在商业依据门禁上的能力。已有重试的 3 个改为从 `resilience-policy.ts` 读取参数，行为不变。

### 4.4 任务生命周期（`task-repository.ts`）

`expires_at` 在 accept 时写死为 `now + queueTtlSeconds`（第 148/282/381/550 行），重试只改 `next_attempt_at`，reaper 到点标 `EXPIRED`（第 1152 行）。加了重试与 repair 后这个 5 分钟天花板会先失效。

`failOrRetryTask` 与 `failPersonalResearchTask` 在 requeue 时：

```ts
expiresAt: new Date(Math.min(
  Date.now() + agentTaskConfig.queueTtlSeconds * 1000,
  run.createdAt.getTime() + agentTaskConfig.maxLifetimeSeconds * 1000,
)),
```

`maxLifetimeSeconds` 默认 900。上限从 `created_at` 计算，任务无法被无限续期。

---

## 5. 阶段 P2 — 对话回合预算拆分

`tasks/handlers/conversation-task-handler.ts:558` 用单个 `setTimeout(travelConversationSkill.timeoutMs)`（15000ms）罩住「建上下文 + 模型 + 工具调用 + 模型收尾」。酒店 skill 自身 `timeoutMs` 即为 15000ms，因此一次慢 provider 必然吃光整个回合预算，结果被报成模型故障（`docs/shared-agent-findings.md` #32：价格已查到并落库，屏幕显示「连不上模型」）。

### 5.2 模型预算必须可配置，且超时不得被误报为上游故障

**2026-09-05 实测。** `travelConversationSkill.timeoutMs` 曾硬编码 15000ms。同一会话连续两轮的**纯模型时间**（工具窗口已被 `withPausedModelBudget` 排除）分别为 15.0s 与 15.0s：前者压线返回，后者被本 deadline 中止，用户看到降级文案「I can't reach the conversation model right now」。贴着上限即为系统性失败，不是偶发。

**改动一：预算移入 `tasks/config.ts`** 的 `conversationModelBudgetMs`（`CONVERSATION_MODEL_BUDGET_MS`，默认 30000，区间 5000–90000）。运维无需改代码即可调整。注意 `Skill.timeoutMs` 有两个消费者——本 deadline 与 `skill-registry.ts` 的每次尝试超时——移入配置正是为了让两者同步。

若 30s 也被打满，正确做法是收窄上下文（`CONVERSATION_CONTEXT_MAX_TURNS` / `_MAX_CHARS`），而非无限抬高预算：模型预算 + 工具预算之和必须显著低于 `CONVERSATION_TURN_HARD_CAP_MS`，否则真正触发的会是硬上限。

**改动二：本 deadline 造成的中止必须归类为 `TIMEOUT` 并停止重试。**

`onAbort` 特意把 `error.name` 设为 `AbortError` 以便 `classifyError` 识别，但 **OpenAI SDK 会吞掉被中止的 signal，抛出自有的 `Error("Request was aborted.")`**，其 `name` 为普通 `"Error"`。于是该分支落空、归入兜底的 `UPSTREAM_FAILURE`——把我们自己的预算超时报成供应商故障。更糟的是 `TIMEOUT` 本身位于 `isRetryableUpstreamError` 列表内，因此剩余重试全部打在同一个已中止的 signal 上，立即失败并白白消耗退避等待（实测：15s 预算耗尽后又空转 3 次、约 1.9s）。

修法是以 **signal 本身**为权威，而非匹配错误文案：`llm-gateway.ts` 的 `abortedByCaller(params.signal)` 在三处重试循环（`generateStructuredPlan`、`generateConversationReply`、`streamConversationReply`）的 catch 开头判定，命中即置 `TIMEOUT` 并 `break`。`classifyError` 另保留一条 `/\baborted\b/i` 文案兜底，供无 signal 可用的调用点使用。

---

### 5.1 预算模型

实现为扩展既有的 `createTurnDeadline`（`conversation-task-handler.ts`），而不是新建模块——它已经拥有暂停语义、硬上限与可注入时钟，唯一缺的是工具聚合预算：

```ts
createTurnDeadline(params: {
  modelBudgetMs: number;      // = travelConversationSkill.timeoutMs = CONVERSATION_MODEL_BUDGET_MS，默认 30000
  toolBudgetMs?: number;      // CONVERSATION_TOOL_BUDGET_MS，默认 20000
  hardCapMs?: number;         // CONVERSATION_TURN_HARD_CAP_MS，默认 120000
  onAbort: (reason: string) => void;
  isAborted: () => boolean;
  now?: () => number;
}): {
  withPausedModelBudget: <T>(run: () => Promise<T>) => Promise<T>;
  isToolBudgetExhausted: () => boolean;
  clear: () => void;
}
```

三个时钟及其规则：

- **model 时钟**：`withPausedModelBudget` 在每次 tool dispatch 期间暂停它，慢 provider 花的是自己的时间，不是模型的。跨多次暂停累计消耗，不会重置。
- **tool 预算**：暂停窗口本身就是 dispatch 窗口，因此它同时是计量单位——**不再单独调用 `consumeTool`，否则同一次调用会被记两遍**。dispatch 抛错也照常计费：失败得慢的 provider 一样花掉了时间。耗尽后 `dispatchTool` **返回 `UNAVAILABLE / TOOL_BUDGET_EXHAUSTED`，不 abort 任何东西**——与 `planning-service.ts` 的 `dispatchPlanningTool` 同一纪律。
- **硬上限**：纯墙钟，永不暂停，保证一个永不应答的 provider 也拖不住回合。

回合的两个时钟与 task abort 桥接都属于本回合，必须在 `finally` 中 `clear()` 并摘除监听器；成功路径同样要走这一步。

### 5.2 有证据但无回复的降级

回合结束时若 `isEvidenceBacked()` 为真而模型调用失败，**不得**报「连不上模型」。服务端按确定性模板持久化一条 ASSISTANT 消息，只渲染已落库证据：capability、条数、provider 名与 `captured_at`。

这不是模型 fallback，也不构成杜撰事实——它渲染的是 `personal_research_evidence` 中真实存在的行。禁止在此模板中出现任何模型生成文本、推断价格或未采集字段。

对应新增 i18n 键 `conversationEvidenceWithoutReply`（en/zh 同批）。

---

## 6. 阶段 P3 — 确定性 critic 与有界 repair

### 6.1 已验证的先例

`providers/llm-gateway.ts:977` 附近，最终 JSON schema 校验失败时代码不抛错，而是把失败的 **issue path**（仅路径，不回显值）塞回消息并 `continue`。本阶段把这一已验证模式从 schema 校验推广到 coverage / policy / evidence 校验。

### 6.2 `services/plan-critique.ts`（新增）

```ts
export type PlanCritiqueCode =
  | "COVERAGE_INCOMPLETE"
  | "EVIDENCE_UNBOUND"
  | "SNAPSHOT_FIELD_UNAUTHORIZED"
  | "SCHEMA_INVALID";

export interface PlanCritique {
  readonly code: PlanCritiqueCode;
  /** 稳定字段路径，来自 violations；不含模型值。 */
  readonly fieldPaths: readonly string[];
  /** 固定模板，按 code 选择；不拼接任何运行时数据。 */
  readonly hint: string;
}

export function toCritiques(error: unknown): PlanCritique[] | null;
export function renderCritiqueMessage(critiques: readonly PlanCritique[]): string;
```

**隐私红线：** critique 的每一个字段都必须能通过 `PlanValidationError.violations` 的既有审查标准——稳定 code、字段路径、低风险原因，绝不回显模型值或 snapshot 私密内容（`docs/agent-architecture.md` §6）。`toCritiques` 对无法安全降解的错误返回 `null`，此时按原错误抛出，不进入 repair。

`CommercialAuthorityMissingError` **不产生 critique**：那是数据缺失，不是模型可修正的输出缺陷；它走 §3.2 的 research-summary 分支。

### 6.3 tool loop 改动（`llm-gateway.ts#generateStructuredPlanWithTools`）

新增参数：

```ts
repairBudget?: number;                                   // 默认 MODEL_GATEWAY_PLAN_REPAIR_BUDGET
onValidationFailure?: (error: unknown) => PlanCritique[] | null;
```

循环改动：

1. 循环上界由 `maxTurns` 改为 `maxTurns + repairBudget`；
2. 维护 `repairUsed`，**repair 迭代递增 `repairUsed` 而不递增 `turn`** —— 保证 repair 不侵占正常收敛预算；
3. `await params.beforeFinal?.()` 与最终输出校验包在 try/catch 中：捕获后调用 `onValidationFailure`；返回非空且 `repairUsed < repairBudget` 时，push 一条 system 消息（`renderCritiqueMessage` 的输出）、`repairUsed++`、`continue`；否则原样抛出；
4. 每次 repair 记录 `logSafeRuntimeEvent`：`component: "llm"`, `event: "repair"`, `errorCode: critique.code`。

**注意：** repair 后模型可能重新调用工具。既有的失败调用记忆（`planning-service.ts` 的 `failedToolCalls`）与 flight cell 缓存继续生效，repair 不会放大 provider 调用量。

### 6.4 运行时限

新增 `PLANNING_RUN_DEADLINE_MS`（默认 180000）。`planning-task-handler` / orchestrator 用它构造一个与 Worker `abortController.signal` 合并的 signal，作为整轮规划的独立墙钟。它先于 `expires_at` 生效，使超时表现为可诊断的 `TIMEOUT` 而不是被 reaper 静默标记 `EXPIRED`。

---

## 7. 数据模型

**本方案不新增任何数据库迁移。** 全部复用：

| 表 / 枚举 | 用法 | 是否改动 |
|---|---|---|
| `planning_research_results` | research summary；`result_plan_id` 可空 | 否（既有列已支持） |
| `research_result_status` | `COMPLETE` / `COMPLETED_WITH_GAPS` | 否 |
| `provider_search_runs` | 矩阵单元格来源 | 否 |
| `agent_task_runs.expires_at` | retry 时续期，上限自 `created_at` 计 | 仅写入行为变化 |
| `agent_task_runs.status` | `COMPLETED_WITH_GAPS` 已在枚举中 | 否 |
| `itinerary_plans` | research-summary 分支不写入 | 否 |

`service_gaps` 的形状受 `serviceGapSchema`（`planning-research-result-service.ts:36`）约束：`{ capability, code, destinationId? }`，`.strict()`，上限 32 条。坐标、原始 payload 与自由文本永不进入该列。

---

## 8. 接口与契约

### 8.1 内部接口变更

| 符号 | 变更 | 影响调用方 |
|---|---|---|
| `evaluateFlightResearchCompleteness().complete` | 语义变更 | `planning-service.ts` |
| `hasCommercialFlightAuthority()` | 新增 | `planning-service.ts` |
| `generatePlan()` | 返回 `PlanSynthesisOutcome` | `personal-trip-orchestrator-service.ts`、`planning-task-handler.ts` |
| `Skill.retry` | 新增可选字段 | 全部 skill 定义（可选，默认不重试即现有行为） |
| `invokeSkill()` | 内部增加 attempt 循环 | 无签名变化 |
| `generateStructuredPlanWithTools()` | 新增 `repairBudget` / `onValidationFailure` | `planning-service.ts` |

### 8.2 HTTP 接口

**不新增、不修改任何端点。** `GET /trips/:tripId/research/latest`（`routes/research.ts:214`）已满足 research-summary 的读取需要。

`apps/web/src/lib/api/http-travel-api.ts:678` 的 `getResearchResult` 指向从未实现的 `/trips/:tripId/research-results`，连同 `useResearchResult` hook 一并删除（AGENTS.md 要求删除不被任何运行路径引用的死代码）。

### 8.3 配置与环境变量

新增项必须同批更新 `apps/api/.env.example`（AGENTS.md 配置契约）：

```bash
# 有界 repair：critique 回灌的最大次数，独立于 tool 预算
MODEL_GATEWAY_PLAN_REPAIR_BUDGET=2
# 整轮规划的独立墙钟，先于 AGENT_TASK_QUEUE_TTL_SECONDS 生效
PLANNING_RUN_DEADLINE_MS=180000
# 任务自 created_at 起的生命周期上限，防止重试无限续期
AGENT_TASK_MAX_LIFETIME_SECONDS=900
# 对话回合的工具聚合预算。硬上限沿用 CONVERSATION_TURN_HARD_CAP_MS 常量。
CONVERSATION_TOOL_BUDGET_MS=20000
# 对话回合的模型墙钟（Skill 的 timeoutMs 由它提供）。见 §5.2。
CONVERSATION_MODEL_BUDGET_MS=30000
# Provider 重试次数（1 = 单次重试；0 = 不重试）
AMADEUS_FLIGHT_MAX_RETRIES=1
SERPAPI_FLIGHT_MAX_RETRIES=1
FLIGHTAPI_FLIGHT_MAX_RETRIES=1
ORS_PLACE_MAX_RETRIES=1
ORS_DIRECTIONS_MAX_RETRIES=1
OPENTRIPMAP_MAX_RETRIES=1
AMADEUS_TRANSFER_MAX_RETRIES=1
```

`MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS` 保持 8。有效循环上界为 `8 + MODEL_GATEWAY_PLAN_REPAIR_BUDGET = 10`。

---

## 9. 可观测性

新增指标必须遵守既有 allow-list 纪律：**不得以 trip/user/plan/run/correlation ID、model name 或自由文本作为 label。**

| 指标 | 类型 | Label | 用途 |
|---|---|---|---|
| `planning_gate_total` | counter | `gate`（`research_completeness`\|`commercial_authority`）、`outcome`（`pass`\|`degraded`\|`failed`） | 区分「循环没搜」与「数据没有」 |
| `plan_repair_total` | counter | `outcome`（`repaired`\|`exhausted`）、`code`（critique code） | 判断 repair 是否值得保留 |
| `provider_retry_total` | counter | `provider`、`outcome`（`recovered`\|`exhausted`） | 重试的实际收益 |
| `conversation_budget_exhausted_total` | counter | `budget`（`tool`\|`model`） | #32 是否复发 |

日志：repair 事件用 `component: "llm"` / `event: "repair"`；门禁降级用 `component: "planner"` / `event: "gate"`。二者均只记 code 与能力名。

Audit：research-summary 分支复用既有 `RESEARCH_RESULT_RECORDED`，summary 仍只含 `status`、`gapCount`、排序后的 `capabilities`。

**上线后需要回答的两个问题**（决定 P3 是否保留、§10 的预算是否需要调整）：

1. `agent_task_runs` 的 `error_code` 分布中，`PLANNING_DATA_UNAVAILABLE` 占比是否下降；若仍占压倒多数，瓶颈是受控机场参考数据只有 5 个（`docs/shared-agent-findings.md` #22），应转向补数据而非加深反思。
2. 一次成功 run 实际消耗几轮（日志 `component: "tool"` 的 `attempt` 字段）。若正常收敛已需 ≥6 轮，需在 repair 生效前先提高 `MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS`。

---

## 10. 实施阶段、顺序与依赖

| 阶段 | 内容 | 依赖 | 预估 | 可独立合并 |
|---|---|---|---|---|
| **P0** | §3 全部：矩阵语义、双门禁、`generatePlan` 判别联合、orchestrator 分支、review scope 收窄、web 文案与 research-summary 渲染 | 无 | 0.5–1 天 | 是 |
| **P1** | §4 全部：`resilience-policy.ts`、Skill retry 契约与注册期校验、7 个 adapter 接入、`expires_at` 续期 | P0（否则重试只是把同一个硬失败重放三次） | 1 天 | 是 |
| **P2** | §5 全部：回合预算拆分、有证据无回复的降级 | P1（复用 `resilience-policy` 的时长常量） | 1 天 | 是 |
| **P3** | §6 全部：`plan-critique.ts`、tool loop repair 分支、`PLANNING_RUN_DEADLINE_MS` | P0（门禁不修，循环走不到需要反思的地方）+ P1（`expires_at` 不续期，repair 会撞 TTL） | 1–2 天 | 是 |
| **P4** | §9 指标与日志 | P0–P3 各自阶段内同批落地 | 含在各阶段 | — |

**PlanReviewSkill 本期不实施。** 当前模型为 `gemini-3.1-flash-lite`，由它评审自身输出的质量增益不足以支撑额外一次调用；`review` 的 scope 收窄已在 P0 完成，实现时机另行决定。

**关键依赖顺序：P0 必须最先合并。** 在「一格 `UNAVAILABLE` 即整轮失败」的门禁下，P1 的重试、P3 的 repair 都无法体现效果，且会被误判为无效改动。

---

## 11. 测试要求

新增/修改的行为必须同批更新 `docs/test-scenarios.md`（见该文件 `TS-PLANNER-RESILIENCE-*` 一节），并覆盖：

| 场景 | 期望 |
|---|---|
| 一格航班 `UNAVAILABLE`、其余 `LIVE` | 产出 PROPOSED plan + 该格 `service_gap`，任务 `COMPLETED_WITH_GAPS` |
| 推荐目的地全部航班 `UNAVAILABLE` | 无 `itinerary_plans` 行；`planning_research_results.result_plan_id = NULL`；任务 `COMPLETED_WITH_GAPS`；不可进入 adoption vote |
| 某格从未被搜索（MISSING） | 仍抛 `FlightResearchIncompleteError`，`PLANNING_DATA_UNAVAILABLE`，不可重试 |
| provider 瞬态失败一次后成功 | 单次重试后返回 LIVE；`provider_retry_total{outcome="recovered"}` +1 |
| provider 返回 `RATE_LIMITED` | 使用 `rateLimitedMs` 时钟，不走指数退避 |
| 带写 scope 的 skill 声明 retry | `registerSkill` 抛 `POLICY_DENIED` |
| 调用方 abort（取消/lease 丢失） | 不触发任何重试 |
| 慢 provider 吃满 tool 预算 | 模型仍能在自己的预算内完成回复；回合不报模型故障 |
| 模型失败但已有落库证据 | 持久化确定性证据摘要消息，不出现「连不上模型」 |
| 输出 schema/policy 校验失败一次 | 一次 repair 后通过；`plan_repair_total{outcome="repaired"}` +1 |
| repair 预算耗尽 | 抛出原始错误；`turn` 计数未被 repair 侵占 |
| critique 内容 | 不含模型值、快照字段值或 provider 原始文本 |
| 任务重试 | `expires_at` 被续期，且不超过 `created_at + maxLifetimeSeconds` |

跨用户读取、授权撤回、plan 过期与重复/乱序 callback 的既有回归场景保持不变，本方案不触碰这些路径。

---

## 12. 边界、风险与技术债

### 12.1 边界条件

- research-summary 不携带商业 authority：不可被采用、确认或送入 booking sandbox。任何把它当作 plan 使用的代码路径都是缺陷。
- `COMPLETED_WITH_GAPS` 的 plan **可以**进入 adoption vote——它自身持有 LIVE 证据，gap 在软能力上。这与 §1.3 不冲突。
- 重试永不跨越取消边界：`options.signal` abort、lease 丢失、任务取消都不重试。
- repair 不得放宽 HARD 约束，也不得改变任何门禁结论——它只让模型重新表达一次输出。

### 12.2 风险

| 风险 | 影响 | 控制 |
|---|---|---|
| Gate B 放宽后，用户看到大量「有方案但缺航班」 | 产品观感 | Gate B 按目的地判定商业依据；缺航班的目的地根本不出 plan |
| repair 增加 token 与延迟 | Demo 时长 | `repairBudget = 2`；`PLANNING_RUN_DEADLINE_MS = 180000`；`plan_repair_total` 监控实际触发率 |
| 重试放大对限流 provider 的压力 | 配额 | `RATE_LIMITED` 使用自有时钟且计入 `maxAttempts`；`maxAttempts ≤ 3` 硬上限 |
| critique 泄露快照或模型内容 | 隐私 | `toCritiques` 白名单化；无法安全降解时返回 `null`；测试断言 critique 内容 |
| 受控机场只有 5 个（#22） | 航班能力对多数目的地不可用 | 本方案不解决；P0 后它表现为诚实的 gap 而非整轮失败。补参考数据另行立项 |
| `flash-lite` 在 repair 后仍不收敛 | 预算耗尽 | repair 与 tool 预算隔离，退化路径等同现状 |

### 12.3 已知技术债（本方案不解决，需单独立项）

1. **受控机场参考数据只有 5 个**（SFO/PVG/NRT/SIN/LIS），是 demo 夹具而非真实参考数据。
2. **`researchCoverageForSnapshot` 的 `Promise.allSettled` 无并发上限**（`planning-service.ts:226` 注释已标注为 Phase 6 hardening）。
3. **首轮规划不自动带入 hotel capability**（`docs/shared-agent-findings.md` #11）——在 #15 修复后已不再阻断出方案，但两个刻意决定的张力仍在。
4. **`GET /trips/:tripId/research-results` 端点缺失**：web 客户端方法与 Zod schema 存在而路由从未实现。本方案按删除死代码处理；若未来需要按 run 读取历史 research result，需重新立项实现该端点。

---

## 13. 证据索引

本文件的每一项判断均可回溯到以下位置（记录于 2026-09-03，`develop` 分支）：

| 结论 | 位置 |
|---|---|
| 航班矩阵 `complete` 要求全 LIVE | `apps/api/src/services/flight-research-matrix-service.ts:46` |
| 其余四个矩阵只要求非 MISSING | 同目录 `hotel:36` / `activities:49` / `accommodation:41` / `navigation:60` |
| `flightMatrixToGaps` 在 plan 路径上恒为空 | `flight-research-matrix-service.ts:55` + `planning-service.ts:1257` |
| `PLANNING_DATA_UNAVAILABLE` 不可重试 | `apps/api/src/workers/agent-task-worker.ts:311` |
| 第二处硬拒绝（stay 覆盖） | `apps/api/src/tasks/personal-trip-orchestrator-service.ts:221` |
| tool 失败已降级为 UNAVAILABLE（勿回退） | `apps/api/src/services/planning-service.ts:1023` 起 |
| 有界 tool loop 与 schema 回灌先例 | `apps/api/src/providers/llm-gateway.ts:925` / `:977` |
| Skill 契约缺 retry/fallback | `apps/api/src/agents/contracts.ts:185` |
| 11 个 adapter 中仅 3 个有重试 | `providers/nuitee-hotel:100`、`serpapi-hotel:58`、`viator-mcp-activities:69` |
| 对话回合单一 15s 时钟 | `apps/api/src/tasks/handlers/conversation-task-handler.ts:558` |
| `expires_at` 在 accept 时写死 | `apps/api/src/tasks/task-repository.ts:148` / reaper `:1152` |
| review scope 含 `plan:write:propose` | `apps/api/src/agents/policy-gate.ts:40` |
| research summary 读接口已存在 | `apps/api/src/routes/research.ts:214` |
| web errorCode 映射已实现 | `apps/web/src/components/explore/travel-agent-chat.tsx:1464` |
| `getResearchResult` 指向不存在的路由 | `apps/web/src/lib/api/http-travel-api.ts:678` |
