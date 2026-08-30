# Activities LLM Tool 实施方案

**状态：** Shared `activities.search` Phase 1 已实施；Personal conversation tool-loop 待实施
**Provider：** Viator 官方 Experiences MCP
**范围：** provider-neutral `activities.search`、Shared PLAN/REPLAN function tool、严格 `UNAVAILABLE`、normalized evidence、审计/指标、run/snapshot 覆盖门禁。
**不在范围：** Affiliate/REST API、身份证验证、API key、真实预订/支付、click-off 跳转、无币种价格展示、fixture 运行时回退、Personal streaming tool-loop。

关联事实来源：[TECH_STACK.md](../TECH_STACK.md) · [PRD.md](PRD.md) · [backlog.md](backlog.md) · [test-scenarios.md](test-scenarios.md) · [runtime-data-policy.md](runtime-data-policy.md)

---

## 1. Provider 决策

Viator Affiliate REST 注册流程当前要求账户身份验证，可能包括证件与自拍。该流程对 hackathon 的只读活动发现并不相称，因此不作为本阶段依赖。

Viator 官方 Experiences MCP 文档公开以下 endpoint，当前无需 Affiliate API key：

```text
https://exp-app-mcp.prod.ep.viator.com/mcp
```

2026-08-29 的无凭据 live spike 已验证：

- JSON-RPC `initialize` 成功，server 为 `experiences-mcp@1.0.0`；
- `tools/call → search_experiences` 返回 `structuredContent`；
- 响应包含标题、图片、评分、评论数、取消标记、价格数值、时长、分类与 click-off URL；
- 官方 MCP 未公布固定配额或 SLA，只承诺存在限流。

因此本实现通过 `ActivitiesProvider` anti-corruption layer 使用 MCP，但不让模型、浏览器或计划数据依赖 MCP 协议本身。后续改为 REST 或其他供应商时，`activities.search` Tool contract 不变。

---

## 2. 事实与安全边界

1. 模型只可提交 snapshot 中已有的 `destinationId`、固定 `theme` 与 `locale`。`snapshotId`、日期、trip/run authority 均由服务端注入。
2. Adapter 根据受控 destination/theme 构造 `searchTerm`；模型和浏览器不得提交自由查询、provider URL、坐标、价格、session ID 或 MCP 参数。
3. Viator MCP 当前返回 `fromPrice` 但没有显式 currency。为避免错误价格事实，adapter 验证该字段存在且类型正确，然后丢弃，不进入 Tool output、数据库、plan、SSE 或日志。
4. `clickOffToLander` 同样只用于验证 provider schema，随后丢弃。MVP 不展示或持久化 booking/affiliate link。
5. provider 文本和 raw JSON-RPC payload 都是不可信数据；模型只接收严格 Zod 归一化结果。
6. 失败、超时、限流、空结果、协议错误或 schema drift 统一 fail closed 为 bounded `UNAVAILABLE`；不得使用 fixture、Demo data 或模型编造活动。
7. LIVE evidence 绑定同一 `snapshotId`、`agentTaskRunId` 与 destination；跨 snapshot/run、Personal evidence 或过期 evidence 不得生成可确认 plan。

---

## 3. Tool contract

### Shared input

```ts
type ActivitiesSearchInput = {
  snapshotId: string; // dispatcher 注入；不暴露给模型
  destinationId: string;
  theme?: "CULTURE" | "FOOD" | "OUTDOOR" | "FAMILY";
  locale: "en" | "zh";
};
```

Model-visible arguments 不含 `snapshotId`。日期始终取 immutable snapshot 的 `travelDateStart` / `travelDateEnd`。

### Output

```ts
type ActivitiesSearchOutput =
  | {
      outcome: "LIVE";
      queryId: string;
      activities: Array<{
        id: string;
        providerOfferId: string;
        providerName: "viator";
        queryId: string;
        destination: string;
        title: string;
        thumbnailUrl: string;
        rating: number | null;
        reviewCount: number;
        freeCancellation: boolean;
        durationMinutes: { fixed: number | null; from: number | null; to: number | null };
        category: string | null;
        source: "Viator Experiences MCP";
        capturedAt: string;
        expiresAt: string;
      }>;
    }
  | { outcome: "UNAVAILABLE"; code: ActivityUnavailableCode };
```

`ActivityUnavailableCode` 复用项目现有 8 码：`NOT_CONFIGURED`、`SEARCH_CONSTRAINTS_INCOMPLETE`、`NO_RESULTS`、`RATE_LIMITED`、`UPSTREAM_TIMEOUT`、`UPSTREAM_FAILURE`、`INVALID_PROVIDER_RESPONSE`、`PROVIDER_NOT_APPROVED`。

---

## 4. 调用链与门禁

```text
authenticated PLAN / REPLAN Worker
  → immutable constraint_snapshot
  → ModelGateway.generateStructuredPlanWithTools
  → model requests activities.search for a snapshot destination
  → dispatcher injects snapshot/trip/run authority
  → DefaultPolicyGate(shared) requires snapshot:read + activities:search
  → ViatorMcpActivitiesProvider
  → strict JSON-RPC + structuredContent validation
  → normalize and discard price/link/raw payload
  → persist provider_search_runs(category=activity)
  → LIVE only: persist normalized provider_offers
  → activity research matrix checks every destination in same run/snapshot
  → final plan validator deep-compares selected activity evidence
  → complete and unexpired evidence only may cross plan persistence boundary
```

`PLAN_ENABLE_ACTIVITIES=false` 时 Tool 不向 planning model 暴露，原有 flight/stay/ground 行为保持不变。启用后，每个 snapshot destination 都必须产生同 run/snapshot 的一次尝试记录；`MISSING` 仍以 `PLANNING_DATA_UNAVAILABLE` 关闭，`UNAVAILABLE` 则进入 `COMPLETED_WITH_GAPS` research summary。只有 `LIVE` activities evidence 可进入 plan，缺失时不得由模型补写活动。

---

## 5. MCP adapter 行为

- Transport：HTTP POST JSON-RPC 2.0，接受 `application/json` 与 `text/event-stream`。
- Tool：`search_experiences`。
- 每次请求生成不含用户信息的随机 MCP `sessionId`。
- 默认每次最多返回 5 个结果。
- response body 上限 1 MB；超过即 `INVALID_PROVIDER_RESPONSE`。
- transient retry 只适用于 timeout 与 5xx/network；默认最多重试 1 次，可配置为 0..2。429 立即返回 `RATE_LIMITED`，避免在 provider 未给出 reset window 时放大公共 MCP 压力。
- caller cancellation 立即向上传播，不伪装成 provider timeout。
- 401/403 → `PROVIDER_NOT_APPROVED`；429 → `RATE_LIMITED`；空数组 → `NO_RESULTS`；schema drift → `INVALID_PROVIDER_RESPONSE`。

MCP 的 currency-less `fromPrice` 和 click-off URL 不会出现在 normalized contract。若未来 Viator contract 增加明确 currency，需要另行更新 schema、测试、UI 文案和 plan evidence contract，不能静默开始展示。

---

## 6. 配置

```dotenv
VIATOR_MCP_ENABLED=false
VIATOR_MCP_URL=https://exp-app-mcp.prod.ep.viator.com/mcp
VIATOR_MCP_TIMEOUT_MS=8000
VIATOR_MCP_MAX_RETRIES=1
PLAN_ENABLE_ACTIVITIES=false
```

- 不需要 API key、Affiliate account、证件或自拍。
- `VIATOR_MCP_ENABLED=true` 才创建 live adapter；否则 factory 返回 `NOT_CONFIGURED` provider。
- URL 必须为 HTTPS。
- `MODEL_GATEWAY_TOOL_CALLING_ENABLED=true` 仍需配置并通过既有 function-calling spike；activities flag 不绕过该门禁。
- 当前部署要启用 Shared activities，需要同时设置 `VIATOR_MCP_ENABLED=true` 与 `PLAN_ENABLE_ACTIVITIES=true`。

---

## 7. 数据、审计与可观测性

Migration `0025_viator_mcp_activities_tool.sql` 新增 activities search audit enum，并将 `provider_search_runs.destination_id` 扩展到 128 字符。

持久化边界：

- `provider_search_runs.category='activity'` 保存 provider、snapshot/run binding、受控 destination、fingerprint、outcome 与 bounded error code；
- LIVE 时 `provider_offers.category='activity'` 只保存 normalized evidence；
- 不保存 raw JSON-RPC、MCP text、click-off URL、无币种价格、cookie、API credential 或对话正文。

Audit：`ACTIVITIES_SEARCH_REQUESTED`、`ACTIVITIES_SEARCH_COMPLETED`、`ACTIVITIES_SEARCH_UNAVAILABLE`。

Metrics：

- `activities_provider_requests_total{outcome,provider,error_category}`
- `activities_provider_latency_ms{provider,outcome}`
- `activities_tool_invocations_total{outcome,provider,error_category}`

所有 labels 使用固定低基数 allow-list；destination/trip/snapshot/run/user 不进入指标标签。

---

## 8. Personal Agent 边界

本阶段没有把 activities Tool 接入 Personal streaming conversation。原因不是 provider 限制，而是当前架构的两个控制边界尚未完成：

1. Registry 当前按 `skill.name` 全局唯一，不能同时安全注册 Shared 与 Personal 两个同名 `activities.search`；
2. Personal conversation 当前使用安全 delta gate，尚无能在 tool call 后再安全流式输出最终文本的 owner-bound dispatcher。

不得以复用 Shared snapshot、关闭安全 delta gate或让模型直连 MCP 的方式绕过。后续 Personal phase 必须提供 agent-qualified registry key、owner/thread/trip context、独立 Personal evidence persistence 与 streaming tool-loop 测试后才能启用。

---

## 9. 测试与验证

自动化覆盖：live structured content normalization；click-off URL 与 currency-less price 丢弃；429、timeout、malformed response → bounded `UNAVAILABLE`；config opt-in、HTTPS 与数值范围；snapshot/destination/date authority；existing plan validator 与 LLM tool loop regression；typecheck、lint、build、docs verify。

Live spike 只允许合成 destination/date，不包含用户、Trip 或聊天数据。CI 不依赖 live MCP；fixture 只用于 adapter contract tests，不进入产品运行路径。

---

## 10. 已知限制与回滚

- Viator MCP 没有公开固定 quota/SLA，可能随时 rate limit 或改变 schema；严格 fail closed 与 adapter contract tests 是必要门禁。
- 当前没有可信 currency，因此不显示价格。
- 当前没有 booking、availability confirmation 或支付能力。
- 当前 theme 只影响服务端构造的受控查询，不是 coverage 维度。
- 当前只实现 Shared Tool；Personal 支持按第 8 节单独交付。

回滚只需设置 `PLAN_ENABLE_ACTIVITIES=false` 与 `VIATOR_MCP_ENABLED=false`。已持久化 evidence 保持只读并按 expiry 失效；不得把历史 evidence 当作 fallback。
