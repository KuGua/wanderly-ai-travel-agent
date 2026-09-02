# 2026-08-27 — 私人对话初始化与发送失败诊断

## 现象

探索页持续显示“正在准备你的私人对话…”。首次发送后，页面显示“私人对话暂不可用。”，并显示通用错误“消息发送失败，请重试。”。

## 根因

当前前端的首次发送会先调用 `POST /api/v1/explorations/start`。该路由在同一事务中创建草稿行程、创建者成员资格和默认私有线程；它固定写入 `shared_trips.status = 'DRAFT'`。

本机运行中的 API 使用 PostgreSQL `public` schema。检查结果显示 `schema_migrations` 只记录到 `0012_trip_scoped_threads.sql`，而 `0013_exploration_lifecycle.sql` 尚未应用。该 migration 负责向 `trip_status` 增加 `DRAFT`，同时增加相关 audit action 和状态转换 trigger。因此该 schema 的 `trip_status` 不接受 `DRAFT`，`/explorations/start` 的插入会被 PostgreSQL 拒绝，API 返回 500。

## 为什么出现两条前端提示

`ExploreChatHost` 在没有 `threadId` 时以 `preparing` 显示加载提示；只有 `startExploration()` 成功才会获得默认线程。启动请求失败后，session 变为 `error`，故显示“私人对话暂不可用。”。同一个 rejected Promise 随后让 `TravelAgentChat.sendTurn()` 设置请求错误；未知/500 错误统一映射为“消息发送失败，请重试。”。消息并未到达 `/threads/:threadId/turns`，也未进入模型或 Worker。

## 已验证证据

- API 健康检查 `GET http://127.0.0.1:3000/health` 返回 200，故不是 API 未启动。
- API 运行于 `tsx watch src/server.ts`，会加载当前含 `/explorations/start` 的源码。
- `public.trip_status` 仅含 `PLANNING`、`CONFIRMED`、`BOOKED`、`CANCELLED`、`STALE`；查询 `status = 'DRAFT'` 会报 `invalid input value for enum trip_status: "DRAFT"`。
- `travelagent_test` schema 已有 `DRAFT`，说明 migration 本身可在测试 schema 中生效；问题是本地开发的 `public` schema 漏迁移。

## 恢复步骤（尚未在本次调查执行）

在 `apps/api` 目录对本地开发数据库执行一次：

```powershell
npm run db:migrate
```

然后确认 `schema_migrations` 包含 `0013_exploration_lifecycle.sql`，并重新发送一条探索消息。该命令会写入数据库 schema，需由拥有本地环境操作权限的人执行。若部署环境也出现相同现象，应在对应发布流程中应用 migration，而不是只重启 API。

## 预防

发布含 `DRAFT` 代码路径前，部署健康检查应验证 migration 已记录且 `trip_status` 含 `DRAFT`。现有 `/health` 只验证进程存活，不能发现 schema 版本落后。

## 后续（2026-09-03）：不要把懒加载空窗期误诊成本故障

本文记录的是真故障。但同一句「正在准备你的私人对话…」在 2026-09-03 之前还有第二个来源，与数据库无关：`ExploreChatHost` 把 session 的 `idle` 状态也映射成了 `preparing`，而探索页的线程是**首次发送时才创建**的，于是该横幅在用户发出第一条消息前会一直挂着。该映射已修复（见 `docs/exploration-trip-lifecycle-implementation.md` §4.2.1），`idle` 不再渲染任何横幅。

若日后再看到该提示，先按现象区分，不要直接翻迁移：

- **只是在等首次发送**（修复前的行为）：输入框可用，发出第一条消息后横幅消失，助手正常回复。
- **本文的迁移故障**：发送后横幅变为「私人对话暂不可用。」并出现重试按钮，同时出现「消息发送失败，请重试。」；`POST /api/v1/explorations/start` 返回 500。

只有第二种才需要执行上面的恢复步骤。
