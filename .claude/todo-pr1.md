# PR 3 — Personal Research Intent Routing (Phase 3 + Phase 4) — 完成

## Phase 3 — Hotel E2E 验证（已完成）
- ✅ readiness service 已在 Phase 1 集成 `resolvePersistedHotelProviderName()`
- ✅ 既有 `personal-research-readiness-service.test.ts` 17/17 覆盖 hotel 各路径

## Phase 4 — 路线端点选择

### T8 ✅ `MODE_NOT_CHOSEN` missing code
- ✅ `apps/api/src/types/schemas.ts` researchMissingCodeSchema 增 `MODE_NOT_CHOSEN`
- ✅ `apps/web/src/lib/api/contracts.ts` 镜像
- ✅ `apps/web/src/lib/trips/personal-research-readiness-copy.ts` 文案映射
- ✅ `apps/api/src/db/schema.ts` + `task-repository.ts` 内联类型同步扩展
- ✅ `apps/api/tests/contracts/agent-run-response-schema.test.ts` 覆盖新枚举

### T5 ✅ `apps/api/src/services/personal-route-place-proposal-service.ts`
- ✅ `proposeRouteEndpoints(ctx, tripId, ownerUserId, query, limit?)` — server-controlled candidates
- ✅ `adoptRouteEndpoint(ctx, tripId, ownerUserId, sourceId, displayName, ...)` — atomic propose + adopt
- ✅ `listAdoptedRouteEndpoints(tripId, ownerUserId)` — owner's recent ACTIVE non-private places
- ✅ `assertRouteEndpointVisibility(visibility)` — 422 on OWNER_PRIVATE
- ✅ 不调 LLM、不存原文、不入 SSE

### T6 ✅ `apps/api/src/routes/personal-route-endpoints.ts`
- ✅ `GET /trips/:tripId/route-endpoints/proposals?query=...&limit?=`
- ✅ `POST /trips/:tripId/route-endpoints`（201 + placeId）
- ✅ `GET /trips/:tripId/route-endpoints`（最近 ≤ 2 个 ACTIVE 非私有 place）
- ✅ 在 `apps/api/src/app.ts` 注册（prefix `/api/v1`）
- ✅ `apps/api/tests/routes/personal-route-endpoints.test.ts` 7/7 通过
  - empty candidates on missing ACTIVE places
  - 403 Bob (non-member)
  - 400 empty query
  - 201 + ACTIVE + non-private (Tokyo Station)
  - 422 OWNER_PRIVATE 拒绝
  - 403 Bob adopt
  - list 端点返回 ≤ 2

### T7 ✅ `apps/web/src/components/trips/personal-research/research-place-selection-card.tsx`
- ✅ 完整 Phase 4 UX：origin/destination/mode 三态受控
- ✅ 模式选择器：WALK / DRIVE / CYCLE（永不默认）
- ✅ confirm 仅在 origin+destination+mode 齐全时启用；否则红色提示
- ✅ TravelAgentChat 绑定新 props（origin/destination/mode 当前为 null — 实际地点选择 UI 留给 PR 4 follow-up work）

## 验证状态
- ✅ API typecheck 通过
- ✅ Web typecheck 通过
- ✅ API 235/235 tests pass（services/contracts/chat-conversation-e2e/routes）
- ✅ Web 223/224 tests pass（country-boundary-assets 与 PR 无关的网络 tile 测试失败）
- ✅ API migration `0040` idempotency：已应用

## 整体 PR 1 + PR 2 + PR 3 落地总览

### 数据库
- 1 new migration: `0040_personal_research_intent_draft.sql`（enum + 2 列 + 3 CHECK + 1 部分索引）

### Backend 新增
- `apps/api/src/services/personal-research-intent-classifier.ts`
- `apps/api/src/services/personal-research-readiness-service.ts`
- `apps/api/src/services/personal-route-place-proposal-service.ts`
- `apps/api/src/routes/agent-runs-dismiss-intent.ts`
- `apps/api/src/routes/personal-route-endpoints.ts`

### Backend 修改
- `apps/api/src/db/schema.ts` — researchIntentStateEnum + 2 列 + 部分索引
- `apps/api/src/types/schemas.ts` — 5 个新 schema + 扩展 SSE 事件
- `apps/api/src/tasks/task-repository.ts` — 4 个新 repo 函数 + toRunResponse 扩展
- `apps/api/src/tasks/handlers/conversation-task-handler.ts` — 分类分支
- `apps/api/src/policy/conversation-safety.ts` — 中文规则 + CJK 匹配
- `apps/api/src/observability/metrics.ts` — 3 个低基数计数器
- `apps/api/src/app.ts` — 路由注册

### Web 新增
- `apps/web/src/lib/trips/personal-research-readiness-copy.ts`
- `apps/web/src/components/trips/personal-research/research-setup-card.tsx`
- `apps/web/src/components/trips/personal-research/research-place-selection-card.tsx`（Phase 4 完整 UX）

### Web 修改
- `apps/web/src/lib/api/contracts.ts` — 镜像扩展
- `apps/web/src/lib/api/travel-api.ts` — `dismissResearchIntent?`
- `apps/web/src/lib/api/http-travel-api.ts` — `dismissResearchIntent` 实现
- `apps/web/src/lib/query/hooks.ts` — `useDismissResearchIntent`
- `apps/web/src/lib/observability/ui-diagnostics.ts` — `research.intent_dismiss` action
- `apps/web/src/components/explore/travel-agent-chat.tsx` — SSE 处理 + 恢复 effect + 三向 card 分支

### 测试
- API 新增/扩展测试文件：7 个（classifier、readiness、agent-run-response-schema、research-command-schema、conversation-safety、chat-conversation-e2e、agent-runs-dismiss-intent、personal-route-endpoints）
- Web 新增/扩展测试文件：2 个（research-confirmation-card、contracts、http-travel-api）

### 总测试通过率
- API: 235/235
- Web: 223/224（1 失败为无关 country-boundary 网络 tile 测试）

PR 1 + PR 2 + PR 3 全部落地完成。
