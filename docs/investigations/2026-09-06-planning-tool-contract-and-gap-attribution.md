# 2026-09-06 — 「本次规划未生成共享方案」：没有任何一个服务不可用

## 现象

Trip `cc95d07d` 的运行 `56b847e1` 结束于 `COMPLETED_WITH_GAPS`，页面写着「实时数据未满足生成
计划的条件」，并列出 8 条缺口：

```
places: 服务提供方暂时不可用。      × 7
navigation: 服务提供方暂时不可用。  × 1
```

## 这 8 条全是假的

按运行时间窗（`1788643091330`–`1788643143837`）从 `apps/api/runtime/worker-2026-09-06.ndjson`
取出这次 run 的全部事件：

| 工具 | 调用次数 | 结果 |
|---|---|---|
| `hotel.search` | 2 | 全部成功 |
| `places.adopt` | 9 | 8 次失败，**全部是 `ZodError`** |
| `navigation.route` | 1 | 失败，**`ZodError`** |

**一次 provider 调用都没有失败过。** 8 条 ZodError 全部发生在「模型给出的参数被我们自己的 Zod
schema 拒绝」的那一刻，根本没走到供应商。运行终止于：

```
llm.tool_loop → TOOL_CALL_MAX_TURNS (40.8s，10 个 turn 用尽)
planner.gate  → research_summary failure: TOOL_BUDGET_EXHAUSTED
```

方案被扣下的原因是回合预算被一个根本调不通的工具耗光，不是数据不够。

## 根因一：`places.adopt` 对模型公开的参数契约是假的

`planning-service.ts` 告诉模型的签名是
`{ additionalProperties: false, required: ["action"], properties: { action, candidateId, placeId } }`，
而 `trip-place-skill.ts` 真正校验的是一个判别联合：

| action | 实际必填 | 公开签名里有吗 |
|---|---|---|
| `propose` | `candidateId` + `visibility` + `kind` + `candidate{11 字段}` | 只有 `candidateId` ❌ |
| `adopt` | `placeId`（uuid） | 有，但 placeId 只能由 propose 产出 ❌ |
| `revoke` | `placeId` + `reason` | `reason` 不在其中，且 `additionalProperties:false` 等于禁止它 ❌ |

**三个 action 全部不可调用。** 日志里模型的挣扎与这张表逐条对应：先试 `adopt`（报 `placeId`
缺失 + `candidateId` 是未知键），再试 `revoke`（报 `placeId`/`reason` 缺失），再试 `propose`
（报 `visibility` 不是合法枚举值），每种错法各烧掉一个 turn。

`navigation.route` 是下游：`places.adopt` 从未成功，模型手里没有真的 `placeId` 只能编一个；
公开签名写的是 `{type:"string"}`，没说必须是 uuid，而校验要求 `.uuid()`。

雪上加霜的是，这次 run 里 `places.search` 已被「已研究能力」机制撤下，**模型连拿到一个
candidateId 的途径都没有**，却仍然被提供了 `places.adopt`。

`places.search` 也从不持久化候选（只落一行 `provider_search_runs`），而
`proposeTripPlace` 的注释声称「调用方已经校验过 candidateId 来自本 run 的 places.search」——
没有任何一层做过这个校验。模型给的 `displayName` / 经纬度 / `source` / `capturedAt` 会被原样
写进 `trip_places`，这违反 AGENTS.md「每一项输出必须带来源及 captured_at」。

## 根因二：我们自己的参数错误被记成供应商故障

```ts
const code = error instanceof SkillError ? error.code : "UPSTREAM_FAILURE";
```

`ZodError` 不是 `SkillError`，一路兜底成 `UPSTREAM_FAILURE`，前端渲染为「服务提供方暂时
不可用」。这正是 `docs/test-scenarios.md` 的 **TS-GAP-ATTRIBUTION** 明令禁止的。正确的码
（`SKILL_CONTRACT_VIOLATION`）连同文案早就存在，只是 dispatch 的 catch 从未用到它。

`flight.search` 一条做对了（`safeParse` → `SkillError("INPUT_INVALID")`），其余六个工具全用
裸 `.parse()`。

## 根因三：失败记忆只按「完全相同的参数」去重

`failedToolCalls` 的 key 是 `name + JSON.stringify(arguments)`，挡得住重复的同一次调用，挡不住
同一个工具换一种错法。本次 8 次失败是 8 组不同的错参数，一次都没命中缓存。

## 根因四：有证据的运行仍可能什么都不给

`researchSummaryReasonFor` 只认 `PlanEvidenceUnavailableError` 与 `TOOL_CALL_MAX_TURNS`。
`SCHEMA_PARSE`（模型最终输出不合约、修复预算用尽）和三个 `*ResearchIncompleteError`（矩阵
`MISSING`）会让整轮 `FAILED`，用户连「我们查到了什么」都看不到——尽管证据早已落库。

## 修复

1. **拆成三个工具**：`places.propose` / `places.adopt` / `places.revoke`，各自一个扁平 schema，
   `action` 由服务端补。判别联合从模型视野里彻底消失。工具表抽成
   `buildPlanningToolDefinitions()`，可被测试直接读取。
2. **候选由服务端补全**：`places.search` 的结果存进本 run 内存 map；`places.propose` 只报
   `candidateId`，`ctx.placeSearch.resolveCandidate` 解析它，本 run 没发过的 id 直接
   `INPUT_INVALID` 且不写库。不需要建表。
3. **可用性门槛**：`places.search` 没被提供时，三个 place 工具和 `navigation.route` 一并不提供。
   仅此一条就能阻止本次故障。
4. **归因**：六处裸 `.parse()` 改为 `parseToolArguments()`（safeParse → `INPUT_INVALID`）；
   catch 的兜底从 `UPSTREAM_FAILURE` 改为共用的 `classifyError()`（已从
   `personal-trip-orchestrator-service.ts` 移到 `planning-research-result-service.ts`，两条链路
   共用一份分类）。
5. **撤下工具**：同一工具参数被拒 2 次即从后续 turn 撤下（gateway 新增 `onToolControl`，
   `offeredTools()` 过滤）。工具全撤下会触发既有的 `forceFinalPlan`，模型立刻被要求出方案。
   新指标 `planning_tool_args_rejected_total{tool}`。
6. **丙类降级**：`SCHEMA_PARSE` → `PLAN_SCHEMA_UNMET`，三个矩阵错误 → `RESEARCH_MATRIX_INCOMPLETE`，
   都改为写研究摘要而非整轮失败。`NO_CITABLE_EVIDENCE`（四类证据全为 0）保持不变——零证据不编方案。
7. **页面说真话**：迁移 `0079` 给 `planning_research_results` 加 `summary_reason`（带 CHECK 约束），
   经 `GET /trips/:tripId/runs/:runId` 带到前端；副标题按真实原因分支。历史行为 NULL，
   显示「这一轮没有记录具体原因」，不再假称是数据问题。

## 为什么没被测出来

`tests/planning-tool-list.test.ts` 里的工具都是 `parameters: {}` 的桩，没有任何测试拿「公开给
模型的 JSON Schema」比对「实际校验的 Zod schema」。新增的
`tests/planning-tool-contract.test.ts` 就是这条缺失的测试；把 `places.adopt` 改回旧签名，它会
以 3 条失败复现本次故障。

## 未修复 / 已知遗留

- `boundToolResult` 的 `maxItems = 5`：模型每次只看得到 5 个候选。这是既有约束，已在工具
  描述里说明，未改动。
- `tests/trip-title-suggest-route.test.ts > never calls the model on a manually renamed trip`
  在 `HEAD`（`fe63a89`）上就是红的，与本次改动无关，未处理。

## 同日复测：「重新规划」仍显示没有产出方案

### 证据

点击「重新规划」后，HTTP 命令正常返回 `202`，但连续三个新 run
（`73866e4b`、`848db922`、`f2a04f13`）都在 Worker 内以 `SCHEMA_PARSE` 结束；底层异常实际是
`PlanValidationError`（`PLAN_VALIDATION_FAILED`），错误信息为「Plan output failed deterministic
validation」。同一轮 provider 请求大多成功，最近一次已经持有 10 条酒店、5 条活动和 16 条住宿
发现证据，因此这不是按钮、网络或数据全量不可用问题。

### 追加根因

orchestrator 会先完成一次性研究，然后用 `alreadyResearchedCapabilities` 撤下对应搜索工具；但是
`generateStructuredPlanWithTools` 的首轮 payload 只传了旧的 `stays`，没有把预取的 flights、
hotels、activities、accommodations 交给模型。模型既不能再次调用已撤下的工具，也看不到必须原样
引用的服务端证据 ID，只能遗漏酒店或生成不存在的 ID，最终被确定性 evidence validator 拒绝。

此外，完整的 `bindPlanSelectionsToEvidence` + `validatePlanOutput` 原本位于 gateway repair loop
之外。gateway 只能修复 Zod 输出 schema，无法把 `EVIDENCE_NOT_FOUND` 等确定性校验结果回灌给模型；
异常映射又只识别表层 `SCHEMA_PARSE`，未识别实际抛出的 `PlanValidationError`，所以已取得的研究证据
没有降级保存成新的 research summary，页面继续展示旧 run 的摘要。

### 追加修复

1. 新增有界 `availableEvidence` catalog，把五类预取证据各最多 5 条安全比较字段和权威 ID 放入首轮
   synthesis payload；原始 provider payload、URL、成员/Profile 信息不进入模型上下文。
2. gateway 新增 `validateFinalPlan` 回调。最终结构解析后，在同一个 bounded repair loop 内执行服务端
   evidence binding、coverage、policy 与 provenance 校验；只把稳定 critique code 和字段路径回灌，
   不回显被拒值。
3. planning service 在 gateway 返回后再次执行同一校验，作为不可绕过的持久化边界；耗尽 repair 后的
   `PlanValidationError` 统一降级为 `PLAN_SCHEMA_UNMET` research summary。
4. provider 把空数组标成 `LIVE` 时统一归一化为 `UNAVAILABLE / NO_RESULTS`，避免「已研究」与「其实
   没有任何证据」同时成立。
5. 新增安全的 `planner/evidence_catalog` 计数事件，并复用
   `plan_validation_failures_total{validationResult}`；日志只记录稳定 violation code 与字段路径。

### 回归覆盖

- 已撤下的一次性工具仍能通过 `availableEvidence` 把酒店证据交给模型；模型首次给出未知 ID 后可在一次
  critique repair 中改用真实 ID。
- orchestrator 预取酒店证据能够到达 synthesis gateway。
- 真实 `PlanValidationError` 会落为 `PLAN_SCHEMA_UNMET`，而不是使 run 直接 `FAILED`。
- `LIVE + []` 航班结果 fail closed 为 `NO_RESULTS`，不会错误满足目的地覆盖。

## 同日遗留：证据已交接但落在错误槽位

后续实际 run 证明 evidence catalog 与 repair 边界已经生效：五类 catalog 都被记录，且没有再次调用已完成的 provider 工具；但模型把 hotel 的紧凑 ID 写进 legacy `stays[]`。由于 `allStays` 为空，绑定器正确地没有把 hotel 伪装为 stay，随后严格 stay schema 报缺字段。当前 critique 将其笼统写成 `SCHEMA_INVALID`，模型在两次 repair 中重复相同类别错误，最终安全降级为 `PLAN_SCHEMA_UNMET`。

这不是“没有酒店数据”、重新规划按钮或团队约束的问题。根因是最终输出 contract 缺少**ID 与槽位类别一一对应**的 preflight，且当前无 plan summary 因零 `serviceGaps` 落成 `COMPLETED`。Shared Plan 只识别 `COMPLETED_WITH_GAPS` 的无方案状态，因而错误显示“方案已就绪”；latest research route 还遗漏了已定义的 `summaryReason`。

后续研发以 [规划证据槽位校正与无方案终态实施方案](../planning-evidence-slot-and-planless-state-implementation.md) 为准：增加 `EVIDENCE_SLOT_MISMATCH` 的无敏感预检/repair、把所有无 plan summary 终态统一为 `COMPLETED_WITH_GAPS`、透传 summary reason，并按 `resultPlanId` 而非单独 run status 呈现 Shared Plan。团队约束保持仅显示已确认 `TEAM_VISIBLE` facts 的既有隐私边界。
