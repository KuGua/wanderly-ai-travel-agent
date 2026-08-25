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
7. Traveler can create, list, reopen and delete only their own private conversation threads; a thread may optionally reference one trip but is never shared by that association. `conversationId` is owned by exactly one `ownerUserId`, persists across sessions, and is not visible to fellow trip members or to the Shared Agent by virtue of the trip binding. Default LLM context for any run is the server-derived redacted summary plus the owner-marked shared turns — raw transcript never leaves the owner session.
8. Deleting a thread removes its message body and does not silently change separately confirmed Profile or trip-override facts; audit retains only `conversationId`, `ownerUserId`, `tripId?`, action, timestamp, and never the message body.
7. Traveler can create, list, reopen and delete only their own private conversation threads; a thread may optionally reference one trip but is never shared by that association.
8. Deleting a thread removes its message body and does not silently change separately confirmed Profile or trip-override facts.

### H2 — Join a shared trip and grant scoped consent

**Story:** As a traveler, I want to join a friend’s trip and choose exactly what my Agent may share for it, so that I get personalized coordination without exposing my private history.

**Acceptance criteria:**

1. Organizer can create one shared trip and invite two additional test travelers.
2. Each traveler can separately approve or decline sharing each relevant profile field and their nationality/entry data.
3. Shared trip shows only approved fields with member and consent source; private chat/history is never displayed.
4. Revoking a shared field immediately expires affected plan and visa outputs.
5. A member without a Profile can join and enter only trip-specific data.

### H3 — Orchestrate a personalized multi-service trip

**Story:** As a group departing from two places, I want the Shared Trip Agent to compare two to three destination options with flights, stay and local transport using our authorized preferences, so that we can make one transparent choice instead of coordinating separate tools ourselves.

**Acceptance criteria:**

1. Shared Agent sends one versioned shared-constraint snapshot to Flight, Stay and Ground tools/fixtures and maps the three travelers to two origins.
2. Result compares two to three configured destination candidates; each candidate includes at least one flight, hotel and ground option, or explicitly names a missing service and cause.
3. Each item shows source, captured time or `Demo data`, price/currency when available, and linked authorized constraints.
4. Comparison explains destination and service trade-offs without referencing a private or unapproved Profile field.
5. Tool failure yields a recoverable missing-service state and visibly uses labelled fixture fallback when configured; it never fabricates inventory or price.

### H4 — Produce per-traveler visa and entry readiness

**Story:** As an international traveler, I want my Agent to show the preparation items that apply to my nationality and route, so that I do not miss a travel requirement while planning with friends.

**Acceptance criteria:**

1. For each traveler who authorizes nationality data, the system creates a separate checklist or explicit verification gap for each displayed destination and known route/transit.
2. Every item names the traveler, source, check time, next action and confidence/uncertainty.
3. Missing or uncertain data directs traveler to official verification; it never claims visa approval or legal advice.
4. A traveler who does not authorize nationality data receives no inferred nationality conclusion.
5. Consent withdrawal invalidates that traveler’s checklist and triggers plan review.

### H5 — Self-correct the shared trip after change

**Story:** As a group, I want the Agent to re-plan and compare the changed destination options when price, inventory or a member’s availability/origin changes, so that the plan stays viable without losing our personal constraints.

**Acceptance criteria:**

1. Demo supports deterministic flight price/availability, member-date or member-origin constraint change.
2. Event produces new tool and consent snapshots and expires old plan/confirmations.
3. Re-plan compares old/new destination ranking and services, retained constraints, affected member preferences and visa/entry impact.
4. If no feasible alternative exists, it identifies blocking constraints and asks the appropriate member to adjust.
5. Same event ID is idempotent and cannot cause duplicate plans/actions.

### H6 — Explicitly confirm and invoke booking orchestration sandbox

**Story:** As one of three travelers, I want to explicitly approve the current shared plan before my Agent prepares booking actions, so that no member is represented in a possible transaction without control.

**Acceptance criteria:**

1. Each of the three required members can select `Confirm` or `Needs changes` for only the current plan version.
2. Orchestration is blocked until all three required members confirm and snapshots remain current.
3. Confirmation page displays all services, total price/currency where available, sources, approvals and `No automatic charge`.
4. Sandbox call returns a reference per service or a clear error; success never states that payment was taken.
5. Duplicate/late callbacks are idempotent by orchestration request ID; stale/declined plans cannot invoke a call.

## 3. PROOF

### P1 — Show memory, authorization and source evidence

**Story:** As a judge, I want to inspect why the Agent used each fact and preference, so that I can see it knows users without leaking private data or inventing facts.

**Acceptance criteria:**

1. Plan can show whether a constraint came from Profile, trip-specific input or an authorized shared field.
2. Private/unapproved values are redacted from the shared view and Agent explanation.
3. Each travel/visa fact shows source and time, or a clear `Demo data` label.
4. Every Agent/tool run references Profile, consent and tool snapshot IDs.

### P2 — Run the repeatable Hero Demo

**Story:** As a demo operator, I want a stable two-user, two-nationality journey, so that I can show the full Agentic loop in three minutes.

**Acceptance criteria:**

1. Demo seed contains three distinct Profiles, two origins, two to three supported destination candidates, at least two nationalities, tool fixtures and one price/constraint-change event.
2. Flow runs `profile → invite → consent → candidate comparison → plan → visa → change → re-plan + diff → three confirmations → sandbox` without manual database edits.
3. If a live source fails, UI visibly falls back to labelled fixture data.
4. Demo reset removes trip session data while preserving only explicitly seeded test Profiles.

## 4. SUPPORT

### S3 — Show an anonymous, offline map location reference

**Story:** As a traveler, I want an understandable country/nearby-city hint after I explicitly click a map location, without sending my coordinates to a third-party service or turning a pin into travel data.

**Acceptance criteria:**

1. An unauthenticated explicit-click request returns only `REFERENCE`, `NO_REFERENCE`, `429` rate-limit, or controlled unavailable state from versioned local data; it remains the only anonymous API endpoint.
2. The result includes source, dataset version and checked time, and is labelled as a map reference rather than an address or candidate.
3. Coordinates, place names and raw response bodies are absent from logs, trace attributes, metrics labels, audit and database state.
4. Map movement, zoom, hover and prefetch never invoke the resolver; a failed or distant city match is not guessed.

### S1 — Enforce privacy, versioning and observability

**Story:** As a team operator, I want every privacy-sensitive Agent decision to be versioned and traceable, so that we can safely debug the demo and prove control boundaries.

**Acceptance criteria:**

1. Separate users cannot read or mutate one another’s Profile, consent or private conversation data.
2. Every private conversation has a user-owned `conversation_id`; each trip has a `trip_id`; requests, Agent runs and sensitive operations have separate correlation IDs and versions.
3. Logs/traces/audit summaries omit private chat text, passport/document numbers, payment data and unapproved profile fields; private messages never enter a shared snapshot or default model context.
4. Low-cardinality metrics count profile reuse, consent completion, tool outcome, visa uncertainty, re-plan, confirmation, orchestration outcome and errors.

### S2 — Recover from incomplete, conflicting or unreliable data

**Story:** As a traveler, I want clear recovery when information is missing, conflicting or uncertain, so that the Agent never hides a risk behind a confident answer.

**Acceptance criteria:**

1. Missing Profile/consent produces a clear trip-specific input request.
2. Conflicting budget/date/flight constraints name affected members and offer editing entry points.
3. Tool failure is visible and never shown as live availability.
4. Visa uncertainty has an official-verification action and never permits automatic application/booking.
5. Error state cannot create confirmation, orchestration, charge or booking.

## 5. PRODUCT-LATER

| Capability | Reason deferred |
|---|---|
| Real money movement, refunds, supplier settlement and automatic booking | Requires legal, payment and operating ownership beyond Hackathon proof. |
| Global providers, broad GDS inventory, price guarantee | Reduces reliability and focus. |
| Visa filing/approval or legal advice | High-stakes domain; readiness support is the safe boundary. |
| Native group chat, payment splitting, social features | Shared workspace already solves coordination without copy/paste friction. |
| Unbounded personality inference and social-memory graph | Violates user-control and privacy-first Agent value. |

## 6. 交付顺序

1. H1 + H2: prove the Personal Agent and consent model.
2. H3 + H4 + P1: prove multi-tool, personalized shared planning.
3. H5: demonstrate self-correction.
4. H6 + P2: make planning turn into controlled action.
5. S1 + S2: make the proof safe and repeatable.
