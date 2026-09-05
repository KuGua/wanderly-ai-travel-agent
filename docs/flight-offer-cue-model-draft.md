# Flight Offer Cue Decision Model

**状态：** 已确认的实施设计；尚未创建模型、迁移、接口或业务代码。
**范围：** 在 owner 的私有聊天中，判断何时显示 `Take this flight?`，并安全保存用户已确认的航班选择。它不是机票搜索确认、目的地确认、整体 Plan adoption 或预订。
**关联文档：** [Destination Cue Decision Model](destination-cue-model-draft.md)、[Hotel Offer Cue Decision Model](hotel-offer-cue-model-draft.md)、[DRAFT Personal Research](draft-personal-research-implementation.md)。

## 1. 已确认产品语义

`Take this flight?` 表达的是：用户希望把一条**已在自己当前私有聊天中看到的航班报价**保存为本次 Trip 的已选择候选。

- 它不创建 provider order，不支付，不跳转预订，也不表示票已锁定；即使用户说“订这个”，系统也只显示采用确认，且确认后的反馈必须写明“已保存到行程，尚未预订”。
- 接受只保存 owner-only selection，不能把 Personal Research evidence 直接写进 `constraint_snapshot`、Shared Plan 或 booking 输入。
- 进入 Shared Planning 时，系统必须重新查询、重新校验并由既有 Plan adoption / confirmation 流程决定正式行程；Personal 选择只是明确、可撤销的个人旅行意向。
- Phase 1 只支持 `DRAFT` Trip 的 creator 私有 thread。`PLANNING`、`STALE`、`ACTIVE` 中的写入会涉及 snapshot、stale/replan 和成员权限，留待后续独立阶段。

## 2. 触发原则：语言模型判断，不使用关键词 hard-code

是否弹出卡片的自然语言判断**必须由独立 structured-output 模型完成**。服务端不得以“选”“坐”“订”“第一班”等正则或关键词直接创建 Cue，也不存在“明确措辞的 hard-coded fast path”。

确定性代码只承担非语义职责：确认当前消息来自 owner、存在 owner 已看见且未过期的航班结果集、结果集与 thread/trip 匹配、候选引用唯一、版本未过期、没有冲突中的 OPEN Cue，以及执行 cooldown/幂等/权限检查。模型输出永远只是建议，不写 Trip。

模型只读当前 USER 消息和服务端投影的候选集合；不读取 Assistant 原文、完整历史、其他 thread、地图状态、Profile、原始 provider payload 或 provider URL。

## 3. 真实使用场景与决策

| 用户当前消息 | 模型结论 | 卡片 |
| --- | --- | --- |
| `第二班吧`、`就坐 CA1234`、`最便宜的直飞就它` | 对唯一报价的明确/强选择 | 显示 |
| `这个航班可以，订这个` | 明确采用；不等于预订 | 显示 |
| `第一班几点到？`、`有托运行李吗？` | 查看详情 | 不显示 |
| `第一班和第三班哪个好？`、`哪个最便宜？` | 比较 | 不显示 |
| `第一班太早，不要这个`、`换个便宜点的` | 拒绝或重新搜索 | 不显示 |
| `这个可以`，但当前无可引用航班 | 指代无法解析 | 不显示，保持普通对话 |
| `第一班和第二班都行`，且是同一航段 | 互斥候选，仍未选定 | 不显示；Agent 澄清 |
| `去程第一班、返程第二班`，且服务端能确认两个不同航段 | 两个独立选择 | 分别创建、逐项确认 |

正面评价本身（例如“这班不错”“我喜欢这个时间”）不构成采用；模型应将其判为 `NO_SELECTION_INTENT`，除非语境明确表达最终选择。拒绝不会在 Phase 1 形成长期排除事实。

## 4. 模型合同

```ts
type FlightOfferCueInput = {
  currentMessage: string;
  locale: "en" | "zh";
  offerSetId: string;
  offers: Array<{
    candidateRef: string;       // opaque server-issued ID
    ordinal: number;
    routeKey: string;           // server-derived segment/leg grouping
    carrierCode: string;
    flightNumber: string | null;
    departureAt: string;
    arrivalAt: string;
    totalDuration: string;
    totalPrice: number;
    currency: string;
    stopCount: number;
  }>;
};

type FlightOfferCueDecision = {
  decision: "PROPOSE" | "NO_CUE" | "NEEDS_CLARIFICATION";
  candidates: Array<{
    candidateRef: string;
    intent: "EXPLICIT_SELECT" | "STRONG_PREFERENCE";
  }>;
  reasonCode:
    | "EXPLICIT_SELECTION"
    | "STRONG_SELECTION"
    | "INSPECT_ONLY"
    | "COMPARE_ONLY"
    | "REJECTED"
    | "SEARCH_AGAIN"
    | "AMBIGUOUS_REFERENCE"
    | "NO_SELECTION_INTENT";
};
```

约束：候选必须来自输入 `offers`；同一 `routeKey` 最多一个候选；`PROPOSE` 至少一个候选；`NO_CUE` 和 `NEEDS_CLARIFICATION` 必须为空；模型不得输出解释性自由文本或 provider ID。

点击一个结果卡上的“选择此航班”是明确 UI 行为，可不调用语言模型，但仍必须走相同 resolver、状态机、新鲜度和确认卡；该例外不是文本触发的 hard-code。

## 5. 推荐架构与数据流

```text
Flight provider result
  → validated personal_research_evidence summary
  → private personal_research_offer_candidates
  → SSE / REST result-card DTO (opaque candidateRef)

next USER message
  → latest visible, unexpired Flight offer set
  → Flight Offer Cue model (parallel with normal reply)
  → server resolver + policy
  → offer_cue_batches / offer_cue_candidates
  → `Take this flight?`
  → accept/dismiss action
  → personal_offer_selections
```

模型不得引用同一轮刚刚搜索、但用户尚未看到的报价。结果集必须记录 `visible_before_message_sequence`，仅当该序列早于当前 USER 消息才可作为输入。

## 6. 数据模型

不得修改 `provider_offers.snapshot_id NOT NULL` 或把 Personal Research 结果伪装成 Shared evidence。新增 additive 表：

| 表 | 关键字段 | 责任 |
| --- | --- | --- |
| `personal_research_offer_candidates` | `id`、`evidence_id`、`trip_id`、`thread_id`、`owner_user_id`、`capability`、`offer_set_id`、`route_key`、`ordinal`、`normalized_offer_json`、`expires_at`、`visible_before_message_sequence` | 私有、可解析报价候选；不向浏览器暴露 provider offer ID。 |
| `offer_cue_batches` | `id`、owner/thread/trip、`capability=flight`、`source_message_id`、`offer_set_id`、model/prompt version、`OPEN/RESOLVED/SUPERSEDED/EXPIRED`、version | 共享 Cue 引擎的批次状态。 |
| `offer_cue_candidates` | `id`、`batch_id`、`personal_offer_candidate_id`、intent、ordinal、`PENDING/ACCEPTED/DISMISSED/EXPIRED` | 一个具体待确认报价。 |
| `offer_cue_prompt_policies` | owner、trip、capability、`cooldown_until`、本地日期、daily dismissal count、`muted_until`、timezone、version | Flight/Hotel 分开计数的提示疲劳策略。 |
| `personal_offer_selections` | owner/thread/trip、capability、candidate、`route_key`、`ACTIVE/SUPERSEDED/EXPIRED/REMOVED`、selected_at、version | 已确认个人选择，不是订单或 Shared Plan evidence。 |

唯一约束至少包括：一个 owner/thread 同时最多一个 OPEN Flight Cue batch；同一 selection scope (`trip_id`,`owner_user_id`,`route_key`,`capability`) 最多一个 ACTIVE selection；candidate 只能属于同一 owner/thread/trip 的有效 offer set。

## 7. 接口与状态

```http
GET  /api/v1/threads/:threadId/offer-cues
POST /api/v1/threads/:threadId/offer-cues/:cueId/candidates/:candidateId/accept
POST /api/v1/threads/:threadId/offer-cues/:cueId/candidates/:candidateId/dismiss
GET  /api/v1/threads/:threadId/offer-selections
DELETE /api/v1/threads/:threadId/offer-selections/:selectionId
```

所有 mutation 必须使用 `{ requestId, expectedVersion }`。accept 在同一事务内重新检查 owner/thread/trip、候选归属、状态、报价有效期与乐观锁；重复请求返回相同结果，过期或陈旧版本返回安全的冲突/不可用状态。

`dismiss` 只关闭当前候选并更新 Flight 提示策略；它不删除搜索结果、不创建 rejection fact，也不影响 Hotel 或 Destination Cue。

## 8. 提示疲劳与组合

- 对同一 owner + Trip + `flight`，dismiss 后 30 分钟内不自动弹 Flight Cue；同一用户本地自然日累计三次 dismiss 后静默到当日结束。
- 仍由模型判定为明确选择的文本可以绕过静默，但服务端仍必须完成引用和有效期校验；不得用正则自行认定“明确”。
- Destination、Flight、Hotel 可被一个组合容器呈现，但仍是独立 action。接受航班不隐式接受目的地，也不接受酒店。
- 同一航段的多个报价不使用轮播替代选择；模型应请求澄清。不同航段的候选可逐项确认，切换箭头只切换待确认项，不表示航线方向。

## 9. 实施阶段与验收

1. **候选身份层：** persistence、DTO、SSE/REST 恢复和结果卡绑定。验证刷新、重连、重复搜索不会错绑“第一班”。
2. **Cue 状态机：** migration、服务、接口、幂等、policy 与 UI card；可用 fixture 直接驱动 contract test，尚不接模型。
3. **模型与 resolver：** Flight prompt/schema、并行调用、fail-closed、中文/英文 eval；模型不可用时只不显示 Cue，不阻断聊天。
4. **后续 Shared 衔接：** 重新搜索、snapshot/plan/replan 的显式交接；不允许 Personal selection 绕过现有 Plan adoption 或 booking confirmation。

必须覆盖：详情/比较/拒绝不弹、唯一选择正确弹、过期结果拒绝、跨 thread 拒绝、同航段互斥、重复 accept/dismiss、刷新恢复、3 次日静默、模型超时不影响对话、用户说“订”仍无订单。

## 10. 可观测性与兼容

新增低基数指标：`offer_cue_decision_total{capability,outcome}`、`offer_cue_action_total{capability,action,outcome}`、`offer_cue_resolution_total{capability,outcome}`。日志/trace 只记录 capability、稳定 reason code、run/trip correlation ID 和模型版本；不得记录用户正文、报价正文、provider ID、价格或个人信息。

先执行 additive migration，再发布 API/Worker，最后发布 Web。旧客户端忽略新增可选 DTO 字段；回滚应用不回滚或删除新表。
