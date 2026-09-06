# Assistant-Originated Cue Trigger Draft

**状态：已按确认边界实施（2026-09-06）。**

## 实施说明

本次没有扩展 Personal Agent 的写库权限，也没有新增数据库迁移。运行时先完成 USER Cue 决策；仅当它没有命中时，才以该 turn 的最终可见 Assistant 回复作为 fallback。Destination 的 USER 决策额外可读取紧邻上一条最终 Assistant 回复，以便把“是否以惠安为目的地？”后的“是的”识别为 USER 来源。Flight / Hotel 仍只使用当前 thread 已展示、未过期的安全 offer 投影。

同一实体已有 OPEN 卡时，持久化层保持该卡但不产生新的 Cue 结果（因此不会再发送 `cue_ready`）；后续同实体的 USER/Assistant 文本不会造成重复展示，卡片仍是唯一的确认写入入口。

## 1. 要解决的问题

现有 Destination / Flight Offer / Hotel Offer Cue 都以**当前 USER 消息**为唯一自然语言触发输入。这样能避免 Assistant 的猜测直接改变行程，但会遗漏一个实际对话场景：Personal Agent 已经在可见回复中明确提出“把 X 设为目的地”或“确认当前航班 / 酒店”，用户随后只回答“是的”“去三天”。

这时 Agent 的自然语言可能已经把某地点说成“已记录”，而服务端仍没有已确认候选；页面不会出现目的地确认卡、候选目的地或“开始规划”。本草案的目标是让三类 Cue 能把 **Personal Agent 最终可见回复**作为受限的第二触发来源，同时保持现有确认卡仍是唯一写入边界。

本草案对应现有三份模型设计：

- [Destination Cue Decision Model](destination-cue-model-draft.md)
- [Flight Offer Cue Decision Model](flight-offer-cue-model-draft.md)
- [Hotel Offer Cue Decision Model](hotel-offer-cue-model-draft.md)

## 2. 产品决策（建议确认）

1. **用户触发优先。** 同一个 turn / 同一实体同时满足 USER 与 Assistant 触发时，只创建 USER 来源的 Cue。
2. **Assistant 不是写入者。** Assistant 来源最多创建确认卡；接受卡片才写目的地或 owner-only 机酒选择。Assistant 的文字永不直接更新 Trip、Plan、搜索条件或预订状态。
3. **只读取 Personal Agent 的最终可见回复。** 不读取思维链、工具参数、草稿 token、其他 Agent 或历史 Assistant 文本。
4. **只能引用已经可验证的实体。**
   - 目的地必须解析为一个唯一的规范城市；
   - 航班 / 酒店必须对应当前 owner、当前 thread、已展示、未过期的一个具体 offer candidate；
   - “这个 / 当前”在存在多个同类候选而无法唯一指向时，必须不触发。
5. **沿用现有范围与安全边界。** 仅 DRAFT Trip 的 creator 私有 thread；Flight / Hotel 接受仍仅保存 personal selection，不是预订，也不进入 Shared Plan evidence。

## 3. 统一触发模型

每个 Cue decision 模型改为接收一个来源明确的输入，而不是把 Assistant 文本和用户文本混成一段：

```ts
type CueTriggerSource =
  | { kind: "USER_TURN"; messageSequence: number; text: string }
  | { kind: "ASSISTANT_REPLY"; messageSequence: number; text: string };
```

Assistant 触发只在该 turn 的 USER 决策已完成后运行。Cue resolver 得到的候选还必须带来源与稳定 fingerprint：

```ts
type CueProvenance = "USER_TURN" | "ASSISTANT_REPLY";

// destination: canonical city + trip + owner
// flight/hotel: personal_offer_candidate_id + trip + owner + capability
type CueFingerprint = string;
```

### 去重与优先级

| 情况 | 行为 |
| --- | --- |
| 同一 turn，用户与 Assistant 都命中同一实体 | 只持久化 USER Cue；Assistant 决策记为 `suppressed_user_precedence`。 |
| 同一 turn，用户与 Assistant 命中不同实体 | 可分别创建，但遵从现有 UI 顺序：Destination → Flight → Hotel。 |
| 已有 OPEN 的 USER Cue，Assistant 再命中同一实体 | 不创建 Assistant Cue。 |
| 已有 OPEN 的 Assistant Cue，用户后来提及同一实体 | 不再创建或替换 Cue；既有卡已经是唯一确认入口。若产品要让“是的 / 确认”直接接受该卡，须另行设计显式的文本确认动作，不能伪装为再触发一张 USER Cue。 |
| 已 ACCEPTED / DISMISSED / EXPIRED | 继续走既有幂等、抑制、cooldown 和 version 校验；Assistant 不能绕过。 |

“同一实体”必须用服务端规范化后的 fingerprint 判断，不能以原文比对；例如“惠安”“惠安县”必须在解析后才比较，航班与酒店则比较 opaque candidate ID。

## 4. 三个 Agent 的新增触发条件

### 4.1 Destination Cue Agent

保留当前 USER 触发能力。新增 Assistant 来源只在同时满足以下条件时输出一个 destination candidate：

1. Personal Agent 的**最终回复**对一个可唯一解析的城市作出明确的设定 / 确认性行动，例如“把惠安设为目的地”“确认以惠安为目的地”“下一步将以惠安开始规划”；
2. 回复中城市可经既有 location reference resolver 得到唯一规范城市；
3. 该城市尚未是本 Trip 已确认的 `destinationCandidates`，且没有同城的 USER 优先 Cue；
4. 模型不能只根据“我认为你指的是 X”“你可以考虑 X / Y”“X 很适合”触发。它们是建议或澄清，不是设定；
5. 若 Assistant 提出了“是不是 X？”而用户在后续 turn 肯定，**该用户肯定回复**应作为 USER 来源的确认触发，而不是让旧 Assistant 文本反复弹卡。

第 5 点是本次惠安问题的关键：Assistant 先进行消歧提问，后续用户的“是的”需要与最近一条明确、唯一、可解析的 Assistant 候选做有限关联；关联成功后创建的 Cue provenance 仍然是 `USER_TURN`。

### 4.2 Flight Offer Cue Agent

保留“当前用户消息 + 最新已展示未过期航班候选”的现有门禁。新增 Assistant 来源仅在：

1. Personal Agent 的最终回复明确邀请采用一条**当前可见的唯一航班**，例如“要确认这趟航班吗”“我可以把这趟航班保存到本次行程”；
2. decision 模型从安全 candidate projection 中唯一选出 `personal_offer_candidate_id`；
3. 文案“确认当前机票”但同时存在多个可见航班、或引用已过期 / 非当前 thread 结果时，必须 `NO_CUE`；
4. 仅解释报价、比较多个航班、询问搜索条件、提及价格变化、承诺预订都不触发。

接受仍只保存 owner-only flight selection，并显示“已保存，尚未预订”。

### 4.3 Hotel Offer Cue Agent

与 Flight 对称，但匹配 `personal_offer_candidate_id` 与 stay scope：

1. Assistant 最终回复明确邀请采用当前可见的唯一酒店，例如“确认这家酒店吗”“我可以把这家保存为本次住宿候选”；
2. 候选必须属于当前 owner/thread/trip、未过期且可唯一引用；
3. “当前酒店”若有多个酒店、多个房型或多个日期区间而无法唯一匹配，必须不触发；
4. 推荐、比较、描述酒店、搜索酒店或任何预订承诺都不触发。

## 5. 实施边界（确认后再做）

仅修改 Destination / Flight / Hotel Cue 的 structured-output prompt、schema、resolver/policy、SSE/REST 恢复 DTO 和对应测试；**不扩大 Personal Agent 的写库权限，也不修改其业务提示词来让它自己写 Trip。**

建议流程：

```text
USER turn
  ├─ 现有 USER Cue decision（优先）
  ├─ Personal Agent 生成并持久化最终可见回复
  └─ Assistant Cue decision（仅此回复，且受 USER decision / fingerprint 仲裁）
       └─ resolver / policy / existing confirmation card
            └─ accept 才写入
```

为避免 UI 先出现 Assistant 卡再被 USER 卡替换，同一 turn 应在服务器完成两来源仲裁后再发出 `*.cue_ready` SSE。

数据上建议为既有 Cue batch/candidate 增加 `trigger_provenance`（`USER_TURN | ASSISTANT_REPLY`）与可审计但不含原文的 reason code；不保存 Assistant 原文、提示词或 rationale。若现有 batch 的 `source_message_id` 已可表达来源，则只新增 provenance 枚举即可。

## 6. 必须拒绝的案例

- Assistant 随口列出城市、酒店或航班选项；
- Assistant 自己猜测了一个地点，但没有明确设定 / 请求确认；
- 用户仅说“是”“就这个”，而最近 Assistant 消息没有唯一、可验证实体；
- 任何多个航班、酒店或城市都可能对应“当前 / 这个”的情况；
- Assistant 说“我已经预订 / 已锁定 / 已保存”但服务端没有接受确认卡；
- 用户和 Assistant 命中同一候选却创建两张卡；
- Assistant 来源绕过 DRAFT、creator、offer expiry、thread ownership、cooldown 或 optimistic version。

## 7. 验收用例

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| D1 | 用户说“去惠安”，唯一解析 | USER Destination card。 |
| D2 | Assistant 问“是否以惠安为目的地？”，用户答“是，去三天” | 一张 provenance=USER 的惠安 card；日期可进入独立 brief review。 |
| D3 | Assistant 说“把惠安设为目的地”且用户本轮未命中 | 一张 Assistant Destination card，接受后才写入。 |
| D4 | 用户与 Assistant 同轮均命中惠安 | 只一张 USER card；有 `suppressed_user_precedence` 诊断。 |
| D5 | Assistant 推荐“北京或杭州” | 不弹目的地卡。 |
| F1 | Assistant 对一个唯一已展示航班说“确认这趟吗？” | 一张 Flight card；接受后仅 personal selection。 |
| F2 | Assistant 对多个航班说“确认当前航班吗？” | 不弹卡。 |
| H1 | Assistant 对唯一、未过期酒店说“确认这家吗？” | 一张 Hotel card。 |
| H2 | Hotel 已过期、跨 thread 或多个房型不唯一 | 不弹卡。 |
| X1 | 已有 Assistant OPEN cue，用户随后明确同一实体 | 不新增、不替换卡；界面继续保留既有 Assistant Cue。 |
| X2 | 刷新 / SSE 重连 / accept 并发 | 一张稳定卡、幂等结果、无重复写入。 |

## 8. 可观测性

新增低基数指标 / reason code，不含城市、酒店名、报价、用户或 Assistant 原文：

- `cue_trigger_decision_total{capability,provenance,outcome}`
- `cue_trigger_arbitration_total{capability,result}`，结果例如 `user_wins`、`assistant_only`、`duplicate_suppressed`、`ambiguous_reference`
- `cue_trigger_resolution_total{capability,provenance,outcome}`

## 9. 待确认项

1. 对“Assistant 先明确问 X、用户下一轮回答是”的场景，是否同意把该卡标为 **USER 触发**（本草案建议如此）？
2. Assistant 已经明确说“把 X 设为目的地”时，是否一律弹卡，还是只在用户没有明确否定时弹？本草案建议只要实体唯一且无冲突，就弹卡。
3. 机酒 Assistant 触发是否只限“当前唯一可见报价”，不为纯搜索条件、供应商结果或推荐文案弹卡？本草案建议严格限于此。
4. 是否同意先完成 Destination，再分别灰度 Flight / Hotel，以便验证 Assistant 来源的误触发率？
