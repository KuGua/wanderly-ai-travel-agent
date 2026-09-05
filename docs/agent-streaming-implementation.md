# Agent 流式显示实施规范

**状态：** Personal conversation slice 已实施；planning/replan 尚未迁移
**范围：** Personal Agent 对话的安全增量文本，以及 planning/replan 的安全阶段事件。  
**任务执行权威规范：** [`durable-agent-execution-implementation.md`](./durable-agent-execution-implementation.md)。该文档定义持久任务、Worker 租约、取消、重试、API、数据库与部署；本文件只保留流式显示的不可变边界。

## 强制语义

1. `POST` 命令创建持久 Agent task 并返回 `202`；SSE 是独立的、带 Bearer 鉴权的 `fetch` 订阅，不承载任务执行。
2. 浏览器关闭、刷新、网络中断、SSE disconnect、组件卸载或订阅 fetch abort 仅关闭观察连接，绝不取消已接受任务。
3. `POST /agent-runs/:runId/cancel` 是唯一取消入口。只有用户显式触发时，服务端才将 task 标记为 `CANCEL_REQUESTED` 并由 Worker abort 上游调用。
4. 对话显示的每个 `message.delta` 必须先通过 streaming safety gate；禁止原样转发模型 token。最终 assistant 文本还必须通过完整 policy/结构校验，才可持久化。
5. planning/replan 只允许 `run.phase` 和引用已持久化结果的 terminal event；禁止文本 delta、推理、raw provider payload、完整 snapshot 或未验证候选。
6. SSE event、partial text 和 connection state 是易失 UI 数据，不得写入 `chat_messages`、plan、localStorage、审计、日志、trace 或指标。SSE 丢失/晚连不是失败；客户端应读取 task 状态与最终资源。

## 显示粒度

第 4 条要求每个 `message.delta` 先经 streaming safety gate 批准，因此 gate 必须先攒够一个完整语义单元才能放行——半句话无法判定 `containsUnsupportedOperationalClaim`。该单元的大小直接决定用户看到的是"打字"还是"整段弹出"。

**单元是子句，不是句子。** `SafeConversationDeltaGate` 早期以句末标点为边界，实测后果：

| 回复 | 句子级实际发出的 SSE 段数 |
|---|---|
| `好的，我来帮你规划这次法国之旅。` | 1 |
| `巴黎是个不错的选择`（无句末标点） | 1，且要等生成结束后的 `flush()` |
| 27 字、三个子句的长句 | 1 |

即绝大多数回复只发一个 delta，SSE 在用户侧退化为整段输出。改用子句边界后同样三例分别为 2 / 1 / 4 段。

`completeClauseBoundary` 的两条约束：

- **CJK 标点**（`。！？，、；：`）单独成界，无歧义。
- **ASCII 标点**（`.!?,;:`）必须后接真实空白。**不得使用 `$`（文本结尾）作为替代分支**——gate 的缓冲区每到达一个 token 就增长一次，结尾在每个中间状态都成立，`$` 会在 `1,000` 的逗号刚到达、`000` 尚不存在时就误判成界；`10:30`、`3.5`、`https://` 同理。尾部不成界的文本由 `flush()` 负责。

回归用例见 `apps/api/tests/conversation-clause-boundary.test.ts`，其模拟逐 token 累加而非直接对成品字符串取边界——只有这种形状才能暴露上述 `$` 陷阱。

**客户端节奏。** 浏览器按终端节奏绘制已批准的子句（`apps/web/src/components/explore/terminal-typing.ts`）。正常路径不是把完整回复拿到后再回放：客户端只绘制已经由 SSE 到达的字符；`active` 结束时立即显示全文，动画不拖慢一轮对话的结束。

**可恢复交付。** 每一条通过 `publishAgentStreamEvent` 的已批准帧，会先写入
`agent_stream_events`，再经 PostgreSQL `NOTIFY` 做低延迟扇出。SSE 连接先订阅
live relay，随后按 `Last-Event-ID` 回放持久化帧；客户端以 `streamEventId` 去重并在
断线后以指数退避重连。因此 worker 在 React effect 开始前已完成的短回复也仍按帧到达，
不会由 conversation 轮询直接替换成整段文本。若历史 run 没有 journal 或 journal 写入失败，
完成态会以已落库的 assistant message 作一次受控揭示，业务状态始终仍以 run / conversation
记录为准。

**文字揭示不受 `prefers-reduced-motion` 门控。** 该表面的装饰性动画是块状光标的闪烁，`globals.css` 已在 reduce 查询下将其关闭。剩下的揭示本身是"内容在到达"，不是装饰；跳过它并不减少运动——文字仍会按服务端批准的子句落地，真实对比是「十几次突兀跳变」对「同样字符平滑流出」。早期版本在此额外做了 reduce 门控，结果是运动更刺眼、功能却静默消失。

**绘制速率必须跟随到达速率，不能是固定值。** 第一版用固定 90 字/秒，结果每个约 12 字的子句在 130ms 内画完，然后静止到下一个子句到达（约 700ms）——一次典型回复 85% 的时间画面是不动的，观感仍是"四块文字依次弹出"而不是打字。现在按运行期内观测到的到达速率的 1.3 倍绘制，让光标始终紧跟在数据前沿之后；`MIN_CHARS_PER_SECOND` 是首帧尚无速率可测时的下限，`CATCH_UP_WINDOW_MS` 是积压过大（突发、或整段回复只有一个 delta）时的兜底阀门。

回归判据见 `terminal-typing.test.ts`：它按 `[到达时刻, 字数]` 重放一次真实运行，断言**静止时长**而不只是断言最终能画完——只有前者能抓住"跳一下冻结一下"这种退化。

---

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
| Relay | 新增 `tasks/agent-stream-relay.ts` | `LISTEN/NOTIFY` 的 schema/大小校验、跨 API instance 分发和连接清理。它不是任务队列。 |
| Gateway/Skill | `model-gateway.ts`、`llm-gateway.ts`、conversation skill | 增加受控 async stream、UTF-8/文本上限、安全 gate 与最终完整校验。 |
| Web | `lib/api/*`、`lib/query/hooks.ts`、`travel-agent-chat.tsx` | 以 task state 驱动 UI；路由卸载只 unsubscribe；Stop 才调用 cancel。 |

目标 AWS 链路必须验证 `text/event-stream` 不被缓冲、Bearer header/CORS 可用、keep-alive 和超时配置正确。对 SSE relay、浏览器或 API instance 的任何故障，唯一允许的效果是实时显示降级，不能影响 Worker 继续执行或最终结果持久化。

SSE handler 通过 `reply.hijack()` 接管 socket，因而跳过 Fastify 的 `onSend`
链。该 handler 必须自行把请求已协商的 header（CORS 决策与 `x-correlation-id`）
写入 raw stream；否则浏览器会拒绝跨源流并静默退化为轮询 run state——最终答案
仍正确，但失去增量显示。回归覆盖见
`apps/api/tests/agent-run-stream-headers.test.ts`。

## 当前实施状态（2026-08-26）

已落地的 conversation 路径包括：`202` acceptance transaction、PostgreSQL
task row、`FOR UPDATE SKIP LOCKED` claim、租约续期与过期恢复、三次有界重试、
显式取消、OpenAI-compatible（含 Gemini）stream、增量 safety gate、最终消息
条件化事务提交、PostgreSQL `LISTEN/NOTIFY` relay、鉴权 fetch-SSE、TanStack
Query run recovery、generation-attempt 去重，以及确定性 message sequence。

### Trace 上下文跨 relay

`AgentStreamEvent` 携带可选 `traceparent`（W3C trace-context 字符串，
`00-<32-hex>-<16-hex>-<flags>`）。Worker 在每次 `publishAgentStreamEvent`
时把同一 trace 写入 NOTIFY payload；`AgentStreamRelay` 派发时把它一并
转发给客户端与 SSE handler；`routes/agent-runs.ts` 收到事件时为每条
`sse.event.<type>` 创建 child span 并通过 `SpanLink` 关联到原 HTTP trace。
事件 payload 仅含 OTel 标识符，绝不含 prompt / nationality / document。

当前明确限制：

- `PLAN`/`REPLAN` 仍走原同步规划服务；虽然数据库和公开 run contract 已保留
  operation enum，本次没有迁移尚未确认的 planning UI/API 行为。
- SSE 是易失观察通道，不提供 event replay。断线期间的 partial text 不恢复；客户端
  通过 run read 与最终 conversation history 恢复。
- 生产 App Runner/ECS/ALB 对 buffering、idle timeout、graceful shutdown 和多实例
  relay 的验证仍是部署前检查，不由本地单元测试替代。
