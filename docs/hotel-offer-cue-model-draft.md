# Hotel Offer Cue Decision Model

**状态：** 已确认的实施设计；尚未创建模型、迁移、接口或业务代码。
**范围：** 在 owner 的私有聊天中，判断何时显示 `Stay in this hotel?`，并安全保存用户已确认的住宿选择。它不是酒店搜索触发、目的地确认、整体 Plan adoption 或预订。
**关联文档：** [Destination Cue Decision Model](destination-cue-model-draft.md)、[Flight Offer Cue Decision Model](flight-offer-cue-model-draft.md)、[Hotel Search Tool](hotel-search-tool-implementation.md)。

## 1. 已确认产品语义

`Stay in this hotel?` 表达的是：用户希望将一条**已在自己当前私有聊天中看到的酒店报价**保存为本次 Trip 的已选择住宿候选。

- 接受不创建酒店订单、付款、供应商跳转或房间保留。用户说“订这家”时，确认卡和成功反馈仍必须表达“保存到行程，尚未预订”。
- 选择保留在 owner-only Personal Research 边界内；它不能直接成为 Shared Plan evidence、booking authority 或同行者可见事实。
- Shared Planning 必须基于最新 snapshot 和 provider 重新搜索。若原报价已过期或已变化，不得静默替代成新价格。
- Phase 1 限制为 `DRAFT` Trip creator 的私有 thread；`PLANNING`、`STALE`、`ACTIVE` 状态中的住宿替换必须在后续阶段纳入 replan 和成员确认。

## 2. 触发原则：语言模型判断，不使用关键词 hard-code

自然语言是否构成住宿选择，必须由独立 Hotel structured-output 模型判断。服务端没有“住”“选”“订”“这家”等关键词触发器，也没有明确措辞 bypass；这些词仅由模型在上下文中理解。

确定性代码仅验证：当前 USER 消息、owner/thread/trip 归属、存在已展示且未过期的酒店候选集合、候选引用唯一、版本有效、没有冲突的 OPEN cue，以及 cooldown/幂等/权限。模型输出不能写入任何 Trip 或 provider 状态。

模型输入只能是当前用户文字及服务端挑选的安全 hotel candidate projection，不含 Assistant 原文、私聊历史、raw provider response、provider URL、国籍、其他成员数据或 Profile。

## 3. 真实使用场景与决策

| 用户当前消息 | 模型结论 | 卡片 |
| --- | --- | --- |
| `第一家吧`、`就住这家`、`选上海外滩那家` | 对唯一酒店的明确选择 | 显示 |
| `带免费取消的那家最合适，就它` | 强选择 | 显示 |
| `订这家酒店` | 明确采用，不代表真实预订 | 显示 |
| `这家有早餐吗？`、`离地铁多远？` | 查看详情 | 不显示 |
| `A 和 B 哪个好？`、`哪家更便宜？` | 比较 | 不显示 |
| `这家太贵，不要它`、`换到市中心附近` | 拒绝或重新搜索 | 不显示 |
| `这家不错` | 正面评价但未形成选择 | 不显示 |
| `第一家和第二家都可以`，且日期/城市相同 | 同一入住区间的互斥选择 | 不显示；Agent 澄清 |
| `前两晚住 A，后两晚住 B`，且服务端有两个非重叠入住区间 | 两个独立住宿选择 | 分别、逐项确认 |

Phase 1 不保存“不住这家”作为长期排除。未来若要让后续搜索避开被拒绝酒店，应单独设计 `hotel_rejection` 状态、TTL、撤销与 provider 重查语义，不能复用 dismiss。

## 4. 模型合同

```ts
type HotelOfferCueInput = {
  currentMessage: string;
  locale: "en" | "zh";
  offerSetId: string;
  offers: Array<{
    candidateRef: string;
    ordinal: number;
    stayKey: string;            // server-derived city + check-in + check-out + occupancy
    propertyName: string;
    checkIn: string;
    checkOut: string;
    pricePerNight: number;
    totalPrice: number;
    currency: string;
    cancellationSummary: string | null;
    roomSummary: string | null;
    taxStatus: "INCLUDED" | "PARTIAL" | "UNKNOWN";
  }>;
};

type HotelOfferCueDecision = {
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

模型只能从输入候选中返回 `candidateRef`；同一 `stayKey` 最多一个候选。除非服务端已经将两段住宿拆成不重叠的 `stayKey`，多酒店表达必须返回 `NEEDS_CLARIFICATION`。

结果卡的“选择此酒店”按钮是明确 UI 指令，可以绕过语言模型，但依然必须进入相同的 resolver、有效期检查和确认卡，不能直接写 selection。

## 5. 推荐架构与数据流

```text
Hotel provider result
  → validated personal_research_evidence summary
  → private personal_research_offer_candidates
  → SSE / REST result-card DTO (opaque candidateRef)

next USER message
  → latest visible, unexpired Hotel offer set
  → Hotel Offer Cue model (parallel with normal reply)
  → server resolver + policy
  → offer_cue_batches / offer_cue_candidates
  → `Stay in this hotel?`
  → accept/dismiss action
  → personal_offer_selections
```

同轮刚从 provider 返回、用户尚未见到的结果不得作为语言模型候选。候选记录的 `visible_before_message_sequence` 必须早于当前 USER 消息。

## 6. 数据模型与接口

Hotel 复用 Flight 文档定义的通用表，但以 `capability = hotel` 进行隔离。`personal_research_offer_candidates.normalized_offer_json` 对 Hotel 保存完整的、Zod-validated `HotelOffer` 安全投影；浏览器只收到展示字段和 opaque candidate ID，永不收到 `providerOfferId` 或 raw payload。

`personal_offer_selections` 的唯一选择 scope 为 `(trip_id, owner_user_id, capability, stay_key)`。接受新选择时，服务端原子地将同一 `stay_key` 的旧 ACTIVE selection 标为 `SUPERSEDED`。

复用统一接口：

```http
GET  /api/v1/threads/:threadId/offer-cues
POST /api/v1/threads/:threadId/offer-cues/:cueId/candidates/:candidateId/accept
POST /api/v1/threads/:threadId/offer-cues/:cueId/candidates/:candidateId/dismiss
GET  /api/v1/threads/:threadId/offer-selections
DELETE /api/v1/threads/:threadId/offer-selections/:selectionId
```

请求带 `{ requestId, expectedVersion }`。accept 必须事务内重新验证 owner/thread/trip、候选归属、报价有效期、cue/candidate 状态与 optimistic version；过期报价不能被保存为新选择。

## 7. 提示策略、目的地组合与状态边界

- `hotel` 独立应用 30 分钟 cooldown；同一 owner + Trip 的当日第三次 dismiss 后，静默到该用户本地自然日结束。
- 被模型判为明确选择的文本允许绕过静默，但绝不允许服务端用关键词自行判为明确。
- Hotel Cue 与 Destination Cue 可以同屏编排，但永远是独立写入。接受酒店不会自动把酒店所在城市写为 Trip destination。
- `dismiss` 只意味着“不显示这次采用确认”，不等同“不要这家酒店”，不影响未来用户重新搜索。
- 本能力不改变酒店搜索本身的自动查询规则；`Stay in this hotel?` 只在用户看到结果、并在后续明确选择时出现。

## 8. 实施阶段与验收

1. **候选身份层：** 在现有 Personal Hotel evidence 旁创建私有、可解析 candidates，扩展 SSE/REST DTO 和结果卡绑定。
2. **状态机：** 实施共享 Cue tables/service、Hotel policy、confirm/dismiss API、恢复和 UI；可在不接模型的情况下以 contract tests 验证。
3. **模型与 resolver：** 建立 Hotel prompt/schema，当前 user turn 与 offer set 的并行分类及 fail-closed 行为。
4. **Shared 衔接：** 后续在 `PLANNING`/`STALE` 中设计重新检索、replan 和成员确认，不允许跳过现有酒店 provider 和 Plan evidence 规则。

验收至少覆盖：查询详情、比较、否定、无指代、单一采用、同区间多选、不同区间多选、刷新恢复、过期报价、跨 thread 访问、并发 accept、3 次日静默、模型失败不影响聊天、“订这家”不创建订单。

## 9. 可观测性与发布

使用共享低基数指标与 Flight 一致：`offer_cue_decision_total`、`offer_cue_action_total`、`offer_cue_resolution_total`，其中 `capability=hotel`。不得记录消息正文、酒店名、价格、provider ID、国籍或 raw response。

迁移必须 additive；先 DB、后 API/Worker、最后 Web。旧客户端可忽略新增可选字段；应用回滚不删除或回滚新表。
