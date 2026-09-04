---
name: thread.title.suggest
source-of-truth: ./thread-title-suggest-skill.ts
agent: personal
status: implemented
---

# `thread.title.suggest`

Owner-triggered LLM title suggestion for a private chat thread.
See `docs/thread-title-lifecycle-implementation.md` §9.

## 注册元数据

| `name` | `thread.title.suggest` |
| `agent` | `personal` |
| `version` | `1.0.0` |
| `allowedTools` | `[]` |
| `timeoutMs` | `4000` |
| `needsConfirm` | `false` |

## 输入 Schema

```ts
{
  threadId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  messages: z.array(z.object({
    text: z.string().min(1).max(512),  // 服务端截断后传入
  })).min(1).max(3),
}
```

## 输出 Schema

```ts
{ title: z.string().min(1).max(40) }
```

## Handler 语义

1. 取 `modelGateway()`；若未实现 `generateThreadTitle` 则抛 `UPSTREAM_FAILURE`
2. 调用 `gateway.generateThreadTitle({ locale, messages, signal, ctx })`
3. 用 `threadTitleSuggestOutputSchema.safeParse` 解析；失败抛 `OUTPUT_INVALID`
4. gateway 调用异常一律抛 `UPSTREAM_FAILURE`
5. **不**做安全清洗——后处理在路由层（`services/thread-title-suggest-postprocess.ts`）

## 强制约束

| 约束 | 理由 |
|---|---|
| 禁止输入 Profile / Personal Note / 长期记忆 / 其他 thread / ASSISTANT 消息 / provider offer / constraint snapshot / consent / trip 成员信息 | 输入仅 OWNER USER 消息，1–3 条各 ≤512 字符，参考 spec §9.1 |
| 语言权威按 `LLM-GATEWAY.md` §User-visible language contract：用服务端校验过的 `locale`（本调用无"当前问题"） | 显式用户授权触发，避免模型误判语言 |
| 输出长度硬上限 40 字符（字素簇） | 后处理硬截断与 schema 上限共同保证 |
| 抛出 `SkillError` 由 `invokeSkill` 映射为响应；不返回部分结果 | fail closed；title 失败必须不写库 |

## 失败模式

| Error code | 触发条件 |
|---|---|
| `TIMEOUT` | `invokeSkill` 的 `AbortController.timeout(4000)` 触发（registry 自管） |
| `INPUT_INVALID` | `input.parse` 失败（registry 自管） |
| `OUTPUT_INVALID` | gateway 返回值无法通过 `threadTitleSuggestOutputSchema.safeParse` |
| `UPSTREAM_FAILURE` | gateway 未实现 `generateThreadTitle` 或调用抛错 |
| `TOOL_NOT_ALLOWED` | `allowedTools` 含被 personal 策略拒绝的 scope（registry 自管） |
| `SKILL_VERSION_MISMATCH` | 调用方传 `expectedVersion` 与注册版本不一致（registry 自管） |
| `NETWORK` / `RATE_LIMITED` / `UPSTREAM_5XX` | 框架通用错误（registry 自管） |

## 路由层语义

技能自身只产出受 schema 约束的输出；标题是否最终写入由
`POST /trips/:tripId/threads/:threadId/title/suggest` 决定，详见
`docs/thread-title-lifecycle-implementation.md` §6.2 / §7.2。
后处理模块的 7 条拒绝规则在路由层应用，全部 `REJECTED`。
