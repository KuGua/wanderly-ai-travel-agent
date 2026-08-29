# AI Travel Agent — Personal Agents + Shared Trips 待办清单

**状态：** Hackathon MVP；对应 [PRD](PRD.md) 与 [测试场景](test-scenarios.md)
**边界：** 使用已认证用户、用户创建的出发地与目的地候选、来源化旅行工具与 booking sandbox；不接真实支付。Live API 不可用时明确显示不可用，绝不伪装为实时结果。

## 1. 反向审查门槛

| Kill assumption | Fails if | Cheapest test | Action |
|---|---|---|---|
| Profile 是价值而非额外表单 | 用户不愿保存或第二次不复用偏好 | 5 人设置 Profile 并创建第二次行程 | 降为单次偏好模板 |
| 私有 Agent + 授权共享降低协调成本 | 用户看不懂共享边界或仍复制聊天内容 | 两人邀请、授权、查看共享空间 | 简化为明确共享表单，不造群聊 |
| 多品类编排比单一推荐更有说服力 | 评委只看到三张静态卡片 | 展示同一约束快照下的 flight/stay/ground 工具调用 | 缩小展示但保留编排证据 |
| Visa readiness 有用且可信 | 用户不理解来源/适用对象 | 两国籍演示任务，要求解释待办 | 仅展示官方核验链接 |
| Sandbox action 证明 Agentic execution | 被看成假装订票 | 展示确认边界、工具请求和参考号 | 改为 book-ready handoff |

## 2. HERO

### H1 — Maintain a user-owned travel profile

**Story:** As a traveler, I want my private Agent to remember travel preferences I explicitly save, so that I do not have to re-explain myself for every trip.

**Acceptance criteria:**

1. Traveler can create, view, edit and delete stable preferences: budget range, stay style, pace, interests, flight preferences and comfort/risk trade-offs.
2. Every value shows origin (`profile` or `this trip`) and last-updated time.
3. A trip-only change does not overwrite the stable Profile without an explicit save action.
4. Deleting a Profile field prevents it from appearing in future plan inputs.
5. Private Profile values are not visible in any shared trip by default.
6. Traveler can tell the private Agent a trip-specific preference; it is shown as `this trip` (where `this trip` = the trip bound to the thread at creation, see AC7) and is not shared without separate consent.
7. Traveler can create, list, reopen and delete only their own private conversation threads, and every thread is bound to exactly one existing trip. `conversationId` is owned by exactly one `ownerUserId`, persists across sessions, and is not visible to fellow trip members or to the Shared Agent by virtue of the trip binding. Joining a trip provisions an empty default private thread; the member may create further private threads in that same trip. A Personal Agent turn receives only the server-built recent raw-message window from that same owner thread, bounded by fixed turn/character limits and a task acceptance sequence boundary; it never receives another thread, shared data, or browser-supplied history.
8. Deleting a thread removes its message body and does not silently change separately confirmed Profile or trip-override facts; audit retains only `conversationId`, `ownerUserId`, `tripId?`, action, timestamp, and never the message body.
9. A submitted Personal Agent question is persisted with a durable task before streaming begins. Browser close, refresh, network loss and SSE disconnect do not cancel it; only an explicit Stop requests cancellation. The task is lease-recoverable and an ASSISTANT message is persisted only after final safety validation succeeds.
10. Repeated, non-sensitive behavior may create a user-visible, expiring Profile suggestion, but only a user confirmation may create or replace a stable preference fact. Suggestions never enter a snapshot or shared view.
11. Nationality, travel documents, date of birth, health and accessibility data are form-only: no conversation or behavior extraction path may create a proposal for them.

### H1a — Start and resume an exploration-scoped private Trip

**Story:** As a traveler, I want my first message in a new exploration to start a private Trip, while map browsing creates nothing, so that unrelated ideas do not overwrite prior projects or create empty archives.

**Acceptance criteria:**

1. New tabs, full reloads and reopened Explore pages begin an in-memory exploration session; client-side navigation away and back preserves it.
2. Map browsing, coordinate clicks and opening/closing chat create no Trip, thread or audit event.
3. The first submitted message atomically and idempotently creates one `DRAFT` Trip, creator membership and owner-only default thread, then enters the existing durable conversation flow.
4. The visible “Start new exploration” action resets only the in-memory session; it never deletes or silently changes an existing Trip.
5. Draft Trip collaboration commands are rejected server-side until the creator explicitly activates a complete brief as `PLANNING`.

### H2 — Join a shared trip and grant scoped consent

**Story:** As a traveler, I want to join a friend’s trip and choose exactly what my Agent may share for it, so that I get personalized coordination without exposing my private history.

**Acceptance criteria:**

1. Organizer can create one shared trip and invite two additional test travelers.
2. Each traveler can separately approve or decline sharing each relevant profile field and their nationality/entry data.
3. Shared trip shows only approved fields with member and consent source; private chat/history is never displayed.
4. Revoking a shared field immediately expires affected plan and visa outputs.
5. A member without a Profile can join and enter only trip-specific data.
6. Shared Agent receives current-Trip memory only through the consent-derived snapshot projection; it cannot query a member Profile, preference fact, private thread or a prior Trip's memory directly. A projected memory change invalidates the active plan and confirmations.

### H3 — Orchestrate a personalized multi-service trip

**Story:** As a group departing from two places, I want the Shared Trip Agent to compare two to three destination options with flights, stay, local transport and activities using our authorized preferences, so that we can make one transparent choice instead of coordinating separate tools ourselves.

**Acceptance criteria:**

1. Shared Agent sends one versioned shared-constraint snapshot to Flight, Stay, Activities and Ground typed tools and maps the three travelers to two origins. LLM may request `flight.search`、`activities.search`、`places.search` 与 `navigation.route`；服务端验证每个参数和 run binding。Activities 只接受 snapshot destination、固定 theme 与 locale，丢弃 Viator MCP raw payload、click-off link 与无币种价格。Ground Place/Navigation 只解析 server-owned destination reference、run-bound candidate 或已授权 TripPlace；拒绝浏览器/模型坐标、地址、provider、profile、URL 与跨 run candidate。Personal Activities 在 owner-scoped streaming tool-loop 完成前保持禁用；Personal Agent 不得调用 Ground navigation/mobility tool。
2. Result compares two to three configured destination candidates and supports any two authorized POIs under a candidate. Each item includes source/captured time and route distance/duration/steps or commercial price/currency as applicable; absent service explicitly appears in a non-confirmable `RESEARCH_UNAVAILABLE` summary.
3. Each item shows source, captured time, offer expiry when applicable, price/currency when available, and linked authorized constraints.
4. Comparison explains destination and service trade-offs without referencing a private or unapproved Profile field.
5. Tool failure yields a recoverable `UNAVAILABLE` missing-service state; it never fabricates or substitutes inventory, route, schedule or price. Provider gaps complete the task as `COMPLETED_WITH_GAPS` and persist only a safe research summary. Only a user-selected live commercial offer blocks its corresponding confirmation/booking action; route evidence never creates commercial authority.
6. Planning may publish only safe progress events (`SNAPSHOT_CREATED`, `RESEARCHING`, `VALIDATING`, `PERSISTING`, `COMPLETED` or `FAILED`). It never streams chain-of-thought, raw tool payloads, unvalidated plan candidates, or private snapshot fields; the UI shows a plan only after authoritative validation and persistence.
7. Flight, Activities, Place/Navigation and Mobility are independently schedulable typed capabilities with distinct provider evidence, staleness trigger and audit action. The planning scheduler enforces bounded tool loops and independent concurrency/failure semantics; no provider booking link may enter the MVP.

### H4 — Produce per-traveler visa and entry readiness

**Story:** As an international traveler, I want my Agent to show the preparation items that apply to my nationality and route, so that I do not miss a travel requirement while planning with friends.

**Acceptance criteria:**

1. Implement the approved global `VisaProvider` contract and `ReadinessOrchestrator`; production provider default is disabled until Sherpa contract, DPA, credential and sandbox contract verification pass.
2. Candidate planning runs destination-level checks per authorized traveler × destination. Results explicitly state that transit readiness remains pending until a concrete flight offer is selected.
3. Selecting an unexpired current-plan flight offer accepts a durable route-readiness task; it derives airport/transit nodes server-side and creates per-traveler route-level checks.
4. Every owner-visible item contains source, check time, stage, next action and uncertainty. Team views expose only aggregate status; neither API/UI/telemetry leaks nationality or another member’s checklist.
5. Missing/uncertain/expired data directs the owner to official verification; it never claims visa approval or legal advice, stores rule-page text, or forwards application/purchase links.
6. Missing nationality consent, consent withdrawal, selected-offer change/expiry, route change and snapshot change invalidate affected checks and trigger the applicable replan/recheck.

### H5 — Self-correct the shared trip after change

**Story:** As a group, I want the Agent to re-plan and compare the changed destination options when price, inventory or a member’s availability/origin changes, so that the plan stays viable without losing our personal constraints.

**Acceptance criteria:**

1. Demo supports deterministic flight price/availability, member-date or member-origin constraint change.
2. Event produces new tool and consent snapshots and expires old plan/confirmations.
3. Re-plan compares old/new destination ranking and services, retained constraints, affected member preferences and visa/entry impact.
4. If no feasible alternative exists, it identifies blocking constraints and asks the appropriate member to adjust.
5. Same event ID is idempotent and cannot cause duplicate plans/actions.
6. Replan progress events are scoped to the active `tripId`, `runId`, snapshot and plan version. A stale run is terminal and cannot publish a plan or overwrite a newer run.
7. A change automatically produces a `PROPOSED` replan. The previous plan remains `STALE` and comparison-only; it cannot return to an actionable state.
8. All required members must vote `ACCEPT` before a proposed plan becomes `ACTIVE`; any `NEEDS_CHANGES` blocks adoption and creates no booking authority.

### H6 — Explicitly confirm and invoke booking orchestration sandbox

**Story:** As one of three travelers, I want to explicitly approve the current shared plan before my Agent prepares booking actions, so that no member is represented in a possible transaction without control.

**Acceptance criteria:**

1. Each of the three required members can select `Confirm` or `Needs changes` for only the current plan version.
2. Orchestration is blocked until all three required members confirm and snapshots remain current.
3. Confirmation page displays all services, total price/currency where available, sources, approvals and `No automatic charge`.
4. Sandbox call returns a reference per service or a clear error; success never states that payment was taken.
5. Duplicate/late callbacks are idempotent by orchestration request ID; stale/declined plans cannot invoke a call.
6. Adoption voting is separate from booking confirmation. The sandbox accepts only the latest `ACTIVE` plan after the existing unanimous confirmation gate.

## 3. PROOF

### P1 — Show memory, authorization and source evidence

**Story:** As a judge, I want to inspect why the Agent used each fact and preference, so that I can see it knows users without leaking private data or inventing facts.

**Acceptance criteria:**

1. Plan can show whether a constraint came from Profile, trip-specific input or an authorized shared field.
2. Private/unapproved values are redacted from the shared view and Agent explanation.
3. Each travel/visa fact shows source and time; unavailable facts show `UNAVAILABLE` and a recovery path.
4. Every Agent/tool run references Profile, consent and tool snapshot IDs.

### P2 — Run the repeatable Hero Demo

**Story:** As a demo operator, I want a stable two-user, two-nationality journey, so that I can show the full Agentic loop in three minutes.

**Acceptance criteria:**

1. Demo seed contains three distinct Profiles, two origins, two to three supported destination candidates, at least two nationalities, test-only tool doubles and one price/constraint-change event.
2. Flow runs `profile → invite → consent → candidate comparison → plan → visa → change → re-plan + diff → three confirmations → sandbox` without manual database edits.
3. If a live source fails, UI visibly shows `UNAVAILABLE`; no plan or substitute offer is created.
4. Demo reset removes trip session data while preserving only explicitly seeded test Profiles.

## 4. SUPPORT

### S3 — Show an anonymous, offline map location reference

**Story:** As a traveler, I want an understandable country/nearby-city hint after I explicitly click a map location, without sending my coordinates to a third-party service or turning a pin into travel data.

**Acceptance criteria:**

1. An unauthenticated explicit-click request returns only `REFERENCE`, `NO_REFERENCE`, `429` rate-limit, or controlled unavailable state from versioned local data; it is one of the two anonymous Explore APIs.
2. The result includes source, dataset version and checked time, and is labelled as a map reference rather than an address or candidate.
3. Coordinates, place names and raw response bodies are absent from logs, trace attributes, metrics labels, audit and database state.
4. Map movement, zoom, hover and prefetch never invoke the resolver; a failed or distant city match is not guessed.

### S4 — Show a cached introduction for a stable map location

**Story:** As a traveler, I want a short destination introduction in the map drawer without repeatedly waiting for the model, so that exploring a known place remains fast without turning it into a private conversation or travel fact.

**Acceptance criteria:**

1. Only a server-versioned, stable `sourceId` and `en`/`zh` locale can request an introduction. `apps/api/data/location-introduction/catalog.json` is the sole active catalog; arbitrary coordinates, names, map labels and `INSPIRATION` pins are rejected or skipped without an LLM call.
2. The first valid request generates one non-personalized introduction and persists a 7-day PostgreSQL cache entry. A valid subsequent request for the same place, locale and content version returns the entry without calling the model.
3. Concurrent misses have one generation lease. Non-owners receive `202 GENERATING` and poll; they never fan out duplicate model calls. Expired entries regenerate; model/policy/schema failures do not cache content.
4. The map drawer loads the introduction automatically without opening chat or creating a Trip, thread, message, Agent task, consent, snapshot or audit event containing user data.
5. The endpoint is anonymous and independently rate-limited. Logs, metrics labels, trace attributes and audit summaries never contain source ID, place name, coordinates, cache key, prompt or generated content.
6. Redis is not introduced. PostgreSQL remains the shared cache and lease authority; TanStack Query is browser-only caching.


### P3 — Observe one owner request across API → DB → Worker → SSE

**Story:** As a team operator, I want a single owner request to be traceable as one OTel trace across the API, the DB hot-spots, the durable Worker, and the SSE event stream, so that the Hero Demo and post-demo debugging show a complete end-to-end flow.

**Acceptance criteria:**

1. Inbound `traceparent` is parsed at HTTP ingress, attached as `trace_id`/`span_id` Pino bindings, and echoed as a response header.
2. `agent_task_runs.trace_context` JSONB column carries the same `traceparent` plus `correlationId` from the originating request so the Worker process can reconstruct the active OTel context.
3. The Worker's `agent_task_worker.run` span is a `CONSUMER` with a `SpanLink` referencing the originating HTTP server span; when `trace_context` is null, it is a fresh root tagged `tasks.recovery=true`.
4. SSE events published via PostgreSQL carry the originating `traceparent` in the payload; `AgentStreamRelay` propagates it and `routes/agent-runs.ts` opens `sse.event.<type>` spans with `SpanLink`s to the same trace.
5. `safeSetAttribute` rejects any forbidden key (PII, credentials, high-cardinality identifiers); `tests/spans-forbidden-attributes.test.ts` statically asserts no production call site uses a forbidden key.
6. Pino `LOGGER_REDACTION` continues to redact passport/nationality/DOB/`prompt`/message bodies after the trace bindings are merged.

### S1 — Enforce privacy, versioning and observability

**Story:** As a team operator, I want every privacy-sensitive Agent decision to be versioned and traceable, so that we can safely debug the demo and prove control boundaries.

**Acceptance criteria:**

1. Separate users cannot read or mutate one another’s Profile, consent or private conversation data.
2. Every private conversation has a user-owned `conversation_id`; each trip has a `trip_id`; requests, Agent runs and sensitive operations have separate correlation IDs and versions.
3. Logs/traces/audit summaries omit private chat text, passport/document numbers, payment data and unapproved profile fields; private messages never enter a shared snapshot. Only the server-built, bounded same-thread context window may be sent to the configured Personal Agent model provider, never to telemetry or another product boundary.
4. Low-cardinality metrics count profile reuse, consent completion, tool outcome, visa uncertainty, re-plan, confirmation, orchestration outcome and errors.
5. `POST` commands create durable tasks and return `202`; authenticated `fetch` SSE only observes safe live events. Browser state is ephemeral and disconnect never cancels execution. Event payloads and audit/telemetry omit prompts, raw provider responses, chain-of-thought and unapproved data; identifiers remain trace/log correlation only, never metric labels.

### S2 — Recover from incomplete, conflicting or unreliable data

**Story:** As a traveler, I want clear recovery when information is missing, conflicting or uncertain, so that the Agent never hides a risk behind a confident answer.

**Acceptance criteria:**

1. Missing Profile/consent produces a clear trip-specific input request.
2. Conflicting budget/date/flight constraints name affected members and offer editing entry points.
3. Tool failure is visible and never shown as live availability.
4. Visa uncertainty has an official-verification action and never permits automatic application/booking.
5. Error state cannot create confirmation, orchestration, charge or booking.
6. Only explicit user cancellation stops upstream generation. Browser disconnect leaves the durable task running; network/5xx failures may retry at most twice, while policy/schema/authorization/data failures do not retry. Every terminal path preserves the submitted private USER message exactly once and never persists partial ASSISTANT output that has not passed final safety policy.

## 5. PRODUCT-LATER

| Capability | Reason deferred |
|---|---|
| Real money movement, refunds, supplier settlement and automatic booking | Requires legal, payment and operating ownership beyond Hackathon proof. |
| Global providers, broad GDS inventory, price guarantee | Reduces reliability and focus. |
| Visa filing/approval or legal advice | High-stakes domain; readiness support is the safe boundary. |
| Native group chat, payment splitting, social features | Shared workspace already solves coordination without copy/paste friction. |
| Unbounded personality inference and social-memory graph | Violates user-control and privacy-first Agent value. |

## 6. 交付顺序

1. Durable task platform: `agent_task_runs`, idempotency, multi-Worker lease/recovery, explicit cancellation, outbox and safe telemetry.
2. H1 + H2: Personal Agent command acceptance, Worker execution, gated live text relay and owner-only recovery.
3. H3 + H4 + P1: planning task execution, immutable snapshot binding, safe progress events and validated result persistence.
4. H5: stale-aware replan tasks, consent-revocation suppression and verified final diff.
5. H6 + P2: retain synchronous controlled booking action; no booking side effect is streamed or queued by this platform.
6. S1 + S2: multi-Worker race, lease-expiry, disconnect, cancellation, retry, privacy and regression coverage as release gates.
