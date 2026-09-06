# Cue 与 Trip Brief 触发逻辑统一整改方案

**状态：** 核心运行链路已实施并通过自动化验收；历史数据一次性清理另行执行  
**日期：** 2026-09-06  
**范围：** Destination Cue、Flight Offer Cue、Hotel Offer Cue、出发地更新、通用 Trip Brief 卡，以及它们与 Personal Agent 回复和出行偏好卡的边界。

## 1. 问题结论

当前故障不是单个分类器误判，而是同一个行程字段被多条不对称链路处理：

- Personal Agent 可以在回复中声称“已更新”，但回复生成本身没有 Trip 写权限，也没有校验写入结果；
- 目的地由 Destination Cue 确认，通用 Brief 又保留过目的地抽取与过滤代码，前后端存在重复裁剪；
- 出发地没有独立 Cue，由确定性解析器、模型 Brief extractor 和出行偏好卡共同影响，但三者接受的表达与写入时机不同；
- 通用卡的前端 dismiss 只清本地状态，持久化的 `pendingBriefProposal` 可能在刷新后恢复；
- 精确 Cue 会隐藏通用卡，而出行偏好卡不参加同一仲裁，导致不同字段的卡片互相遮挡或并存规则不一致。

典型失败链是：用户说“出发地改为北京”时，Destination Cue 因其是出发地而正确跳过；确定性出发地解析器不认识“改为”；模型 extractor 即使识别出北京，也会在合并时被删除；因此没有 proposal 和写入，但 Personal Agent 仍可能回复“已更新”。数据库继续保留此前由偏好卡写入的 San Francisco。

## 2. 目标：按字段分权，统一写入边界

| 字段 / 动作 | 唯一语义 owner | 可产生建议的来源 | 唯一确认 / 写入边界 |
| --- | --- | --- | --- |
| 目的地 | Destination Cue | 当前 USER；受限的当前 Assistant 最终回复 fallback | Destination Cue accept |
| 出发地 | Trip Brief origin proposal | 当前 USER 的明确出发地表达；行程偏好表的显式提交 | 通用 Brief accept，或偏好表提交后调用同一 typed mutation service |
| 日期、天数 | Trip Brief scheduling proposal | 当前 USER；仅限同轮明确追认的模型日期解析 | 通用 Brief accept |
| 航班选择 | Flight Offer Cue | 当前 USER；受限的当前 Assistant 最终回复 fallback | Flight Cue accept，仅写 owner-only selection |
| 酒店选择 | Hotel Offer Cue | 当前 USER；受限的当前 Assistant 最终回复 fallback | Hotel Cue accept，仅写 owner-only selection |
| 对话回复 | Personal Agent | 当前 USER + 有界 thread/trip context | 只写消息；不得自行声称业务字段已写入 |

“唯一语义 owner”不意味着只有一个 UI 入口。行程偏好表仍可修改本 Trip 的出发地，但必须复用与 Brief accept 相同的校验、审计和结果合同，不能再拥有一套会复制继承值、顺便清空全部 pending proposal 的旁路。

## 3. 统一触发矩阵

### 3.1 目的地

USER 来源：

- 单个、可唯一解析的裸城市，如“上海”，产生 Destination Cue；
- “去上海”“把上海设为目的地”“考虑上海”“介绍一下上海”可产生 Destination Cue；
- “从北京去上海”只把上海作为目的地，北京交给出发地 proposal；
- “出发地改为北京”“从北京出发”不得产生北京目的地 Cue；
- 多城市比较、否定、国家/区域、歧义地点、纯机酒报价引用不产生目的地 Cue。

Assistant fallback：只有最终可见回复明确提出“把/将 X 设为、列为、确认为目的地”，且本轮 USER 没有产生目的地决策时才运行。推荐、介绍、列举、消歧问题、“如果感兴趣可以去 X”均不触发。

### 3.2 出发地

只接受 USER 当前消息中的明确角色关系：

- `从北京出发`、`北京出发`、`从北京飞上海`；
- `出发地是北京`、`出发城市设为北京`、`把出发地改为北京`、`改从北京走`；
- 对以上表达解析出的城市必须经过城市级 resolver；未知、歧义、国家/区域 fail closed。

裸城市、目的地兴趣、城市介绍、酒店/机票候选名称、Assistant 自己的复述都不得成为出发地。Assistant 不参与 origin proposal fallback。

### 3.3 通用 Trip Brief 卡

通用卡只显示尚未落定的：`departureCities`、`travelDateStart`、`travelDateEnd`、`travelDays`。它永远不携带 `destinationCandidates`、航班或酒店选择。

- 字段按 scope 独立仲裁：目的地 Cue 的存在不得删除或阻止同轮有效的出发地/日期 proposal；UI 固定按 Destination → Flight → Hotel → Brief 显示；
- 同一字段已等于 Trip 当前值时不再弹卡；
- accept 原子写入当前 proposal 中的字段，并仅清除已接受字段；
- dismiss 必须调用服务端并持久清除对应 pending 字段，刷新不得复活；
- 新 proposal 只覆盖同字段旧 proposal，不应清除其他字段；
- 旧版本遗留的 `pendingBriefProposal.destinationCandidates` 在读取时忽略，并通过一次性数据清理移除。

### 3.4 Flight Offer Cue

只有当前 owner/thread/trip 已经展示、未过期的安全 Flight offer projection 才能作为候选。USER 明确选择唯一航班时触发；查看详情、比较、拒绝、重新搜索或指代不唯一时不触发。

仅当 USER 本轮没有 Flight 决策时，才允许以当前最终 Assistant 回复作 fallback；回复必须明确邀请确认一个可唯一解析的当前可见报价。accept 只写 owner-only selection，不预订、不写目的地、不写 Shared Plan。

### 3.5 Hotel Offer Cue

与 Flight 对称，但以 `stayKey` 隔离入住范围。USER 明确选择唯一酒店报价时触发；咨询、比较、泛推荐、拒绝、重新搜索或房型/日期范围不唯一时不触发。

Assistant fallback 只引用当前 owner/thread/trip 已展示且未过期的唯一报价。accept 只写 owner-only selection，不预订、不从酒店城市反推目的地。

## 4. 仲裁顺序

```text
current USER turn
  ├─ deterministic role extraction: origin + dates + days
  ├─ Destination USER decision
  ├─ Flight USER decision（仅有可见报价时）
  ├─ Hotel USER decision（仅有可见报价时）
  └─ Personal Agent 生成最终回复
       ├─ USER 在某 capability 已命中：跳过该 capability 的 Assistant fallback
       └─ USER 未命中：只对最终可见回复运行该 capability 的受限 fallback

server validates and persists each scope independently
  → UI restores all OPEN scopes from REST
  → renders Destination → Flight → Hotel → Brief
```

同一 capability、同一规范实体只能有一张 OPEN 卡。不同 capability 或不同字段的卡不能通过共享的 `hasOpenConfirmationCard` 布尔值互相删除；呈现层可折叠，但不得丢弃服务端状态。

## 5. Personal Agent 的事实一致性约束

主回复模型必须把 `tripContext` 当作本轮开始时的事实，而不是把用户请求当作已完成动作。新增硬性规则：

- 没有本轮服务端 action result 时，不得说“已更新 / 已保存 / 已设为 / 已记录到行程”；
- proposal 已创建但未确认时，只能说“可以在下方确认”；
- Cue accept 或 Brief accept 后的成功文案由服务端动作结果生成，不由普通对话模型猜测；
- 最终输出校验检测业务状态完成式陈述；没有相应 action receipt 时，将其替换为不承诺写入的回复。

## 6. 出行偏好卡整改

- 长期出行偏好页继续实时写长期记忆；
- Trip 内偏好卡只写当前 Trip override，不进入长期记忆；
- 出发地只有在表单明确提交有效值时才写当前 Trip；不得仅因为 Profile 有继承值就在一次无关偏好提交中静默复制；
- 若产品把“提交整张表”定义为确认所有展示字段，前端必须显式提交该 departure value，服务端不得自己补取 Profile；
- 更新出发地时复用统一 Trip draft mutation service；不能无条件把整个 `pendingBriefProposal` 设为 null，只清除已经落定的 departure 字段。

## 7. 实施结果

1. 已按现有 typed Cue / Brief 合同划清 destination、origin/schedule、flight、hotel 五个 scope；没有另造一套写入路径。
2. origin parser 已覆盖“出发地是/设为/改为”“把出发地改为”“改从 X 走”等明确表达，并在持久化前接入城市 resolver。
3. Trip Brief 模型 extractor 已移除目的地和出发地，只允许补充同轮追认的日期/天数。
4. Destination Cue 已实现裸城市→目的地、route 右侧→目的地、明确 origin→跳过，并覆盖 USER 与受限 Assistant fallback。
5. Flight/Hotel Cue 继续使用可见、未过期 offer 门禁；本次回归覆盖两者，未扩张写权限。
6. 偏好卡已停止隐式 Profile departure 回填；明确出发地只更新当前 DRAFT，并只清同字段 pending proposal。
7. 通用卡 dismiss 已改为服务端持久操作，刷新不会复活；accept 继续通过 typed draft brief mutation。
8. UI 已按 scope 独立显示；Destination / Flight / Hotel 的 OPEN 状态不再隐藏 origin/date/duration Brief。
9. 普通对话的 Trip 完成式陈述已增加 prompt 约束和确定性输出校验；只有服务端确认后的 follow-up 可陈述写入成功。
10. 新写入与读取 UI 都会忽略 generic proposal 中的 destination；历史行的一次性物理清理由独立迁移执行，避免在读请求中产生副作用。

## 8. 必测验收

| 场景 | 预期 |
| --- | --- |
| `上海` | 只出现上海目的地卡，不出现出发地卡 |
| `出发地改为北京` | 只出现北京出发地 Brief 卡；Assistant 不得提前说已更新 |
| `从北京去上海，玩三天` | 上海目的地卡 + 北京/3 天 Brief 均保留，互不遮挡 |
| 接受上海、dismiss 北京出发地 | destination=Shanghai；origin 不变；刷新后 Brief 不复活 |
| 偏好卡只改预算 | 不改出发地，不清日期/天数 pending proposal |
| 偏好卡明确提交北京 | 当前 Trip origin=Beijing，不写长期记忆，清掉同字段 pending origin |
| Assistant 推荐北京或杭州 | 不出现目的地卡 |
| Assistant 明确“把北京设为目的地” | USER 未命中时出现一张 Assistant 来源目的地卡，接受后才写 |
| `第一班吧` / `就住这家` | 只有存在唯一、已展示、未过期报价时显示对应卡 |
| 机酒卡 accept | 只写个人选择；不写 destination/origin，不产生预订 |
| 任一卡刷新、SSE 重连、重复 accept | REST 恢复同一张卡，幂等且无重复写入 |

## 9. 完成标准

- 每个字段只有一个服务端语义 owner 和一个可审计写入合同；
- 模型建议、UI 展示和数据库事实三者可从 action receipt 对齐；
- 任一 scope 的触发、dismiss、accept 不改变其他 scope；
- 所有成功式 Assistant 文案都有真实服务端结果支撑；
- 单元、合同、API、Worker、Web 恢复和至少一条数据库集成测试覆盖上述矩阵。
