# 2026-09-06 — 手填国籍后「开始规划」永远点不动

## 现象

Trip `cc95d07d` 的对话里，Wanderly 说「所有关键信息已经准备就绪，你可以直接点击『开始规划』」，
「行程信息已齐全」卡片也正常展示（国籍选了「台湾（中国）」）。点击「开始规划」后立即出现：

> 这条消息暂时无法被接受。请刷新对话后重试。

刷新无效，重复点击也无效——`apps/api/runtime/api-2026-09-06.ndjson` 里有 11 条连续的 400。

## 根因

`POST /api/v1/trips/:tripId/activate` 被 Fastify 的 schema 校验拒绝：

```
body/quoteNationalityDecision/source must be equal to constant,
body/quoteNationalityDecision must have required property 'value',
body/quoteNationalityDecision must match exactly one schema in oneOf
```

`toJsonSchema(tripActivationRequestSchema)` 生成的 JSON Schema 本身是正确的，判别联合被
译成两个 `additionalProperties: false` 的分支：

| 分支 | required |
|---|---|
| 1 `PROFILE` | `source`, `confirmProviderUse` |
| 2 `INPUT` | `source`, **`value`**, `saveToProfile`, `confirmProviderUse` |

问题在 `buildApp` 没有覆盖 Fastify 默认的 AJV 选项，于是校验以 `removeAdditional: true` 运行。
AJV 在这个模式下**边校验边就地改写请求体**，而 `oneOf` 是按顺序逐个分支求值的：

1. 先跑分支 1（PROFILE），它的 `additionalProperties: false` 把 `value` 和 `saveToProfile`
   **从请求体里删掉**；
2. 分支 1 随后因 `source !== "PROFILE"` 失败；
3. 再跑分支 2（INPUT），此时 `value` 已经不存在 → `must have required property 'value'`；
4. 两个分支都失败 → 400。

因此：

- `source: "PROFILE"`（Profile 里已存国籍）走分支 1 直接通过，**从来没人报错**；
- `source: "INPUT"`（当场手填国籍）**100% 失败**，且失败与用户填了什么无关；
- `POST /planning/generate` 没有挂 Fastify `schema`、纯靠 Zod 校验，所以同一个联合在那条
  路径上是好的——只有 activate 这一条链路炸。

调换 `oneOf` 分支顺序不是修复：`value` 和 `saveToProfile` 照样会被前一个分支删掉，
handler 里的 `tripActivationRequestSchema.parse(request.body)` 会接着抛。

引入于 `d009689 feat: Implement quote nationality decision handling in travel agent chat`。
`quoteNationalityDecision` 当时只有 web 侧测试（fetch mock，绕过真实 AJV），API 侧没有任何
集成测试打过带该字段的 activate。

## 修复

1. **`apps/api/src/app.ts`**：`Fastify({ ajv: { customOptions: { removeAdditional: false } } })`。
   校验不得改写 handler 随后要用 Zod 再解析一遍的载荷。
   副作用是未知字段现在由 AJV 直接 400，而不是被静默删除——这反而更贴合各请求 schema 上
   已有的 `.strict()`：此前 `removeAdditional` 抢在 Zod 之前把多余键删了，`.strict()` 从未生效过。
2. **`apps/api/tests/trip-activate.test.ts`**：补 5 条经 `app.inject` 的集成用例（INPUT 不存
   Profile / INPUT 存 Profile / PROFILE 有值 / PROFILE 无值 422 fail closed / 未知字段 400）。
   这些是唯一会真正跑到 AJV 的测试路径。
3. **`apps/web/messages/{zh,en}.json`**：`chat.requestInvalid` 原文案「请刷新对话后重试」
   是不可执行的建议——被拒绝的是请求本身，刷新不会改变结果。改为说明服务端拒绝了这次操作、
   刷新无用，并给出「检查填写内容 / 反馈」两条真正可做的事。

## 影响范围核查

挂了 AJV body schema 的路由共 12 条，其中含 `oneOf`/`anyOf` 的只有两条：
`tripActivationRequestSchema`（本次故障）与 `updateDraftTripBriefRequestSchema`——后者的联合
是 `travelDate*` 的 `string | null` 标量联合，分支内没有 `additionalProperties`，不受影响。
`location-reference` sidecar 的 Fastify 实例没有注册任何 schema，无需改动。

## 可观测性

这次定位完全依赖既有的 `Request rejected` 结构化日志（`route` / `statusCode` /
`errorCategory` / `errorMessage`）与前端 `ui_api_request` 诊断事件的
`relatedCorrelationId` 关联，两者已经足够，没有新增信号。国籍值在任何一条路径上都没有进入
日志、指标标签或审计摘要。
