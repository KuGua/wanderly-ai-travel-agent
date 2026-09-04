# 2026-09-04 — 简报确认卡永远保存失败（日期年份漂移）

## 现象

Trip `51a308ca-a28e-4ec6-914e-b9ee39d897b9` 的私有对话里出现确认卡「你想将 Shanghai 作为目的地吗？」。点击「把 Shanghai 保存到这趟行程」后提示：

> 这条消息暂时无法被接受。请刷新对话后重试。

刷新无效，重复点击也无效——`api-2026-09-04.ndjson` 里 13:29:41–42 有三条连续的 400。

## 根因

用户在 thread `ba500ab8` 写的是「我想要10月1号到10月7号去上海」，**没有给年份**。这一轮的提案由两个互不知情的来源拼成：

| 字段 | 来源 | 值 |
|---|---|---|
| `travelDateStart` | 确定性解析器 `proposeTripBriefFromTurn` | `2026-10-01` ✅ |
| `travelDateEnd` | 模型抽取器 `extractTripBriefProposal` | `2024-10-07` ❌ |

- 确定性解析器当时只认句子里的**第一个**日期，且它的 `extractDate` 有正确的推年逻辑（无年份则取今天之后最近的一次），所以开始日期是对的；
- 结束日期只能由模型补，而 `TRIP_BRIEF_EXTRACTION_SYSTEM_PROMPT` **从未告诉模型今天是哪一天**。模型只能按训练数据推断年份，稳定地退回 2024；
- `mergeTripBriefProposal` 只做浅合并，**没有任何一处比较过这两个日期**。

合并结果经 `agent-task-worker.ts` 的 jsonb `||` 写入 `shared_trips.pending_brief_proposal` 并常驻。点击时 `PATCH /trips/:tripId/draft-brief` 的 `end < start` 校验抛 400，前端把所有 400 映射成 `chat.requestInvalid`（「请刷新对话后重试」）。这条建议本身是错的：被拒绝的日期存在服务端，刷新只会把同一份取回来。

对话主模型早在此前就修过同一类问题——`currentDateRule`（`llm-gateway.ts`，注释记录模型曾「believed it was 2024, and stored a check-in of 2024-12-20」）——但抽取器这条调用路径从未接上它。

## 被 400 挡住的只是一半

同一天另一个 run（`6ddf8911`）抽出的是 `{"travelDateStart":"2024-10-01","travelDateEnd":"2024-10-01"}`。这一对**自身是自洽的**，于是通过了写边界校验并静默保存：trip `9b39a457` 的出行日期成为 2024-10-01，自动标题变成「行程规划｜1天」。没有任何报错。

## 为什么卡片出现在一个空对话里

`pending_brief_proposal` 挂在 **trip** 上，而 `TravelAgentChat` 无条件把它 hydrate 成卡片。用户打开的 thread `22f78811` 一条消息都没有（提案产生于同一 trip 的另一个 thread `ba500ab8`），所以界面呈现为「空对话 + 一张凭空出现的确认卡」。这是设计如此——提案描述的是行程而不是某一次对话——但它让这次故障更难理解。

## 修复

1. **确定性解析器学会读日期区间**（`trip-brief-proposal-service.ts` 的 `extractDateRange`）。「10月1号到10月7号」「10月1号到7号」「12月28号到1月3号」「October 1 to October 7」「2026-10-01 to 2026-10-07」都直接产出 `start` + `end`，模型不再是结束日期的唯一来源。
2. **给抽取器注入今天**（`tripBriefExtractionSystemPrompt(now)`），复用对话模型已有的 `currentDateRule`，并加两条规则：无年份取今天之后最近的一次；`travelDateEnd` 必须 ≥ `travelDateStart`，做不到就两个都不要给。
3. **落库前自洽校验**（`coherentBriefDates`）。同轮合并（`mergeTripBriefProposal`）与跨轮合并（`mergePendingBriefProposal`）都过这道闸；不自洽时剥掉日期字段而保留目的地。worker 的 jsonb `||` 换成加行锁的读-改-写，因为 `||` 只能覆盖键、无法拒绝组合。指标 `trip_brief_proposal_dates_total{result}` 记录 `ok / end_before_start / in_past / malformed`。
4. **写边界给出可分辨的错误码**：400 的 message 加 `BRIEF_DATES_INVALID:` 前缀，前端据此给出真正可执行的建议。
5. **卡片显示即将保存的日期**。此前它只显示目的地，2024 这个错误是隐形夹带的。

## 已有脏数据

`scripts/clean-incoherent-brief-proposals.ts`（默认 dry-run，`--apply` 才写）已在本地执行：

- trip `51a308ca` 的提案剥掉日期，保留 `{"destinationCandidates":["Shanghai"]}`，卡片恢复可保存；
- trip `9b39a457` 的 2024 出行日期**只报告不改写**——已确认的 brief 是创建者拥有的行程事实，替创建者猜一个年份是同一个错误的反方向。
