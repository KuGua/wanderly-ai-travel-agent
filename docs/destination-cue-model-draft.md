# Destination Cue Decision Model

**状态：** v2 触发分类与提示疲劳策略已在 `codex/destination-cue-policy-v2` 实现；目的地排除确认/撤销和 combination card 仍待实现。
**范围：** 决定何时显示 `Set {city} as the destination?`、何时进入目的地排除确认，以及如何为后续机票/酒店 combination card 提供触发上下文。航班采用与酒店采用由独立模型和独立 offer resolver 负责，实施契约见 [Flight Offer Cue Decision Model](flight-offer-cue-model-draft.md) 与 [Hotel Offer Cue Decision Model](hotel-offer-cue-model-draft.md)。

## 1. 产品语义

Destination Cue 是对**单个、可唯一解析的城市兴趣**进行轻量确认，不要求用户已经表达“确定要去”。以下当前 USER 消息均应产生候选：

- 裸城市名：`北京`；
- 城市探索：`北京怎么样？`、`介绍一下北京`；
- 城市机酒需求：`北京有哪些酒店？`、`帮我查去北京的机票`；
- 出发地与目的地同时存在：`从上海飞北京` 只产生北京；
- 弱意向：`我在考虑北京`；
- 明确指令：`把北京设为目的地`。

以下情况不产生普通目的地确认：

- 中性地列出或比较多个城市，例如 `北京、上海、南京、苏州`、`北京和上海哪个好？`；
- 一次机票或酒店查询包含多个目的城市；
- 只有国家、区域、机场或不能唯一解析的地点；
- `那里`、`这个地方` 等仅凭当前消息不能解析的代词；
- Assistant、历史消息、地图选择或供应商结果提到的城市；
- 当前 USER 消息明确表达不想去、不要安排或排除该城市。

“多个城市不提示”只适用于中性列举/比较。明确逐项指令仍按指令处理，例如 `把上海设为目的地，北京不要去` 必须分别生成上海的目的地确认和北京的排除确认。

## 2. 判断架构：确定性规则 + 语言模型 + 服务端后校验

本能力不得是纯 hard-coded 关键词系统，也不得让模型独自决定业务状态。职责分层如下：

1. **确定性前置规则**只负责不需要语言推断的边界：仅 DRAFT creator 的当前 USER turn 可触发，空输入、重复任务和无权限请求直接结束。常见明确指令可用规则做 fast path，但规则命中不是识别明确指令的唯一方式。
2. **独立语言模型**只理解当前 USER 消息中的自然语言关系：识别城市提及、出发地/目的地角色、机票/酒店上下文、弱兴趣、中性多城市列表、明确设置和明确排除。模型必须能识别未命中 fast path 的自然表达，因此静默状态也不能在语言分类前直接跳过模型。模型不接收 Assistant 回复、历史原文、地图状态、Profile、供应商结果或同行对话。
3. **服务端后校验**通过 `LocationReferenceResolver` 将每个候选唯一解析为规范城市；未知、歧义、国家/区域、错误角色和重复候选一律 fail closed。模型输出只能建议，不能写 Trip。
4. **持久策略层**在分类和解析后应用 30 分钟 cooldown、每日拒绝上限、幂等和乐观锁；模型或 fast path 判定为明确设置指令时绕过自动静默，其他候选受静默限制。

因此，`北京` 是否触发不靠关键词猜“已经决定去”，而是：语言层识别它是单一城市兴趣，resolver 确认它是唯一城市，策略层确认当前没有被静默。当前机酒句子的城市角色由语言模型识别，再由 resolver 做城市级校验；例如 `从上海飞北京` 不得把上海作为目的地候选。与机票/酒店结构化提取结果的交叉一致性校验随 combination card 一并补充，当前实现尚未接入。

## 3. 模型合同

```ts
type Input = {
  currentMessage: string;
  currentDestinations: string[];
  currentExcludedDestinations?: string[]; // 排除状态落地后启用；当前实现不发送
  locale: "en" | "zh";
};

type CandidateIntent =
  | "DESTINATION_INTEREST"
  | "EXPLICIT_SET_DESTINATION"
  | "EXPLICIT_EXCLUDE_DESTINATION";

type TriggerContext =
  | "BARE_CITY"
  | "CITY_EXPLORATION"
  | "FLIGHT_DESTINATION"
  | "HOTEL_DESTINATION"
  | "EXPLICIT_DESTINATION_COMMAND"
  | "EXPLICIT_EXCLUSION_COMMAND";

type Output = {
  candidates: Array<{
    mentionedText: string;
    ordinal: 0 | 1 | 2 | 3 | 4;
    intent: CandidateIntent;
    triggerContext: TriggerContext;
  }>;
  isNeutralMultiCityList: boolean;
  reasonCode:
    | "SINGLE_DESTINATION_INTEREST"
    | "EXPLICIT_DESTINATION_COMMAND"
    | "EXPLICIT_EXCLUSION_COMMAND"
    | "NEUTRAL_MULTI_CITY_LIST"
    | "NO_DESTINATION"
    | "AMBIGUOUS_REFERENCE";
};
```

普通目的地确认最多只能留下一个候选。模型检测到中性多城市列表时必须返回空 candidates；混合的明确逐项指令可返回多个 candidate intent。`triggerContext` 是后续 combination card 的服务端输入，不授予航班搜索、酒店搜索或 Trip 写入权限。

## 4. 明确排除目的地

否定不能复用 `DISMISSED`：dismiss 只表示“不想看这次提示”，明确排除则是影响规划的 Trip 状态。语言层应识别与具体城市有直接否定关系的表达，例如：

- `不想去北京`、`不要安排北京`；
- `排除北京`、`避开北京`、`不考虑北京`；
- `把北京从行程里去掉`。

以下表达不得直接判为明确排除：双重否定（`不是不想去北京`）、条件或假设（`如果不去北京`）、引述他人意向（`朋友不想去北京`）、一般讨论（`为什么有人不想去北京`）以及无法确定否定作用域的句子。它们保持普通对话或请求澄清。

模型只能产生 `EXPLICIT_EXCLUDE_DESTINATION` 建议。服务端解析城市后展示独立的“将北京排除在本次行程之外？”确认；用户确认后才写入专用 `trip_destination_exclusions` 状态。如果该城市已在 `destinationCandidates`，确认事务同时移除它、使依赖它的 plan/confirmation 失效并写审计。界面必须给出成功反馈和撤销入口。排除状态不得伪装成 cue dismissal，也不得只存在客户端。

## 5. 持久状态与恢复

既有状态继续复用：

- `destination_cue_batches`：owner/thread/trip/source run、模型与 prompt 版本、OPEN/RESOLVED/SUPERSEDED 状态及乐观锁版本；
- `destination_cue_candidates`：规范城市、国家码、hash、顺序、intent、trigger context 及逐项状态；
- `destination_cue_suppressions`：保留用于兼容既有逐城市 dismissal 记录，但 v2 自动提示以 Trip 级策略为权威；
- 新增 `destination_cue_prompt_policies`：按 `(owner, trip)` 保存 `cooldown_until`、用户本地日期、当日 dismissal 次数、`muted_until`、IANA timezone 与 version；
- 新增 `trip_destination_exclusions`：保存用户确认的规范排除城市、来源消息引用、创建与撤销时间。

不保存当前 USER 消息副本、Assistant 回复、prompt、坐标或模型 rationale。`GET /threads/:threadId/conversation` 是刷新恢复的 Cue 权威来源；SSE 只负责即时显示。排除状态由 Trip 接口返回，不依赖对话是否仍存在。

## 6. 忽略、静默与明确指令绕过

- 用户点击任一目的地 Cue 的“先不设置”后，对该 owner + Trip 启动全局 30 分钟 cooldown；期间任何自动目的地 Cue 都不显示。
- 同一用户本地自然日内，在同一 Trip 累计 dismiss 3 次后，静默到该本地自然日结束。
- 次日 daily count 清零。服务端保存 UTC 时间点，同时保存用于计算自然日边界的 IANA timezone；不得以服务器时区代替用户自然日。
- `把北京设为目的地` 等明确命令始终绕过 cooldown 和当日静默，但仍必须经 resolver、确认卡和幂等写入。
- Agent 文本、刷新、任务重试、模型失败、中性城市列表和被后校验拒绝的输出均不增加 dismissal count。
- 接受目的地不清空当日 dismissal count；已确认城市由去重规则阻止再次提示。

## 7. 卡片与写入

- 卡片永远显示具体规范城市名，不允许 `Set this ...`。
- v2 普通自动提示只包含一个城市，因此不显示多地点切换箭头。混合明确指令若产生多个待确认动作，必须逐项处理，切换控件只负责切换，不代表地点方向。
- 接受时服务端原子追加规范城市、清除同城 exclusion，并按现有规则更新 AUTO title；dismiss 只更新 prompt policy。
- 机票/酒店上下文中的 Destination Cue 不阻塞对应搜索意图。`triggerContext` 供后续 card orchestrator 组合或排序目的地、机票与酒店卡片；Flight/Hotel 采用只可引用用户已看见的私有结果，且其接受不得隐式接受目的地。三个卡片的 action、幂等和持久状态彼此独立。
- 每次动作要求 `requestId` 与 `expectedVersion`；重复请求幂等，陈旧版本返回 409 后客户端从会话恢复。

既有 accept/dismiss 接口保持兼容；排除确认使用独立接口：

```http
POST /api/v1/threads/:threadId/destination-cues/:cueId/candidates/:candidateId/accept
POST /api/v1/threads/:threadId/destination-cues/:cueId/candidates/:candidateId/dismiss
POST /api/v1/threads/:threadId/destination-exclusions/:proposalId/confirm
DELETE /api/v1/trips/:tripId/destination-exclusions/:exclusionId
```

## 8. 与 Trip Brief 的关系

Trip Brief review 继续只负责出发地、日期和天数。目的地只通过 Destination Cue accept 写入；明确排除只通过 exclusion confirm 写入。模型、机酒解析器和地图状态都不得直接创建、删除或排除目的地事实。

## 9. 必测场景

- 裸城市、城市介绍、弱意向、单城市酒店查询和单目的地机票查询均显示具体城市 Cue。
- `从上海飞北京` 只提示北京；已有目的地、Assistant-only 提及、代词、未知/歧义地点不提示。
- 中性列举或比较多个城市不提示；混合明确设置/排除指令仍逐项确认。
- dismiss 后 30 分钟全局静默；同一 Trip 当日本地日期第 3 次 dismiss 后静默到次日；明确设置命令始终绕过。
- 明确否定、条件句、双重否定、他人意向和混合肯定/否定的作用域正确；未确认 exclusion 永不进入 planning。
- 接受、dismiss、排除确认与撤销均幂等；刷新恢复、陈旧版本、并发 accept/exclude 和日期边界行为正确。
- 模型/resolver 不可用只抑制 Cue，不失败或延迟正常聊天；telemetry 与 audit 仅记录安全枚举、ID 和计数，不含消息或城市原文。

## 10. 迁移与兼容

- 现有 v1 `destination_cue_suppressions` 数据不迁移为全局 daily count，避免历史逐城市 dismissal 被误计为当日全局拒绝；v2 上线时从 0 开始计数。
- 在 API、Worker 与 Web 全部部署完成前，响应中的 v2 新字段保持可选且旧客户端可忽略；先执行 additive migration，再发布同时读写新字段的应用代码。回滚应用时保留新增表列，不做破坏性 down migration。
- v1 的“裸城市跳过”“机酒查询跳过”“30 分钟 + 两次后续提及”和“中性列表可生成多个 Cue”已由本分支的 v2 classifier 与 Trip 级提示策略替换；旧 suppression 表仅为滚动兼容保留，不再是 v2 运行时权威。
