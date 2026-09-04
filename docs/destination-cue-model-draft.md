# Destination Cue Decision Model

**状态：** v1 已落地合同
**范围：** 只决定是否显示 `Set {city} as the destination?`；航班采用与酒店采用后续各自使用独立模型。

## 1. 权威边界

- 仅 `DRAFT` Trip 的 creator 可产生或处理 Cue。
- 模型只收到当前 USER 消息、当前已确认目的地名称与界面语言；不接收 Assistant 回复、历史原文、地图选中地点、Profile、供应商结果或同行对话。
- 普通机票/航班/酒店/住宿查询由服务端确定性规则直接排除。
- 同一句中若存在明确“把 X 设为目的地”的指令，该明确指令优先，仍交给模型提取 X。
- 模型只能建议；候选必须由服务端 `LocationReferenceResolver` 唯一解析为城市，未知、歧义、代词、国家或区域均 fail closed。
- 已在 Trip 中的城市与同批重复城市会被删除。模型失败、超时或无效 JSON 不影响正常聊天。

## 2. 模型合同

```ts
type Input = {
  currentMessage: string;
  currentDestinations: string[];
  locale: "en" | "zh";
};

type Output = {
  disposition: "PROPOSE" | "DO_NOT_PROPOSE" | "AMBIGUOUS";
  candidates: Array<{ mentionedText: string; ordinal: 0 | 1 | 2 | 3 | 4 }>;
  reasonCode:
    | "EXPLICIT_DESTINATION_COMMAND"
    | "QUALIFIED_DESTINATION_MENTION"
    | "FLIGHT_OR_HOTEL_QUERY"
    | "NO_DESTINATION"
    | "AMBIGUOUS_REFERENCE";
};
```

`PROPOSE` 必须包含 1–5 个候选；其他 disposition 不得包含候选。服务端按文本顺序重新编号、解析、去重并生成不可逆 candidate hash。

## 3. 持久状态与恢复

Cue 不再使用共享的 `shared_trips.pending_brief_proposal`。数据库分别保存：

- `destination_cue_batches`：owner/thread/trip/source run、模型与 prompt 版本、OPEN/RESOLVED/SUPERSEDED 状态及乐观锁版本；
- `destination_cue_candidates`：规范城市、国家码、hash、顺序及逐项状态；
- `destination_cue_suppressions`：按 `(owner, trip, candidate hash)` 保存忽略时间与合格提及计数。

不保存当前 USER 消息、Assistant 回复、prompt、坐标或模型 rationale。`GET /threads/:threadId/conversation` 是刷新恢复的权威来源；`destination.cue_ready` SSE 只负责即时显示。

## 4. 忽略与再次提示

- 忽略只作用于当前候选，不关闭同批其他候选。
- 再次提示同时要求：忽略后至少 30 分钟，且之后出现 2 次合格 USER 提及。
- 连续 24 小时没有合格提及时旧抑制清零；下一次合格提及按首次提及显示。
- Agent 提及、机酒查询、刷新与任务重试均不计数。

## 5. 多地点 UI 与写入

- 卡片永远显示具体城市名，不允许 `Set this ...`。
- 多个候选在右上角显示左右切换箭头；箭头仅切换，不代表指向地点，也不写数据库。
- 接受或忽略只处理当前候选；处理后从队列移除，所有候选必须逐一完成。
- 两个动作按钮并排。接受时服务端原子追加规范城市并按现有规则更新 AUTO title；忽略时写 suppression。
- 每次动作要求 `requestId` 与 `expectedVersion`，重复请求幂等，陈旧版本返回 409 后客户端从会话恢复。

接口：

```http
POST /api/v1/threads/:threadId/destination-cues/:cueId/candidates/:candidateId/accept
POST /api/v1/threads/:threadId/destination-cues/:cueId/candidates/:candidateId/dismiss
```

## 6. 与 Trip Brief 的关系

原 Trip Brief review 继续负责出发地、日期和天数；其 destination 字段不再渲染目的地确认，也不会由地图选中状态隐式生成。日期-only/天数-only 提案使用独立的“保存这些行程信息？”文案。

## 7. 必测场景

- 明确设目的地 + 同句机酒请求仍显示具体城市；普通机酒查询不显示。
- Agent 单独提城市、代词、未知/歧义地点、已有目的地均不显示。
- 一句三个城市按顺序切换；接受一个后其余仍保留，全部逐项处理。
- 忽略后的 `30m + 2 mentions`、24h silence reset。
- SSE 丢失、刷新、重复 action、陈旧 version、模型超时和 resolver 不可用。
- 任何失败都不阻止 USER/ASSISTANT 消息持久化和正常流式回复。
