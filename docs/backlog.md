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
11. Nationality, travel documents, date of birth, health and accessibility data are form-only: no conversation or behavior extraction path may create a proposal for them. A quote-nationality form may save its explicit value to the private Profile only when the traveler selects that option; otherwise it remains trip-scoped. A stored Profile value is reused only after explicit confirmation for the current trip, while an existing active trip authorization suppresses a duplicate question.
12. A DRAFT creator's Destination Cue uses deterministic precedence, a dedicated current-USER-turn language model, and server-owned city resolution. A bare city, city exploration/weak interest, one-city hotel request, or one flight destination produces one concrete confirmation candidate; a neutral multi-city list/comparison, assistant/history/map-only mention, pronoun, country/region, unknown or ambiguous label does not. Explicit set-destination commands bypass the 30-minute Trip-wide cooldown and same-local-day mute after three dismissals. The model classifies language and city roles but never mutates Trip state. Explicit exclusion language creates a separately confirmed Trip exclusion rather than a cue dismissal; conditions, quotations, double negatives and unclear negation scope fail closed. Trigger context is retained for later flight/hotel combination-card orchestration without granting provider or mutation authority.

### H1a — Start and resume an exploration-scoped private Trip

**Story:** As a traveler, I want my first message in a new exploration to start a private Trip, while map browsing creates nothing, so that unrelated ideas do not overwrite prior projects or create empty archives.

**Acceptance criteria:**

1. New tabs, full reloads and reopened Explore pages begin an in-memory exploration session; client-side navigation away and back preserves it.
2. Map browsing, coordinate clicks and opening/closing chat create no Trip, thread or audit event.
3. The first submitted message atomically and idempotently creates one `DRAFT` Trip, creator membership and owner-only default thread, then enters the existing durable conversation flow.
4. The visible “Start new exploration” action resets only the in-memory session; it never deletes or silently changes an existing Trip.
5. Draft Trip collaboration commands, except invitation creation and acceptance, are rejected server-side until the creator explicitly activates a complete brief as `PLANNING`; private chats remain isolated after a Draft invitation is accepted.
6. My program is only a sunlit pixel room, gramophone and real Trip records. The last
   successfully opened, still-authorized Trip in the current account/tab spins on the
   platter; others (including archives) sit below. Records open their workspace. No
   filters or deletion panels appear here; the sidebar remains. A top-right New trip
   button creates a Draft idempotently and opens its workspace; Explore also supports
   creation. Signed-out sessions hide cached Trips and cannot create; failures are not empty collections.
   Other Trips use square paper jackets with visible thickness; hover/focus lifts the
   jacket and partially extracts its vinyl. A read-only wall calendar shows the local
   current month and today. Reduced-motion disables spinning and jacket transitions.

### H2 — Join a shared trip and grant scoped consent

**Story:** As a traveler, I want to join a friend’s trip and choose exactly what my Agent may share for it, so that I get personalized coordination without exposing my private history.

**Acceptance criteria:**

1. Organizer can create one shared trip and invite two additional test travelers. A `DRAFT` trip is also invitable: the organizer may create an email-bound invitation before activating the brief, the invitee sees only a minimal decision surface (trip name, `DRAFT` status, expiry, “joining grants only a blank private thread”), and accepting does not reveal the creator's private conversation or unconfirmed exploration. Draft collaboration commands (`consent`, `snapshot`, `planning`, `confirmation`, `booking`) remain rejected until activation. Cancelled or archived trips reject both new invitations and acceptance attempts.
2. An organizer can enter an email and copy an email-bound invitation link without account search or enumeration. A traveler can sign in or register with that email, open the token-bound invitation page, see only the authenticated decision summary, then explicitly accept or decline; accepting leads only to sharing-scope setup and does not grant consent.
3. Each traveler can separately approve or decline sharing each relevant profile field and their nationality/entry data.
4. Shared trip shows only approved fields with member and consent source; private chat/history is never displayed.
5. Revoking a shared field immediately expires affected plan and visa outputs.
6. A member without a Profile can join and enter only trip-specific data.
7. Shared Agent receives current-Trip memory only through the consent-derived snapshot projection; it cannot query a member Profile, preference fact, private thread or a prior Trip's memory directly. A projected memory change invalidates the active plan and confirmations.

### H3 — Orchestrate a personalized multi-service Trip

**Story:** As a solo traveler or a group, I want the Trip Orchestrator to use my/our authorized preferences to compare destinations and coordinate flights, stay, local transport, activities and readiness, so that I/we can make one transparent choice instead of coordinating separate tools.

**Acceptance criteria:**

1. 成员确认的对话候选或既有 research command 创建一个 versioned snapshot 和 durable task；任何 active member 仅能确认自己 private thread 的候选，Trip creator 不具特殊确认权限。Worker invokes all enabled Shared tools (`flight.search`、`accommodation.discover`、`hotel.search`、`activities.search`、`places.search`、`places.adopt`、`navigation.route`、`mobility.search`、readiness) with server-derived parameters and run binding. Accommodation discovery returns only non-price planning candidates; hotel quote requires confirmed dates, occupancy and currency. Nuitee quote additionally requires provider-only user-confirmed quote nationality; SerpApi retains its single-room capability limit. The server binds exactly one configured hotel provider to each task, never automatically falls back or mixes provider evidence. Both tools accept only `destinationId`; the server resolves a complete `DestinationReference` with canonical city, ISO country code and coordinates, and fails closed on missing/ambiguous references. Personal chat has no direct tool/provider authority.
2. Team Trips compare two to three configured candidates; Solo Trips permit one to five. Results support any two authorized POIs under a candidate. Each item includes source/captured time and route distance/duration/steps or commercial price/currency as applicable; absent service explicitly appears in a non-confirmable `RESEARCH_UNAVAILABLE` summary.
3. Each item shows source, captured time, offer expiry when applicable, price/currency when available, and linked authorized constraints.
4. Comparison explains destination and service trade-offs without referencing a private or unapproved Profile field.
5. Tool failure yields a recoverable `UNAVAILABLE` missing-service state; it never fabricates or substitutes inventory, route, schedule or price. Provider gaps complete the task as `COMPLETED_WITH_GAPS` and persist only a safe research summary. Only a user-selected live commercial offer blocks its corresponding confirmation/booking action; route evidence never creates commercial authority.
6. Planning may publish only safe progress events (`SNAPSHOT_CREATED`, `RESEARCHING`, `VALIDATING`, `PERSISTING`, `COMPLETED` or `FAILED`). It never streams chain-of-thought, raw tool payloads, unvalidated plan candidates, or private snapshot fields; the UI shows a plan only after authoritative validation and persistence.
7. Flight, Activities, Place/Navigation and Mobility are independently schedulable typed capabilities with distinct provider evidence, staleness trigger and audit action. The planning scheduler enforces bounded tool loops and independent concurrency/failure semantics; no provider booking link may enter the MVP.
8. Accommodation discovery and hotel quote are independently schedulable, but OpenTripMap discovery is research-only coverage and never becomes a selectable `itinerary_plan` field or a second shared-plan accommodation row. `hotels[]` is the sole final-plan accommodation slot. Nuitee (default) or explicitly selected SerpApi quote shows total and per-night price plus `source`/`captured_at`/`expires_at`; partial or unknown taxes/mandatory fees display “可能另计”. Neither creates a provider order, payment, redirect or booking link; unavailable supplier data only produces `RESEARCH_UNAVAILABLE`.
9. A Personal Agent may generate a persisted, non-executable `RESEARCH_ONLY` or `PROPOSE_PLAN` draft from a high-confidence Chinese or English research request in an active Solo Trip, but the owner must confirm it. The draft contains only controlled capability enums and readiness gaps, is restored after SSE disconnect/refresh, and cannot contain raw chat text, provider parameters, place IDs, dates, identity or snapshot fields. `PROPOSE_PLAN` automatically creates a first `PROPOSED` plan; one owner `ACCEPT` activates it. `RESEARCH_ONLY` never creates plan or booking authority. Raw route text must first complete owner-controlled route endpoint selection/adoption; it must not invoke navigation using arbitrary existing TripPlaces. See `docs/personal-research-intent-routing-implementation.md`.

### H3a — Hand off member-confirmed conversation candidates to Shared Agent

**Story:** As any active Trip member, I want my own Personal Agent conversation to turn my confirmed non-sensitive preferences into Shared planning inputs, so that I do not complete a separate structured form or manually request replanning.

**Acceptance criteria:**

1. A candidate batch belongs to one active member, one member-owned `chat_thread`, one Trip and one conversation run. The Trip creator has no elevated ability to confirm another member's batch.
2. Personal Agent extraction only emits strict catalog fields. It cannot create candidates for nationality, documents, health or accessibility, and it never persists raw conversation text, prompt or model rationale.
3. The private candidate card permits a member to select candidates and visibility/strength, then issue one idempotent “confirm and generate latest shared plan” command. The command never accepts user IDs, values, snapshot IDs or provider parameters from the browser.
4. The server atomically revalidates active membership, candidate ownership, thread ownership, catalog and required consent; it writes facts and a snapshot, then accepts exactly one `PLAN` or `REPLAN` task. Duplicate/concurrent requests cannot create extra facts, snapshots or tasks.
5. Existing plans, confirmations and adoption votes become `STALE` when a confirmed handoff changes inputs. The UI does not expose a manual replan action, but the server continues automatic replan.
6. Shared Agent receives only the fresh snapshot and current-run evidence. It cannot read candidate batches, private conversation or Personal Research evidence. Plan adoption and booking confirmation remain separate gates.
7. See [成员对话候选到 Shared Agent 交接实施规范](member-conversation-handoff-implementation.md) for API, migration, rollout and test requirements.
8. Handoff extraction is available only after Trip activation (`PLANNING`/`STALE`), never from `DRAFT`; a former member cannot read or confirm an old candidate batch, and deleting the source private thread dismisses its pending candidates before transcript deletion.

### H3a.1 — Confirm a private flight or hotel offer without booking it

**Story:** As a DRAFT Trip creator, after I have seen my own live flight or hotel results, I want the system to ask for confirmation only when my current message actually selects one result, so I can save a candidate to my Trip without mistaking that for a purchase or silently changing a Shared Plan.

**Acceptance criteria:**

1. Flight and Hotel each use an independent structured-output decision model. Natural-language trigger decisions are never made by keyword or regex hard-code; deterministic code only checks identity, result-set eligibility, candidate ownership, freshness, version, idempotency and prompt policy.
2. A classifier receives only the current owner message plus a bounded, server-issued projection of that owner's already-visible, unexpired offer set. It receives no Assistant/history text, raw provider payload, provider ID/link, Profile, other thread or other member data.
3. Personal Research results persist owner-only offer candidates with opaque browser references. `provider_offers` and `provider_search_runs` remain snapshot-bound and Personal selections never become Shared evidence or booking authority.
4. A unique explicit/strong selection creates `Take this flight?` or `Stay in this hotel?`; detail questions, comparisons, neutral positive remarks, rejection, re-search requests and ambiguous references do not. Same-leg/same-stay multi-selection requests clarification rather than creating competing cards.
5. Accept stores an owner-only, versioned selection and returns a clear non-booking success message. It does not set a destination, activate/rewrite a plan, create an order, payment or provider redirect. Shared Planning later re-searches and revalidates evidence.
6. Dismiss applies a per-capability 30-minute cooldown and a three-dismissal-per-local-day mute. Model-classified explicit selection may bypass suppression but remains subject to resolver/freshness checks. Destination, Flight and Hotel cards may share a container but each action is independent.
7. This first release is DRAFT creator/thread only. Cross-thread/member access, expired/superseded candidates, stale versions, duplicate actions and model failure fail closed; model failure does not delay or fail normal chat.

### H3b — See the Shared Agent's result as a trip-wide read-only surface

**Story:** As any active Trip member, I want the Shared Trip Agent's output to appear in a pinned, trip-wide place I can open at any time, so that I can see what was planned, why it changed, and what I still have to vote on — without asking the member who triggered it.

**Acceptance criteria:**

1. The Trip workspace thread rail shows a pinned "shared plan" entry above the caller's private threads. It is always present, even before any plan exists, and is visible to every active member of the Trip.
2. The surface is read-only. It has no message input, creates no shared `chat_thread` or `chat_messages`, and gives the Shared Agent no user-facing chat entry point. Private threads remain owner-only.
3. It renders only: the safe lifecycle of the latest `PLAN`/`REPLAN` run, `PROPOSED`/`ACTIVE`/`STALE` plans with their version chain and stale reason, per-item source and captured time, `TEAM_VISIBLE` constraints, and adoption vote state. It never renders owner-only constraints, pending brief proposals, research intent drafts, personal research evidence, model rationale or any conversation text.
4. It does not disclose which member triggered a planning run, and it never shows `ORCHESTRATOR_CONFIDENTIAL` values or member attribution.
5. Every price appears with its currency, source and captured time; an expired offer is marked expired; a missing provider capability is shown as an explicit `UNAVAILABLE` gap and is never substituted.
6. Only the member who triggered a run is switched to the surface automatically, and only once that run reaches a terminal state. Other members get an unread marker; their current private conversation is never pre-empted.
7. Adoption vote controls are visibly distinct from booking confirmation, state that an old plan cannot be restored, and are absent on `STALE` plans. There is no manual replan action.
8. Authorization is entirely server-side and unchanged: a removed member fails closed on every read. The browser stores no plan content, constraint value, snapshot, vote authority or run authority — only an unread marker.
9. See [共享方案面实施规范](shared-plan-surface-implementation.md) for module disposition, interface contracts, phases and test requirements. It implements items 2–5 of `team-agent-orchestration-implementation.md` §7.
10. Each plan renders one hotel section and an optional model-arranged `dailyItinerary`. The daily schedule call reaches the same configured model gateway through its bound instance and uses a provider-compatible wire schema over server-issued day/evidence aliases plus a price-free compact selection context; a separate canonical Zod schema and deterministic validator retain all length, format, date, time and evidence constraints. Real dates, timezone/verification labels and provider ids are rebound only by the server; unknown or cross-category aliases fail closed. The model may add clearly labelled suggested sights outside provider Activities. Schema/date/time/evidence failures receive at most two content-free, tool-free repairs; provider/local failures do not. The evidence-bound plan is always preserved and stores a mutually exclusive `dailyItineraryOutcome` with attempts, checked time, retryability and a closed failure reason so UI text cannot claim retries that did not occur. Legacy plan fields remain read-compatible only.

### S6 — Approved: DRAFT Personal Research handoff（未实施）

**Story:** As a Trip owner, I want to explicitly run a real, private research query before my trip brief is complete, so that I can explore options without creating a shared plan prematurely.

**Acceptance criteria:**

1. The existing DRAFT Trip and its owner-only `chat_threads` thread are the only Trip/Session objects; no unbound query and no duplicate personal-session table are introduced.
2. An owner-confirmed `PERSONAL_RESEARCH` task uses the same typed capability/provider adapter as Shared research but receives a server-built `{ tripId, threadId, ownerUserId, runId }` authority and has no snapshot/plan/booking authority.
3. The first vertical slice is Flight. It persists only a normalized, owner-only result with source and capture/expiry time; unavailable providers fail closed. Other tools are enabled only after their own contracts and tests are complete.
4. Personal results never enter a Shared snapshot, plan validator or another member's view. “Start planning” uses the existing explicit activation and consent flow, which re-queries Shared facts under a new snapshot.
5. See `docs/draft-personal-research-implementation.md` for data model, endpoints, risks, and implementation order. This story intentionally supersedes the future direction of active-Solo-only Personal research, but does not alter current runtime until implemented.

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


### S5 — Conversational completion for Personal Research (§9)

**Story:** As a Solo Trip owner, I want the Personal Agent to ask me short follow-up questions in chat and let me answer inline (with an editable preview card) when my hotel / flight / trip request is missing fields, so that I can finish the research request in one place without bouncing to a settings page or guessing fields the model invents.

**Acceptance criteria:**

1. When the classifier extracts a `RESEARCH_ONLY` / `PROPOSE_PLAN` intent whose readiness is `NEEDS_SETUP` with in-scope codes (`DATES_MISSING`, `STAY_PREFERENCES_MISSING`, `FLIGHT_PREFERENCES_MISSING`), the conversation worker eagerly opens a `personal_research_setup_sessions` row bound to the intent run + trip + owner, with `expires_at ≈ now + 15min`, supersedes older OPEN siblings via the partial unique index.
2. A bounded LLM call (`generateSetupFollowup`) picks one missing code and emits a localized prompt. Output is Zod-validated against `researchMissingCodeSchema`, PII / live-fact regex-gated, and falls back to a deterministic `MISSING_COPY`-style template on any failure (model error, schema rejection, invalid code, length > 280). The fallback reason is captured in `personal_research_setup_followup_total{outcome="fallback",reason=...}`. The LLM input never carries the original question.
3. A `research.setup.followup` SSE event surfaces the question as an inline chat bubble; the same intent run's `agentRunResponseSchema.researchSetupSession` projection hydrates the card on refresh so a tab reload can recover without losing filled slots.
4. Per-field answers go through `POST /agent-runs/:runId/research-setup/answers` under optimistic-version concurrency; the server recomputes `missing[]` from server-owned Trip / preference state and rejects invalid dates / room-count / adults / currency with `422`. The first success of a session increments `PERSONAL_RESEARCH_SETUP_OPENED`; each accepted answer increments `PERSONAL_RESEARCH_SETUP_UPDATED` (summary: `{ sessionVersion, fieldsFilled }`).
5. `POST /agent-runs/:runId/research-setup/confirm-and-search` runs one atomic transaction: re-validate trip status (`PLANNING`/`STALE`), `requireResearchEligible`, hotel provider gate (`PLAN_ENABLE_HOTEL` + Nuitee `loadActiveQuoteNationality`), regex-validated dates, `UPDATE shared_trips.travel_date_start/end` and `departure_cities` (when changed), `INSERT trip_stay_search_preferences` and `trip_search_preferences` (when the corresponding slot is set), `stalePlansAndConfirmationsForTrip` **before** `acceptResearchTask`, `transitionResearchIntentState PROPOSED → CONFIRMED`, `acceptResearchTask({ originatingIntentRunId, requestId, ... })`, then publish `research.stage SNAPSHOT_CREATED`. Idempotent on `requestId` via `findResearchTaskByRequestId`. Failed confirm leaves no preference row, no task, no intent transition, and only a failure audit row.
6. Cancel and expiry are terminal: `POST /cancel` sets `status='CANCELLED'`; `expires_at` past returns `410 Gone` from both `applyAnswer` and `confirmAndSearch` after an opportunistic `OPEN → EXPIRED` transition. Neither writes preferences nor creates tasks.
7. The setup row, audit summary, and SSE payloads carry only structured slot values / field names. Raw chat text, the original question, place names, profile, snapshot content, and PII (passport / ID / phone / address / price tokens) are NEVER persisted, logged, traced, or metric-labeled.
8. The first iteration covers hotel + flight + trip-level slots in an activated Solo Trip only. Budget preferences, activity preferences, multi-room types, and shared-trip conversational completion are explicit deferred scope.
9. Missing codes outside the in-scope set (`HOTEL_PROVIDER_NOT_APPROVED`, `QUOTE_NATIONALITY_AUTHORIZATION_MISSING`, `TRIP_NOT_ACTIVE`, `DESTINATION_NOT_CONFIGURED`, `FLIGHT_PREFERENCES_MISSING` once flight widgets land) keep rendering the existing read-only `research-setup-card`; the conversational API is not invoked for them.

### S7 — Name a private thread by what it is about

**Story:** As a traveler with several private threads in one trip, I want each thread to carry a title that tells me what it is about, and to rename it myself, so that I can return to the right conversation without opening each one.

**Acceptance criteria:**

1. Server-created thread titles use the language carried by the request. `POST /explorations/start` and invitation acceptance no longer write a fixed English placeholder; `chat_threads` records `title_source` and `title_locale` alongside the title.
2. `POST /trips/:tripId/threads` accepts an optional `title`. When omitted the server takes an advisory lock on the (owner, trip) pair and numbers the thread inside the same transaction, so two browser tabs creating a thread concurrently never produce the same name. The browser no longer computes thread titles.
3. The owner can rename any of their own threads through `PATCH /trips/:tripId/threads/:threadId/title`. A fellow trip member gets `403` without learning whether the thread exists. Renaming sets `title_source = 'MANUAL'`, after which automatic naming never overwrites it unless the owner explicitly confirms an overwrite.
4. The owner can explicitly ask the Personal Agent to name a thread from that thread's own earliest USER messages. Profile, Personal Note, long-term memory, other threads and assistant output are never sent. The call is rate limited per user.
5. Every failure path leaves the stored title untouched and returns a readable reason: `MANUAL_LOCKED`, `NO_MATERIAL` (no user message yet, model not called), `REJECTED` (post-processing refused a URL, e-mail, long digit run, or verbatim echo of the conversation), `UNAVAILABLE` (gateway timeout or failure).
6. Thread titles are owner-only data: absent from shared snapshots, the shared plan surface, member lists, invitation previews, logs, traces, audit summaries and metric labels. `CHAT_THREAD_TITLE_UPDATE` audit rows carry only `{ threadId, source }`.
7. Background automatic naming is explicitly out of scope for this story; the promotion criteria are recorded in the implementation spec.

实施合同见 [Thread 标题生命周期实施规范](thread-title-lifecycle-implementation.md)。

### S8 — Name a trip when the traveller has only named a country

**Story:** As a traveler who has only said which country I want to visit, I want my trip to carry a title that tells me what it is about, so that I can find it in my project list before I have picked a city.

**Acceptance criteria:**

1. A country-level intent writes a display-only destination label and the trip title becomes e.g. `法国行程规划`. `destinationCandidates` stays empty and the label never reaches the planner, a provider query or a `constraint_snapshot`.
2. Because the brief still lacks a city, the trip card and workspace show a destination-pending marker, and the assistant asks for a specific city on the chat-text path — not only when a place is picked on the map.
3. Same-name cities across countries resolve by population dominance (`巴黎` / `Paris` → Paris, France). Where no country dominates (`Valencia`, `Barcelona`) the request keeps returning `422 DESTINATION_UNRESOLVED` rather than guessing.
4. Confirming a real city supersedes the label: the title recomputes from the city and the label is cleared.
5. The owner can explicitly ask the Personal Agent to infer the label. The model may only return a country or city name that re-resolves through the server location-reference dataset; anything else is refused.
6. Every failure path leaves the stored title untouched and returns a readable reason: `NOT_DRAFT`, `MANUAL_LOCKED`, `SUPERSEDED`, `NO_MATERIAL`, `RATE_LIMITED`, `UNAVAILABLE`, `REJECTED`. A manual rename always wins a concurrent model call.
7. Trip names are member-visible, so a Draft trip with a system-generated name shows a generic localized name in the invitation preview — consistent with how that response already redacts destinations and dates.
8. `TRIP_TITLE_LABEL_UPDATE` audit rows carry only `{ source }`; the label text never appears in logs, traces, audit summaries or metric labels.
9. Background automatic model naming is explicitly out of scope; the promotion criteria are recorded in the implementation spec.

实施合同见 [Trip 标题目的地标签实施规范](trip-title-destination-label-implementation.md)。

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
7. One unavailable provider degrades that capability, not the run. A capability that was attempted and returned `UNAVAILABLE` becomes a recorded `service_gap` and the task terminates as `COMPLETED_WITH_GAPS`; only a capability that was never searched is a hard, non-retryable failure. A destination with zero live commercial evidence yields a research summary carrying no booking authority instead of a plan, and that summary can never be adopted, confirmed or sent to the booking sandbox.
8. A slow provider never gets reported as a model failure. Provider time and model time are separate budgets within one turn; when evidence was retrieved but the model reply failed, the user is shown what was actually retrieved rather than a connection error.
9. Deterministic validation failures may be returned to the model as a structured critique within a bounded repair budget. The final normal turn is reserved for tool-free synthesis, and tools stay closed throughout repair, so neither synthesis nor repair capacity can be consumed by additional research calls. Repair never relaxes a hard constraint, changes a gate outcome or introduces a fact the validators rejected.
10. `places.search` candidates are indexed from the Skill's public `candidates[]` output and remain scoped to the current run. Repeated place-contract rejection withdraws the dependent places/navigation family without preventing a plan based on independently verified flight, hotel and activity evidence; identical persisted service gaps are deduplicated by capability, code and destination.

**实施契约：** [规划器韧性与有界反思实施规范](planner-resilience-and-reflection-implementation.md)。

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
7. S2 §7–§9（规划器韧性与有界反思，见对应实施规范 §10）：
   **P0** 门禁语义拆分（研究完整性 / 商业依据）+ research-summary 分支 + review scope 收窄 + web 文案；
   **P1** 统一韧性策略、Skill retry 契约、7 个 adapter 接入、任务续期；
   **P2** 对话回合的 provider / model 预算拆分；
   **P3** 确定性 critic 与有界 repair、整轮墙钟。
   P0 必须最先合并——在「一格 `UNAVAILABLE` 即整轮失败」的门禁下，P1 的重试与 P3 的 repair 都无法体现效果。
