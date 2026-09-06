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

## 同日第三次复测：候选已返回但无法 propose，repair 被当成检索预算

运行 `995ff516-580e-4490-ba36-48abaad7dc53` 中，flight、activities、accommodation 和五次
places provider search 均留下 LIVE 结果；hotel 单独为 `NO_RESULTS`。两次
`places.propose` 在 provider 之外被拒绝，原始错误均为
`candidateId was not returned by places.search in this run`。因此 hotel 空结果不是没有方案的主因。

dispatcher 对 `places.search` 的返回值读取了不存在的 `data[]`，但 Skill 公开输出字段是
`candidates[]`，导致本轮候选 map 永远为空。随后 gateway 又把
`maxTurns + repairBudget` 当成统一工具循环上限，两个 repair 回合也能继续搜索，最终在写 plan
之前耗尽十轮。

落地修复读取并严格校验 `PlaceSearchOutput.candidates`；places contract 连续失败时撤下整个依赖
工具族；最后一个正常回合固定关闭 tools 进入 synthesis，repair 回合继续保持关闭。research
summary 在持久化前按 capability/code/destination 去重。完整行为与验收以
[实施方案第 10 节](../planning-evidence-slot-and-planless-state-implementation.md#10-places-候选交接与最终成稿预算2026-09-06)
为准。

## v3 每日行程未展示：请求没有到达 Gemini

v3 plan `f6542afa-be95-4c15-96e7-6f9ccc652be1` 已正常激活，但数据库
`plan_data` 没有 `dailyItinerary`。对应 run `dc3125ef-1016-4473-b31f-484629ad7360`
在主方案合成成功后的下一毫秒记录 `daily_itinerary / failure / UNAVAILABLE`，期间没有每日行程
模型请求。页面只在字段为非空数组时渲染，因此不是前端漏展示。

根因是 planning service 解构并裸调用 `generateDailyItinerary`，使类方法的 `this` 丢失；真实
`LLMGateway` 在 `this.loadClient()` 处抛错，Gemini client 尚未加载。测试 gateway 使用对象字面量
且方法不依赖 `this`，所以旧测试错误通过。修复改为经实例调用，并新增服务层 receiver/persistence
回归；同时将本地调用错误从 provider `unavailable` 中拆为 `internal_call_error`。

后续 v4/v5 已证明请求进入 Gemini，但每日行程在约 4 秒后被确定性校验拒绝；旧遥测只保留
`VALIDATION_FAILED`，无法区分日期、时间和引用。修复采用最多三次的独立日程生成预算，使用
服务端日期数组、精简证据上下文和仅含错误码/schema path 的修复提示。耗尽后保留共享方案并写入
`dailyItineraryStatus=UNAVAILABLE`，不重新执行航班、酒店、活动或地点检索。

## v7 每日行程未通过：Gemini 拒绝外层数组上限契约

v7 plan `72b5d1f2-9184-429c-b376-c412fb5a2b68` 对应 replan run
`a245b089-2f45-482b-8fcc-91d91296e47e`。主方案合成、两条航班检索、酒店和活动检索均成功；
每日行程请求随后被 Gemini OpenAI-compatible endpoint 以 HTTP 400 `INVALID_ARGUMENT` 拒绝。
安全遥测将其分类为 `PROVIDER_UNAVAILABLE`，`attempt=1`、`fieldPaths=[]`。因此本次没有发生内容
校验，也没有进入第 2/3 次内容修复；页面统一显示的 “did not pass validation after retrying” 与实际
失败阶段不符。

同一模型、同一 endpoint 的最小 schema 对照复现把拒绝条件收敛到
`dailyItineraryModelCompletionSchema` 最外层 `days` 数组的 `.max(31)`，即生成 JSON Schema 中的
`properties.days.maxItems=31`：

- 完整 schema：HTTP 400；
- 删除所有 `pattern`：仍为 HTTP 400；
- 删除 `minLength`/`maxLength`：仍为 HTTP 400；
- 删除内层 `items.maxItems`：仍为 HTTP 400；
- 改写 nullable 表达：仍为 HTTP 400；
- 只删除外层 `days.maxItems`：请求成功；保留其余正则、长度、nullable 和内层数组上限；
- 将外层上限分别改为 4、7、14、21、30：均为 HTTP 400。

所以根因不是 v7 的行程内容、价格、酒店、活动为空或前端漏渲染，而是当前 Gemini 模型/兼容端点
拒绝“该嵌套日程结构上的外层 `maxItems`”这一 structured-output schema 组合。Google 文档将
`maxItems` 列为受支持子集，同时也说明复杂或深层 schema 可能被拒绝；本次实测表现为位置/组合
兼容限制，而不是数值 31 超过某个阈值。修复时应移除 provider-facing 外层上限、继续在服务端按
旅行日期执行确定性覆盖校验，并为真实 provider schema acceptance 增加契约探测；另需让 UI 根据
`provider_unavailable` 与 `repair_exhausted` 显示不同原因。

### 落地结果

实现已拆分 provider wire schema 与 canonical Zod schema：前者移除 provider-fragile 的外层
`maxItems`，后者继续执行 31 日、每日 12 项、格式、长度和别名约束。新 plan 使用互斥的
`dailyItineraryOutcome` 保存 `READY` days 或闭合的 `UNAVAILABLE` 原因、retryable、attempts 与
checkedAt；旧字段只读兼容。指标拆为实际 attempt、单一 run 终态和耗时，日志携带内容安全的 schema
fingerprint。前端按失败原因区分内容修复耗尽、临时不可用与系统契约问题，并新增真实配置 provider
的 synthetic contract probe，避免再次只在用户 replan 后发现 schema 方言漂移。
