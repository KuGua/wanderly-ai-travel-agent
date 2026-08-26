# Agent 流式显示实施规范

**状态：** 已确认，待实施
**范围：** Personal Agent 对话的安全增量文本，以及 planning/replan 的安全阶段事件。
**任务执行权威规范：** [`durable-agent-execution-implementation.md`](./durable-agent-execution-implementation.md)。该文档定义持久任务、Worker 租约、取消、重试、API、数据库与部署；本文件只保留流式显示的不可变边界。

## 强制语义

1. `POST` 命令创建持久 Agent task 并返回 `202`；SSE 是独立的、带 Bearer 鉴权的 `fetch` 订阅，不承载任务执行。
2. 浏览器关闭、刷新、网络中断、SSE disconnect、组件卸载或订阅 fetch abort 仅关闭观察连接，绝不取消已接受任务。
3. `POST /agent-runs/:runId/cancel` 是唯一取消入口。只有用户显式触发时，服务端才将 task 标记为 `CANCEL_REQUESTED` 并由 Worker abort 上游调用。
4. 对话显示的每个 `message.delta` 必须先通过 streaming safety gate；禁止原样转发模型 token。最终 assistant 文本还必须通过完整 policy/结构校验，才可持久化。
5. planning/replan 只允许 `run.phase` 和引用已持久化结果的 terminal event；禁止文本 delta、推理、raw provider payload、完整 snapshot 或未验证候选。
6. SSE event、partial text 和 connection state 是易失 UI 数据，不得写入 `chat_messages`、plan、localStorage、审计、日志、trace 或指标。SSE 丢失/晚连不是失败；客户端应读取 task 状态与最终资源。

## 事件契约

所有事件均使用严格 JSON `data`；event payload 不含 prompt、question、chain-of-thought、raw model/tool/provider payload、token usage、完整 snapshot、未授权 Profile、国籍、证件或底层错误文本。

| Event | 必填字段 | 适用范围 |
|---|---|---|
| `turn.started` | `runId`, `generationAttempt` | 已被 Worker 成功领取的 task。 |
| `run.phase` | `runId`, `phase` | allow-list phase；对话与 planning/replan 均可用。 |
| `message.delta` | `runId`, `generationAttempt`, `sequence`, `delta` | 仅 Personal conversation；已通过 streaming gate 且受大小限制。 |
| `turn.completed` | `runId`, `result` | 仅引用已经事务提交的 assistant message 或 plan ID/version。 |
| `turn.cancelled` | `runId` | 仅由显式 Stop 导致。 |
| `turn.stale` | `runId`, `code` | planning/replan 被新版本或授权变化作废。 |
| `turn.failed` | `runId`, `code`, `retryable` | 只使用 allow-listed 安全错误码。 |

推荐 phase enum：`ACCEPTED`、`RESEARCHING`、`GENERATING`、`VALIDATING`、`PERSISTING`、`RETRYING`、`COMPLETED`、`STALE`、`FAILED`。

`generationAttempt` 在每次 Worker 重试时递增。前端收到更大的 attempt 必须清空上一次的 temporary bubble，防止把两次模型生成拼接为一条回答。

## 实现接入

| 层 | 模块 | 变更 |
|---|---|---|
| API | `routes/chat-threads.ts`、`routes/planning.ts`、新增 `routes/agent-runs.ts` | 命令改为 `202` task acceptance；新增 task read、explicit cancel 与 SSE subscribe。 |
| Worker | 新增 `workers/agent-task-worker.ts` | 持有模型 stream，校验 delta 后发布易失 event；不感知浏览器连接。 |
| Relay | 新增 `observability/agent-stream-relay.ts` | `LISTEN/NOTIFY` 的 schema/大小校验、跨 API instance 分发和连接清理。它不是任务队列。 |
| Gateway/Skill | `model-gateway.ts`、`llm-gateway.ts`、conversation skill | 增加受控 async stream、UTF-8/文本上限、安全 gate 与最终完整校验。 |
| Web | `lib/api/*`、`lib/query/hooks.ts`、`travel-agent-chat.tsx` | 以 task state 驱动 UI；路由卸载只 unsubscribe；Stop 才调用 cancel。 |

目标 AWS 链路必须验证 `text/event-stream` 不被缓冲、Bearer header/CORS 可用、keep-alive 和超时配置正确。对 SSE relay、浏览器或 API instance 的任何故障，唯一允许的效果是实时显示降级，不能影响 Worker 继续执行或最终结果持久化。
