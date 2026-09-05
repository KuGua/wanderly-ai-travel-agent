# AI Travel Agent — Personal Agents + Shared Trips 测试场景

**对应：** [Backlog](backlog.md) · [PRD](PRD.md)  
**范围：** 三个虚构用户的多人场景，以及一位 owner、一个出发地和一个至五个候选目的地的 Solo 场景；带来源的航班/酒店/地面交通工具、booking sandbox；不使用真实护照、支付资料或真实签证申请。产品运行时 live API 失败必须返回 `UNAVAILABLE`，不得使用 fixture fallback。

## Fixture

- Alice Profile：艺术兴趣、喜欢市中心、拒绝红眼航班；
- Bob Profile：预算上限、较重舒适度；Bob 可选择是否共享国籍资料；
- Chen Profile：第二出发地、有限出发时间与本次偏好；Chen 可选择是否共享国籍资料；
- 两个出发地、两到三个固定目的地候选、至少两国籍 readiness 规则与官方来源/检查时间；
- 测试专用 Flight、Stay、Ground 成功、缺失和失败 doubles；
- 航班涨价/售罄、成员日期/出发地变化、visa 来源不确定 fixture；
- sandbox orchestration 成功、失败、重复及乱序回调。

## Web layout regression

### TS-W0 — Trip-card destructive action stays discoverable without crowding content

**Objective:** Verify a creator's destructive action does not compete with the
trip artwork or metadata until the card is being interacted with.

**Expected outcomes:**

- The delete icon is positioned at the trip card's top-right and uses the
  destructive red treatment.
- At desktop widths it appears on card hover or when keyboard focus enters the
  card; at narrow touch widths it remains available without hover.
- It retains its accessible name and opens the existing explicit confirmation
  step before any delete request is made.

### TS-W1 — Trip workspace keeps the preference card and composer readable

**Objective:** Verify the trip workspace does not apply decorative rotation to
the preference card, and keeps the private-chat composer visually elevated
without clipping it at the message viewport boundary.

**Steps:**

1. Open a trip-private thread whose preference card is available.
2. Inspect the preference card at desktop and narrow workspace widths.
3. Scroll the conversation to its last message and focus the composer.

**Expected outcomes:**

- The preference card is horizontally aligned; no CSS rotation is applied.
- Only the input control is bordered and elevated; no redundant outer composer
  card or helper copy is rendered. It has a visible bottom inset and no
  horizontal overflow or clipping.
- Preference-card actions render as underlined text links with a directional
  icon, retain a visible keyboard focus indicator, and place the submit action
  at the card's lower-right edge.
- The preference card uses its thin border and paper grain for hierarchy; it
  has neither a folded corner nor a full-card hard offset shadow.
- On desktop, the workspace inspector has no enclosing panel background or
  divider; its overview, member, and map cards float independently. The
  narrow-screen inspector remains a bounded drawer with its own backdrop.
- The workspace title and agent chip retain a bottom divider. On desktop, its
  continuation in the inspector stops at the right edge of Invite teammates;
  the compact inspector drawer retains its own full bottom boundary.
- The message list remains scrollable and leaves enough bottom space for its
  final content to stay reachable while the composer is visible.
- Before the first message, the introductory copy is a compact, left-aligned
  16–18px title-scale session slogan with a small decorative spark-and-rule motif,
  without an Agent label, avatar, message-card border, or message shadow.
- On wide workspaces, shift the complete docked chat group (messages, agent
  label, and composer) by the same 4px rightward offset so its centre is
  measured from the chat panel's left edge to the Trip overview card's left
  edge. Do not alter the relative alignment or size of individual conversation
  bubbles.

### TS-W2 — Explore chat renders approved LLM text as terminal output

**Objective:** Verify the globe chat presents safe SSE message deltas as a
terminal response without changing task state or exposing partial text as a
durable message.

**Steps:**

1. Send one exploration chat message and observe the active Agent run while
   `message.delta` events arrive.
2. Send a message whose reply is a single Chinese sentence with internal commas
   (`好的，我来帮你规划这次法国之旅。`), and one whose reply carries no sentence
   punctuation at all (`巴黎是个不错的选择`).
3. Send a message whose reply contains a number, a time and a URL
   (`1,000`, `10:30`, `https://example.com/x`).
4. Let a run complete, then reload the private thread history.
5. Repeat with reduced motion enabled.

**Expected outcomes:**

- Each visible assistant reply begins with the same `>` prompt treatment as
  the terminal composer. While the SSE run remains active, a phosphor block
  cursor appears after the most recently rendered output; it disappears once
  the reply is settled.
- Deltas appear incrementally in their received sequence. No full-response
  wait or duplicate assistant bubble is introduced.
- The gate approves and publishes **clauses**, not whole sentences: the
  comma-separated Chinese reply arrives as more than one `message.delta`, and a
  long multi-clause sentence arrives as several. A reply with no sentence
  punctuation still ships from the final flush, so it is the one case that
  legitimately arrives whole.
- Numbers, times and URLs are never split across deltas — `1,000` and `10:30`
  stay intact, because end-of-buffer is not a clause boundary.
- Text is drawn at a terminal cadence, but never ahead of the stream and never
  as a replay of a finished reply: a large backlog is drawn within about a
  second, and the settled reply is never delayed waiting for the animation.
- The prompt and cursor are decorative: assistive technology announces the
  reply text and existing status feedback, not the terminal affordances.
  Reduced motion disables the blink.
- Reloaded history contains only the server-approved, completed assistant
  message; in-progress partial text remains ephemeral.

## 模型网关配置与失败文案

### TS-MG0 — Gemini 429 不能被指标标签错误改写成 `INTERNAL`

**Objective:** Verify an upstream model quota response remains a bounded
`RATE_LIMITED` outcome through the conversation error path, rather than making
the durable task fail because observability rejected its own metric label.

**Steps:**

1. Configure a model-gateway test double that returns HTTP 429 before it emits
   a conversation delta.
2. Submit one private-thread conversation turn and let the Worker process it.
3. Inspect the durable run, the Prometheus registry and safe Worker logs.

**Expected outcomes:**

- `llm_request_errors_total` accepts exactly
  `provider=gemini`, `error_category=rate_limited`, `retryable=true`.
- The error path uses the configured rate-limit backoff and then its existing
  retry/fallback terminal behaviour; it never throws `MetricLabelError`.
- The task is not marked `FAILED` with `errorCode=INTERNAL` merely because an
  upstream 429 occurred.
- The metric registry still rejects an arbitrary `error_category`, proving the
  fix did not weaken its bounded-label guard.
- Logs/traces contain only the safe error classification and correlation
  context, never provider error bodies, conversation text or credentials.

### TS-MG0a — Unknown internal LLM error categories remain bounded

**Objective:** Verify a future internal classification cannot create a new
Prometheus series or break the conversation failure path.

**Steps:** Force `recordRetryableError` through an internal code without a
declared metric mapping.

**Expected outcomes:**

- The metric records `error_category=unknown`.
- No arbitrary value is passed to `MetricsRegistry`.
- The original model failure remains the user-visible/task-level cause.

### TS-MG0b — Agent-run telemetry failure cannot replace the model outcome

**Objective:** Verify that loss of the derived `agent_runs`/`AGENT_RUN`
observability transaction does not turn a successful reply or a classified
model failure into `INTERNAL`.

**Steps:** Force the transaction used by `recordAgentRun` to reject, then run
one successful model-gateway request and one request that returns a classified
upstream failure.

**Expected outcomes:**

- The successful request retains its response and the classified failure
  retains its original error code.
- The recorder returns its bounded failure outcome and emits a content-free
  `OBSERVABILITY_FAILURE` warning with correlation context only.
- No partial `agent_runs` or `AGENT_RUN` audit row is committed: the two writes
  share one transaction.
- Authorization, trip-state, confirmation, booking, and their business audit
  writes remain strict; this exception applies only to derived agent-run
  telemetry.

### TS-MG1 — 空的 `MODEL_GATEWAY_API_KEY` 在启动时被拒绝，而不是每一轮对话失败一次

**Objective:** Verify a blank or shadowed model-gateway credential is a boot
failure that names the variable, not a per-turn `INTERNAL` task failure that
reaches the traveller as a send error.

**Background:** `apps/api/.env` declared `MODEL_GATEWAY_API_KEY` twice — once
with the real key, once empty inside a local activation block appended at the
end of the file. dotenv gives the last occurrence precedence, so the credential
resolved to `""`. Every conversation turn was accepted and stored, then failed
about 60 ms later in the Worker with `Model gateway gemini is not fully
configured`, classified `INTERNAL`.

**Steps:**

1. Set `MODEL_GATEWAY_PROVIDER=gemini` and `MODEL_GATEWAY_MODEL`, then declare
   `MODEL_GATEWAY_API_KEY=` (empty) after a populated declaration of the same key.
2. Start `apps/api` (`npm run dev`) and the Worker (`npm run worker:dev`).
3. Restore a single populated declaration and start both again.

**Expected outcomes:**

- Both processes exit at startup. The error names `MODEL_GATEWAY_API_KEY` and
  states that dotenv gives the last occurrence precedence.
- No credential value appears in the error, logs, metrics or trace attributes.
- With one populated declaration both processes start, and a conversation turn
  reaches the model (`agent_runs` records a row for `travel.conversation`).

### TS-MG2 — 对话 run 在服务端失败时，界面不谎称消息没发出去

**Objective:** Verify a FAILED `CONVERSATION` run is reported as a failure that
happened after the message was stored, and does not offer a useless retry.

**Steps:**

1. Send a message in a trip-private thread while the model gateway is
   misconfigured (or otherwise force a `CONVERSATION` run to finish `FAILED`
   with `errorCode=INTERNAL`).
2. Read the alert rendered under the conversation.

**Expected outcomes:**

- The alert states the failure was on the server side and that the message was
  saved; it never says the message could not be sent.
- No Retry button is offered for `INTERNAL`; `isRetryableFailure` already
  excludes it, and repeating the turn reproduces the same failure.
- The user message remains in `chat_messages` and the thread transcript.
- An unclassified conversation failure with no error code keeps the neutral
  "could not finish this reply" copy plus its Retry affordance.

## HERO 测试

### TS-H0 — Authenticate with Cognito and list only member trips

**Stories:** H1, H2, S1

**Objective:** Verify an authenticated Cognito subject can load only its own
private Profile and trip memberships without submitting a user ID.

**Starting conditions:** Alice, Bob and Chen exist as seeded users; their trip
memberships overlap only where explicitly configured.

**Steps:**

1. Call a protected endpoint without an access token and with an invalid token.
2. Call `GET /api/v1/trips` with separately verified Cognito access tokens for
   Alice, Bob and Chen fixture subjects.
3. Attempt to read an Alice-only trip as Bob.
4. Read and partially update Alice's Profile, omitting unchanged fields.
5. Submit an unknown Profile field, a `null` value, a missing/invalid bearer
   token, and an unknown route.

**Expected outcomes:**

- The API derives identity only from a verified token `sub`; the removed Demo
  Users endpoint is not published and private routes reject missing/invalid JWTs.
- Each trip list contains only server-verified memberships, with stable order,
  stored route/date fields, server-derived `memberCount`, and the caller's role.
- Trip details expose safe member `displayName` but not other members' private
  Profile data; unrelated access is denied.
- Profile PUT preserves omitted fields, permits owner nationality edits, rejects
  `null`/unknown/server-owned fields, and generates `updatedAt` server-side.
- Every failure uses the normalized error body and a matching
  `x-correlation-id` header.

### TS-H3a — Normalize flight provider results and fail closed

**Stories:** H3, P1
**Objective:** Verify `FlightProvider` validates and normalizes provider results without fabricating availability or using runtime fixture fallback.

**Starting conditions:** Test-only FlightProvider doubles and adapter contract fixtures cover configured Hero routes, dates and provider failures for Amadeus, FlightAPI and SerpAPI. Runtime paths never import these fixtures; adapter tests mock all HTTP.

**Steps:**

1. Search the same supported origin, destination and date range twice under a snapshot ID.
2. Inspect source, capture time, price and normalized route fields.
3. Search a date range that excludes the configured departure.
4. Search an unsupported route.

**Expected outcomes:**

- Test-only supported searches return deterministic normalized offers; production adapter responses carry their real source, capture time and expiry.
- Results outside the requested date range are excluded.
- Unsupported searches return no offers and never fabricate inventory or price.
- A SerpAPI response may only contribute normalized flight fields after its Google Flights response schema validates. Airport-local wall-clock values returned at minute precision are normalized to the shared seconds-precision contract without inventing a timezone; existing provider seconds are preserved. Its query-parameter API key, supplier links, raw payload, booking/departure tokens and provider error text never enter evidence, Tool output, logs or traces.
- For a multi-destination Shared PLAN, an early model final answer is rejected while any authoritative `origin × destination` cell remains `MISSING`. The server returns only the controlled coverage status to the bounded model loop and requires another genuine `flight.search` call. Repeated calls for an identical controlled cell reuse that loop's normalized result and do not issue another provider request or consume another live credit.

### TS-H3b — Reject unauthorized or fabricated plan output before persistence

**Stories:** H3, P1
**Objective:** Verify model output cannot create authoritative facts or bypass the immutable snapshot.

**Starting conditions:** A snapshot authorizes one member preference, two departure origins and Tokyo; deterministic Flight/Stay/Ground evidence exists for the planning run.

**Steps:**

1. Validate a structurally complete plan whose selected offers exactly match provider evidence.
2. Reference a snapshot field that is absent from `authorizedData`.
3. Replace a selected origin or destination with an unapproved value.
4. Remove source provenance or alter a provider-backed price/offer field.
5. Submit a valid deterministic `LLMGateway`-style structured candidate through `PlanningService`.
6. Submit malformed or evidence-mismatched `LLMGateway`-style output through `PlanningService` and inspect persistence and the API error.

**Expected outcomes:**

- The valid plan passes with all required origins and provenance intact.
- A valid LLM-style candidate is persisted only after the authoritative validator succeeds.
- Unauthorized fields, unapproved routes, missing sources, malformed structure and evidence mismatches fail closed with `PlanValidationError` and HTTP `422`.
- Violations contain only stable `code`, `fieldPath` and low-risk `reason`; rejected values and private snapshot data are absent.
- A failed candidate creates no `itineraryPlans`, `providerOffers`, `sourceEvidence` or `PLAN_CREATE` audit record; safe model-run observability may still be recorded.
- Provider results narrow explicitly between `LIVE` and `UNAVAILABLE`; unsupported requests contain no fabricated `data` or Demo data fallback.

### TS-H3c — Configure a server-side LLM provider with fail-closed behavior

**Stories:** H3, P1
**Objective:** Verify Gemini, OpenAI and OpenAI-compatible configuration resolves only with the necessary server-side settings.

**Steps:**

1. Set `MODEL_GATEWAY_PROVIDER=gemini`, a non-empty `MODEL_GATEWAY_API_KEY`, and `MODEL_GATEWAY_MODEL=gemini-3.1-flash-lite`; verify that explicit model path.
2. Set `MODEL_GATEWAY_PROVIDER=gemini` without `MODEL_GATEWAY_MODEL`.
3. Set `MODEL_GATEWAY_PROVIDER=openai` without `MODEL_GATEWAY_API_KEY`.
4. Set `MODEL_GATEWAY_PROVIDER=openai-compatible` first without, then with, API key, base URL and model.
5. Simulate a configured provider timeout or malformed response.

**Expected outcomes:**

- Gemini uses Google's OpenAI-compatible endpoint; OpenAI retains its default endpoint.
- A provider or model with absent required settings is rejected and never sends a request with an empty key.
- A compatible provider is enabled only when all three required settings are present.
- Provider failures record safe failure telemetry and return a controlled error; no fake candidate, key, private snapshot data or provider response body is logged.

### TS-H1 — Save, reuse and override a private travel profile

**Stories:** H1  
**Objective:** Validate explicit memory without accidental long-term overwrite.

**Starting conditions:** Alice has no Profile.

**Steps:**

1. Alice saves budget range, art interest, city-center stay and no-red-eye preference.
2. Alice tells her private Agent a one-time different budget for the new trip.
3. Inspect plan input origins.
4. End the trip, start another trip, and inspect reused preferences.
5. Delete the no-red-eye field and start a new plan.

**Expected outcomes:**

- Stable preferences are stored with origin/time and appear in later plans.
- One-time budget override does not overwrite stable budget without explicit save.
- Deleted field is absent from future Agent inputs.
- No Profile field appears in a shared view before consent.

### TS-H1e — Maintain structured long-term and current-Trip memory without widening consent

**Stories:** H1, H2, H3, S1
**Objective:** Verify stable facts, low-risk behavior suggestions and current-Trip memory use the controlled fact/snapshot path rather than private chat or direct Shared Agent reads.

**Starting conditions:** Alice has a Profile and two active Trips. One Trip contains an active plan using Alice's authorized accommodation style; the other has no consent for that field. Bob is a member of the first Trip.

**Steps:**

1. Record enough allow-listed, non-sensitive behavior events to create a suggested accommodation-style update: at least three independent server-confirmed episodes across at least two Trips, spanning at least 30 days. Inspect the proposal and its audit/telemetry records.
1a. Record evidence that satisfies only part of the trigger rule — three episodes inside a single Trip; three episodes inside a 30-day window; a candidate whose activation stays below the threshold; and two competing candidates for one field separated by less than ln(2).
1b. Replay an already-counted action/event id, and record two distinct episodes that land on the same UTC day.
2. Confirm the proposal, then update and delete the resulting stable fact through the Profile memory API.
3. Attempt to create behavior or conversation-derived proposals for nationality, passport, date of birth, health and accessibility fields.
4. Save a `this trip` preference and a group decision in the first Trip; attempt to read them from the second Trip.
5. Start planning, modify one authorized fact and revoke its consent before plan activation. Inspect snapshots, plans, confirmations, Worker inputs and Shared Agent skill inputs.
6. Bob attempts to read Alice's private facts and to use a previous Trip's memory as planning input.

**Expected outcomes:**

- The automatic proposal contains only allow-listed field metadata, observation count, expiry, scoring version and a bounded UTC-day observation window (at most 10 dates); it contains no raw chat text, action type, page path, event reference or sensitive value. It is not a fact, snapshot input or shared data until Alice confirms it.
- Partial evidence never surfaces a suggestion: a single Trip, a span under 30 days, activation below the threshold, or two candidates within ln(2) of each other all leave the proposal unshown while evidence keeps aggregating.
- A replayed action/event id does not increment the observation count; two distinct episodes on the same UTC day both count. Independence comes from existing idempotency, never from elapsed time.
- Confirmed facts never decay and are never rewritten by behavior. Repeated contradiction can only raise a suggestion; ignoring it lets the proposal expire after 90 days, and dismissing it suppresses the same field/value for 180 days.
- Editing the fact directly through the Profile form clears conflicting pending proposals and their evidence aggregates for that field.
- Reaching any terminal proposal state clears the stored observation dates; deleting a field's memory removes its facts, pending proposals, candidate aggregates and observation window.
- Only the owner can confirm, dismiss, edit or delete personal facts. Confirmation creates an active structured fact; deletion removes it from future projections and retains only a content-free audit event.
- Sensitive-field proposal attempts fail closed; no model or behavior pipeline creates a row for them.
- Trip memory is scoped by `tripId`; cross-Trip reads and projections are denied. Shared Agent reads only the server-built current snapshot projection, never the personal fact, proposal or chat tables.
- A projected fact/consent change makes the first Trip's active plan and confirmations `STALE`; the old run cannot activate a plan. The unrelated Trip is unchanged.
- Logs, metrics, traces, audit summaries, SSE and idempotency payloads do not contain memory values, observation dates, event references, conversation text or high-cardinality identifiers as metric labels.

### TS-H1e-PERSONAL-NOTE — Owner-only free-text long-term memory

**Objective:** Verify Personal Notes remain a bounded, owner-only exception to structured memory.

**Steps:**

1. Create an `ACTIVE` pinned Profile Personal Note and a current-Trip Personal Note.
2. Start a Personal Agent turn inside that Trip and inspect its server-built memory context.
3. Create a snapshot and start Shared Planning for the same Trip.
4. Attempt to save a note containing a passport number, phone number, payment number or mobility information.
5. Archive the note and retry the Personal Agent turn.

**Expected outcomes:**

- The Personal Agent receives at most three active notes and at most 900 characters; current-Trip and pinned notes take precedence.
- The note never appears in `authorized_data._meta.memory`, a Shared Planning model input, Team API response, audit summary, metric label or trace attribute.
- Sensitive note content is rejected before persistence or model invocation.
- Archived notes are not included in any conversation context.

### TS-H1e-SHARED-PLANNING-MEMORY — Safe consumption and output guard

**Objective:** Verify only the parsed, current snapshot projection reaches Shared Planning.

**Expected outcomes:**

- Consented profile facts and current-Trip decisions reach the typed planning memory input; unconsented and form-only fields do not.
- A malformed memory namespace fails closed.
- A plan echoing a value or key from `confidentialOverrides` is rejected with `CONFIDENTIAL_VALUE_LEAK` and is not persisted.
- Older snapshots without a memory namespace remain plannable with an empty memory input.

### TS-H1b — Persist and delete a private conversation without widening its scope

**Stories:** H1, S1
**Objective:** Verify that a private conversation is durable and owner-controlled, while its text remains outside shared planning and telemetry.

**Starting conditions:** Alice is authenticated and has a private conversation thread, optionally associated with one shared trip.

**Steps:**

1. Alice submits two Personal Agent turns for a selected fixture/inspiration, repeats one request ID, reloads the application, and reopens the same thread.
2. Bob and Chen attempt to list, read or delete Alice's thread by guessing its `conversationId`.
3. Alice creates a shared-trip plan without explicitly confirming any chat-derived Profile or trip override.
4. Inspect the shared snapshot, plan explanation, logs, traces, metric labels and audit summary.
5. Alice deletes the thread, then attempts to reopen it; inspect the previously created Profile/override facts.

**Expected outcomes:**

- Only Alice can submit turns and list, read or delete the thread; reload preserves readable USER/ASSISTANT messages until deletion.
- The same Skill version can execute for later turns, and duplicate request IDs do not create duplicate USER/ASSISTANT rows.
- Public clients cannot choose SYSTEM/ASSISTANT roles or sender identity; deterministic policy refusal is visibly `SAFE_REFUSAL`.
- A `tripId` association does not grant fellow trip members or the Shared Agent access to the thread.
- Raw message text is absent from the snapshot, shared plan/explanation and all telemetry/audit outputs; it is not default model context for the planning run.
- Deletion removes message bodies and makes the thread unavailable to Alice; separately confirmed Profile/override facts remain until independently deleted.

Runnable coverage: see `apps/api/tests/chat-conversation-e2e.test.ts` (202 acceptance, owner scope, active-run exclusion, idempotency, Worker completion, explicit queued cancellation, bounded retry failure, deterministic sequence and safe recall), `apps/api/tests/conversation-gateway.test.ts` (structured and streamed model paths plus controlled failure), `apps/web/src/components/explore/travel-agent-chat.test.tsx` (temporary delta ordering, generation-attempt replacement, Stop semantics and history recovery), `apps/web/src/lib/api/http-travel-api.test.ts` (authenticated fetch-SSE parsing), `apps/api/tests/agent-run-stream-headers.test.ts` (cross-origin and correlation headers survive the hijacked stream), `apps/api/tests/chat-threads-route.test.ts` and `apps/api/tests/thread-recall-skill.test.ts`. Worker-process kill/recovery and deployed proxy buffering remain manual release checks.

### TS-H1b-LANGUAGE — User-visible prose follows the current-turn language authority

**Stories:** H1, S1
**Objective:** Verify that every private-chat prose mode applies one shared language rule without allowing historical context or destination metadata to switch languages.

**Steps:**

1. Send Chinese, English, Japanese/Korean and mixed-language private-chat questions; include a thread history written in a different language and destinations whose local language differs from the current question.
2. Repeat each request with an explicit instruction to answer or translate into another language.
3. Exercise both the structured and SSE-streaming conversation paths; inspect the assembled system prompt in the fake provider.
4. Request a public location introduction with `locale: "zh"` for a non-Chinese destination, then repeat with `locale: "en"`.

**Expected outcomes:**

- The private-chat answer uses the explicit requested language when present; otherwise it uses the current question's dominant language. History, memory, destination locale and provider evidence do not switch it.
- Both conversation paths contain exactly one shared user-visible language rule. The rule does not alter typed plan, extraction, evidence, tool-argument, enum or ID contracts.
- Public location introduction has no user-question language inference: it uses only the validated request locale and distinct locale cache key; the destination's local language cannot override it.

Runnable coverage: `apps/api/tests/conversation-gateway.test.ts` and `apps/api/tests/llm-gateway-location-introduction.test.ts`.

### TS-H1b-TITLE — Own, localize and rename a private thread title without widening its scope

**Stories:** H1, S7, S1
**Objective:** Verify that thread titles are server-authoritative, correctly localized, owner-controlled, and that LLM-assisted naming fails closed without leaking private conversation content.

**Starting conditions:** Alice uses the Chinese UI, is a member of one trip with a default thread and at least one extra thread. Bob is a fellow member of the same trip.

**Steps:**

1. Alice starts a new exploration and accepts a trip invitation, both with `locale: "zh"`; inspect the resulting default thread titles and `title_source` / `title_locale`.
2. Alice opens two browser tabs on the same trip workspace and creates one extra thread in each, at the same time.
3. Alice renames one thread; then triggers AI naming on it. Then she confirms the overwrite and triggers AI naming again.
4. Alice triggers AI naming on a thread that has no USER message; on a thread with messages while the model gateway is unavailable; and on a thread where the model returns a title containing a URL, an e-mail address, a 9-digit number, and separately a verbatim copy of her first message.
5. Bob attempts to read, rename and AI-name Alice's threads by their `threadId`.
6. Alice exceeds the per-user rate limit for AI naming.
7. Inspect the shared plan surface, member list, invitation preview, logs, traces, metric labels and audit summaries after all of the above.

**Expected outcomes:**

- Server-created titles are Chinese (`行程规划`), not the English placeholders `Trip Planner` / `Personal trip scratchpad`; they carry `titleSource: "AUTO"` and `titleLocale: "zh"`.
- The two concurrent creations produce two distinct server-numbered titles; the browser sends no title.
- Renaming sets `titleSource: "MANUAL"`; the first AI-naming attempt returns `applied: false, reason: "MANUAL_LOCKED"` and does not call the gateway; the confirmed-overwrite attempt succeeds and returns `titleSource: "AUTO"`.
- The empty thread returns `NO_MATERIAL` without calling the gateway; the gateway outage returns `UNAVAILABLE`; each of the four bad model outputs returns `REJECTED`. In all cases the stored title is byte-identical to what it was before the request.
- Bob receives `403` for read, rename and AI-name on a thread that exists in his trip but belongs to Alice, and `404` for a thread id that does not exist or belongs to another trip — the same two-code split the pre-existing `requireOwnedTripThreadRead` uses, so `404` keeps its meaning.
- Exceeding the rate limit returns `429` and leaves the title unchanged.
- No thread title appears in the shared plan surface, member list, invitation preview, logs, traces or metric labels. `CHAT_THREAD_TITLE_UPDATE` audit rows contain only `{ threadId, source }` and no title text. `thread_title_writes_total` carries only the bounded `source` / `result` labels.

Runnable coverage: `apps/api/tests/thread-title-service.test.ts` (locale-correct deterministic titles), `apps/api/tests/thread-title-suggest-postprocess.test.ts` (the post-processing rules, including private-use and hidden tag code points and the global-strip regression), `apps/api/tests/thread-title-suggest-route.test.ts` (concurrent creates get distinct titles, `MANUAL` lock and explicit overwrite, a rename landing mid-model-call, all four `applied: false` reasons, owner scope, and an audit summary with no title text), `apps/api/tests/chat-threads-route.test.ts` (manual rename, non-owner `403`, unknown `404`, length limit) `apps/api/tests/llm-gateway-thread-title.test.ts` (locale as the sole language authority, only the supplied message texts leaving the boundary, retry, and fail-closed on a bad shape or a throwing provider) and `apps/web/src/components/trips/trip-workspace.test.tsx` (server-owned numbering on create, and each refusal reason rendered as prose). A run against a real configured provider remains a manual release check. Contract: [Thread 标题生命周期实施规范](thread-title-lifecycle-implementation.md).

### TS-H1c — Stream a durable private Agent turn across disconnects

**Stories:** H1, S1, S2
**Objective:** Verify an authenticated owner receives only safe stream events while a submitted question continues on the server through browser/SSE disconnect, Worker recovery and controlled upstream failure.

**Starting conditions:** Alice owns a thread; the configured model gateway can emit ordered chunks, an unsafe candidate and a controlled failure.

**Steps:**

1. `POST` an authenticated turn command with a fresh `requestId`; verify `202`, a persisted USER message and one `agent_task_runs` row.
2. Attach an authenticated SSE observer and confirm every displayed segment passed the streaming safety gate; complete the response successfully.
3. Submit another question, consume at least one event, then close the browser/SSE connection and verify the Worker completes without cancellation.
4. Submit a third question, issue explicit Stop, and simulate an upstream network/5xx failure on a fourth.
5. Kill the claiming Worker after it acquires a lease; start/allow another Worker to recover it. Repeat completed and running request IDs concurrently.
6. Submit “请你帮我找一下西门町附近的酒店”; inspect the LLM reply and model/provider boundaries. Continue in the same thread with the requested conditions and inspect the LLM's search summary and explicit chat-confirmation prompt.
7. Inspect task rows, messages, idempotency records, audit, logs, traces and metric labels.

**Expected outcomes:**

- The command endpoint accepts the existing authenticated conversation request DTO and returns `202`; a separate authenticated `fetch` SSE observer receives live events. No native `EventSource` authorization workaround or WebSocket is required.
- The stream response itself carries the negotiated cross-origin headers and `x-correlation-id`. A browser observer on an allowed origin renders incremental deltas; it must not fall back to polling the run and revealing the whole answer at once.
- Event order for a connected observer is `turn.started` → zero or more safe progress/text events → exactly one terminal `turn.completed`, `turn.cancelled`, `turn.stale` or `turn.failed`; no event exposes prompt text, chain-of-thought, raw provider payload, unvalidated token or unapproved data.
- `COMPLETED` persists exactly one USER and one final-policy-approved ASSISTANT message atomically and is replayable by request ID.
- Browser/SSE disconnect does not cancel the run. Explicit Stop produces `CANCELLED`; terminal failure preserves the submitted USER message exactly once, persists no partial ASSISTANT body, and exposes only a safe terminal code/status.
- Concurrent Workers cannot both commit a result: lease expiry/recovery may repeat an external model call, but final persistence is conditional on the current lease token and task state. A concurrent request ID cannot duplicate the USER message or create a second task.
- Hotel-search turns use `travel.conversation` and the server-owned `HOTEL_SEARCH_READINESS` constraint. The LLM reuses same-thread facts, asks only for missing city, dates, adult/room configuration and currency, then summarizes the proposed search and asks for an explicit chat reply of “确认搜索”. No confirmation/setup card or `research.intent_extracted` event is rendered. Before a separately implemented server-validated chat-confirmation command, it sends no provider request. Qualitative requests such as “西门町哪里适合住” remain ordinary constrained conversation.
- Text, prompts, chunks and model payloads are absent from audit summaries, logs, traces and metric labels.

### TS-H1f — Route private research intent through explicit owner confirmation

**Stories:** H1, H3, P1, S1, S2
**Objective:** Verify that a Personal Agent can classify a high-confidence Chinese or English research request into a non-executable, recoverable draft while retaining the private-chat, authorization, and provider-evidence boundaries.

**Starting conditions:** Alice owns an active Solo Trip with destination, dates and confirmed search preferences. Hotel provider feature configuration and quote-nationality authorization can be toggled by test doubles. Alice has a Trip thread; Bob is a different active member with a separate private thread.

**Steps:**

1. Alice submits Chinese and English messages requesting a hotel search, a full itinerary, an activities/place search, a general accommodation-area recommendation, and a low-confidence ambiguous message.
2. Observe the accepted conversation run, its SSE events, final assistant message, persisted safe draft and provider/audit records before Alice confirms any card.
3. Disconnect the SSE observer, reload the chat, read the owner-safe agent-run DTO and dismiss the restored draft. Repeat with a fresh draft and owner confirmation.
4. Repeat the hotel request for a `DRAFT` Trip, missing dates, missing stay preferences, disabled hotel provider, and missing Nuitee quote-nationality authorization.
5. Submit “from Taoyuan Airport to Xiyuan Town how do I get there?” before two route endpoints are selected/adopted; then repeat after the owner has explicitly adopted two non-private ACTIVE TripPlaces and selected a mode.
6. After draft generation but before confirmation, revoke a required authorization or change a search preference. Confirm the old card. Simulate provider timeout, no results and invalid provider output after a valid confirmation.
7. Inspect task rows, snapshots, SSE, audit summaries, logs, traces, metrics and all Bob-visible responses.

**Expected outcomes:**

- Explicit hotel, planning and activity/place requests produce only a controlled `research.intent_extracted` draft with enum capabilities and readiness state. General qualitative advice and low-confidence messages remain ordinary conversation.
- Before confirmation, no snapshot, `RESEARCH` task, Shared Skill, provider request, provider evidence or booking authority exists. The Personal Agent never directly calls a provider or Shared Skill.
- A draft survives SSE disconnect and refresh through the owner-safe run DTO. Dismissal creates no research task; duplicate confirmation request IDs are idempotent and create at most one snapshot/task.
- Missing Trip status, dates, preferences, provider approval or Nuitee authorization returns a stable readiness gap and a next-step UI state; the Trip workspace renders the corresponding setup card with each missing item rather than only a chat-text instruction. It never calls Nuitee or emits a fabricated hotel result.
- An unconfirmed or ambiguous route request never calls `navigation.route` and never substitutes unrelated existing TripPlaces. Only two owner-adopted ACTIVE, non-private endpoints plus an explicit mode may reach confirmed navigation research.
- Confirmation revalidates all current authority. A revoked authorization, changed preference, stale Trip or expired draft cannot reuse the previous classification-time state to start research.
- Provider timeout, no results and schema failure produce `UNAVAILABLE`/`COMPLETED_WITH_GAPS` with safe source/status metadata and never a model-invented price, availability, schedule or route.
- Draft JSON, audits, logs, traces, SSE and metric labels omit raw chat text, free-form route/place names, Profile/nationality values, provider URLs/raw payloads and high-cardinality identifiers. Bob cannot read Alice's draft or private conversation.

Runnable coverage: add `apps/api/tests/services/personal-research-intent-classifier.test.ts`, extend `apps/api/tests/conversation-safety.test.ts` and `apps/api/tests/chat-conversation-e2e.test.ts`, extend `apps/api/tests/routes/research-command.test.ts`, and add Web coverage for `TravelAgentChat` draft recovery, Trip workspace setup-card rendering, plus `ResearchConfirmationCard` readiness/dismissal behavior.

### TS-H1d — Same-thread bounded LLM context survives re-entry

**Stories:** H1, S1
**Objective:** Verify that reopening the same private thread restores a bounded same-thread LLM context without widening owner, Trip, persistence, or telemetry boundaries.

**Starting conditions:** Alice owns a Trip thread containing more than the configured context window of alternating `USER` and `ASSISTANT` messages. Bob is an active member of the same Trip and owns a separate thread. A fake model gateway captures its request payload; the Worker is able to retry an accepted task.

**Steps:**

1. Reopen Alice's existing thread after a full browser reload, then submit a follow-up that depends on a recent prior turn.
2. Inspect the fake gateway payload and assert it contains chronological raw messages only from Alice's thread, plus the current question and the existing allow-listed Trip context.
3. Seed enough prior messages to exceed both the configured turn and character budget. Submit another turn and inspect the payload.
4. Accept a turn, append a later legacy message before Worker retry, then retry the same task after a controlled transient model failure.
5. Attempt the same operations as Bob and inspect all fake-gateway, audit, log, span, metric, SSE, idempotency, and task-row data.

**Expected outcomes:**

- The recent context survives reload/re-entry because it is rebuilt from the authoritative thread archive; neither the browser nor TanStack Query persists or submits message history.
- Context contains only complete `USER`/`ASSISTANT` messages from the accepted task's `threadId`, in chronological order, and never another thread, Profile, consent, snapshot, plan, provider fact, or shared-member field.
- The current user message is always present. The oldest messages are removed first to satisfy the configured complete-turn and character budgets; the model is permitted to state that earlier context is unavailable.
- A retry uses the task's saved upper message-sequence boundary and therefore cannot include content appended after task acceptance. It may repeat the bounded model call but persists at most one final assistant message.
- Raw context appears only in the outbound configured-model request. It is absent from `agent_task_runs`, audit summaries, logs, traces, metric labels, SSE events, browser storage, and all Bob-visible responses.

### TS-H2 — Invite member and enforce field-level sharing

**Stories:** H2  
**Objective:** Verify shared collaboration without importing group chat or leaking private memory.

**Starting conditions:** Alice has a Profile and a new shared trip; Bob and Chen have separate Profiles.

**Steps:**

1. Alice invites Bob and Chen; both join using the shared-trip flow.
2. Alice shares no-red-eye and art interest; Bob shares budget but declines nationality; Chen shares departure limitation and separately chooses nationality consent.
3. Open shared workspace as Alice, Bob and Chen.
4. Revoke Alice’s art-interest consent.
5. Attempt cross-user access to Bob’s unshared fields/private history.

**Expected outcomes:**

- No chat copy/paste/upload is required.
- Shared workspace exposes only approved fields with member/source labels for all three members.
- Consent revocation expires affected plan outputs.
- Unshared Profile/private history is inaccessible to other users and Shared Agent output.

### TS-H3 — Compare authorized multi-origin destination plans

**Stories:** H3, P1  
**Objective:** Confirm multi-service orchestration uses one authorized snapshot to compare two to three destinations for three travelers departing from two origins.

**Starting conditions:** Both members have current consent; Flight/Stay/Ground provider results are available through test-only doubles.

**Steps:**

1. Start Shared Agent planning with Alice and Bob at origin A and Chen at origin B.
2. Inspect input snapshot IDs for all three tools and destination candidates.
3. Review destination comparison, per-origin flight, hotel and ground results, sources/times/prices and linked constraints.
4. Disable Ground tool for one candidate.
5. Inspect the `UNAVAILABLE` missing-service response.

**Expected outcomes:**

- All tools and candidates use the same consent/constraint snapshot.
- Two to three candidates show three services when data exists and explain authorized constraints only.
- Each fact has a source/time and, for flight offers, an expiry.
- Tool failure is explicit `UNAVAILABLE`; no inventory or price is fabricated or substituted.

### TS-H3-GROUND-1 — Shared keyword POI search and arbitrary-place navigation

**Stories:** H3, P1, S1
**Objective:** Verify that only a Shared PLAN/REPLAN Worker can resolve keyword POI candidates and route between two authorized Trip places without accepting client/model coordinates or provider parameters.

**Starting conditions:** An authenticated three-member planning Trip has one immutable snapshot containing Tokyo as a candidate; deterministic ORS Place and Directions doubles are configured; Alice has one private hotel place and two team-visible attractions.

**Steps:**

1. Drive a durable planning run whose model requests `places.search` with `destinationId=Tokyo`, keyword `Senso-ji` and `ATTRACTION`, then uses one returned current-run candidate to propose a team-visible `TripPlace`.
2. Request `navigation.route` between that adopted place and the team-visible hotel using `WALK`; retrieve the authorized route DTO used by the map.
3. Repeat with a browser/model supplied longitude/latitude, address, URL, provider/profile, a place candidate from another run, a private place owned by Bob, a revoked place and origin equal to destination.
4. Force Place and Directions `NO_RESULTS`, 429, timeout and malformed payload outcomes independently while Flight/Stay/Activities research continues.
5. Change or revoke an active team-visible place after a route is persisted; then attempt to display, adopt, confirm and book the old plan.

**Expected outcomes:**

- The provider receives only server-resolved destination bias or authorized coordinates; no raw browser/model coordinate or provider option crosses the boundary.
- At most the configured candidate/result/tool-loop limits execute. Candidate IDs are valid only for their task/run and cannot become Trip facts without proposal/adoption authority.
- The returned route has source, captured time, distance, duration, mode, steps and geometry; geometry is sent only to authorized Trip UI consumers and never to the model, logs, traces, metrics or audit summaries. ORS attribution is visible with the route.
- All rejected inputs fail closed with stable policy/schema codes and create no place, route evidence, plan, confirmation or booking authority.
- A navigation/POI provider gap produces a safe `COMPLETED_WITH_GAPS` research summary, does not cancel other service research and does not fabricate a route, price or schedule.
- Changing/revoking an adopted shared place atomically makes dependent route evidence, active plan and confirmations `STALE`; a late/duplicate worker cannot reactivate them.

### TS-H3-GROUND-2 — Mobility offers are distinct from navigation routes

**Stories:** H3, H6, S1
**Objective:** Verify that transfer/taxi/charter evidence can be shown as live pricing or an explicit estimate but cannot be substituted for a route, automatically booked, or used after expiry.

**Steps:**

1. Use two authorized Trip places and request a configured Amadeus Transfer Search double that returns one price, one estimated taxi price and a booking link.
2. Inspect normalized mobility evidence, `provider_offers`, source evidence, plan DTO and model tool output.
3. Attempt to use navigation evidence as a mobility price, use an expired offer, invoke booking without a user-selected live offer, and pass a provider booking link through the API/UI.
4. Disable Mobility while retaining navigation and repeat the planning run.

**Expected outcomes:**

- Routes are persisted only as navigation evidence; only commercial mobility results may enter `provider_offers`, and estimated prices are visibly marked as estimates.
- Booking links and raw provider payloads never enter model context, persistence, SSE, audit or UI. No search automatically creates booking authority.
- An unavailable/expired Mobility capability appears as a safe gap while the task completes; the selected service cannot reach confirmation/sandbox without fresh live evidence and explicit user selection.

### TS-H4 — Create individualized visa readiness safely

**Stories:** H4, P1  
**Objective:** Verify global, provider-backed two-stage nationality-specific readiness without legal claims or unauthorized inference.

**Starting conditions:** Alice authorizes nationality; Bob initially does not; Chen has separate consent; two to three destination candidates, two normalized flight offers to the same destination with different transit airports, an approved provider double and official-source fixtures exist.

**Steps:**

1. Generate candidate comparison and destination-level readiness checks before any flight offer is selected.
2. Inspect Alice’s candidate checklist source, checked time, applicable traveler, destination stage and the explicit route/transit-pending marker.
3. Select the first current, unexpired flight offer; inspect the durable route-readiness task and its destination/transit nodes derived only from normalized server-side segments.
4. Switch to the second offer with a different transit airport; inspect that the first route-level result is `STALE` and the new route fingerprint is checked independently.
5. Inspect Bob’s result without nationality consent; assert no provider request is made for Bob.
6. Bob grants nationality consent, then revoke it after list creation.
7. Load provider `NO_INFORMATION`, 429, timeout, malformed response, uncertain/expired source and airport-country-resolution-failure fixtures.
8. Attempt cross-member detail reads and inspect team summary, plan explanation, SSE, audit, logs, traces and metric labels.

**Expected outcomes:**

- Each authorized traveler has a personal, sourced destination-level checklist or explicit verification gap for every displayed candidate. Before flight selection it never claims transit coverage; it explicitly marks the route check pending.
- Route-level results are produced only for a user-selected current offer, use its actual ordered segments, and become `STALE` on offer switch/expiry, route/snapshot change or consent withdrawal.
- Bob sees a request to self-check until he authorizes data; the system makes no provider call and infers no nationality.
- Team summary and every non-owner surface contain only aggregate counts; nationality, passport data, raw provider payloads, URL query data, application links and another member’s checklist never appear.
- Provider/data/airport-resolution failures create `UNAVAILABLE` or official-verification gaps, not a certain conclusion, fabricated checklist, active evidence or booking authority.

### TS-H5 — Re-plan after a flight shock

**Stories:** H5  
**Objective:** Validate self-correction while preserving consent and personal constraints.

**Starting conditions:** Current shared plan includes three members, two origins, destination candidates, provider evidence and authorizations.

**Steps:**

1. Trigger one flight-price-increase/sold-out event or Chen’s departure constraint change.
2. Inspect new tool/consent snapshots and old-plan expiry.
3. Review old/new destination ranking, flight, stay, ground, constraints, visa impact and explanation.
4. Trigger same event ID again.
5. Trigger a no-feasible-alternative provider result.

**Expected outcomes:**

- One change creates one re-plan; duplicate is idempotent.
- UI identifies preserved and affected constraints for all three travelers and the changed candidate ranking.
- No automatic charge, booking or silent replacement occurs.
- No-feasible state names blocking constraints and returns members to editing/consent.

### TS-H5a — Confirm a private orchestration constraint and adopt an automatic replan

**Stories:** H2, H3, H5, S1
**Objective:** Verify a Personal Agent proposal can become a confidential Shared planning constraint only after owner confirmation, and that automatic replan remains vote-gated.

**Steps:**

1. Alice asks her Personal Agent to avoid plans over a budget; inspect that it creates only a `PENDING` structured proposal.
2. Alice confirms the proposal as `ORCHESTRATOR_CONFIDENTIAL` and `HARD`; inspect the stale transaction and automatic REPLAN task.
3. Capture Bob and Chen's constraints/plan/read APIs, SSE, logs, traces, metrics and audit summaries while Shared planning runs.
4. Inspect the Shared Agent test gateway input and the final public plan explanation.
5. Have Alice and Bob vote `ACCEPT` on the generated `PROPOSED` plan and Chen vote `NEEDS_CHANGES`; then replace Chen's vote with `ACCEPT`.
6. Attempt booking before and after activation; revoke Alice's fact during a later adoption vote.

**Expected outcomes:**

- No proposal enters a snapshot or affects a plan before Alice confirms it.
- The confidential value is available only in the server-side Shared planning projection; it is absent from fellow-member responses, plan JSON/explanation, SSE, audit, logs, traces and metric labels. The UI presents the residual indirect-inference warning.
- The old plan and confirmations become `STALE`; the automatic task creates one `PROPOSED` plan. The old plan is comparison-only and never reactivates.
- A single `NEEDS_CHANGES` blocks activation; exactly one current `ACTIVE` plan is created only after all required members accept. Existing booking confirmation is still required after activation.
- Revocation stales the proposal/votes/run and cannot leave a confidential value in a future snapshot or activate a plan.

### TS-SHARED-SURFACE-1 — Broadcast the Shared Agent result to every member without opening a group chat

**Stories:** H3b, H2, H3, H5, S1
**Objective:** Verify the pinned shared plan surface is visible to every active member, renders only allow-listed shared data, never pre-empts another member's private conversation, and adds no write path.
**Starting conditions:** Trip with Alice, Bob and Chen as required members; confirmed flight search preferences exist; Bob has an unsent draft typed into his own private thread.

**Steps:**

1. Open `/trips/:tripId?view=shared` as each of Alice, Bob, Chen, and as a non-member.
2. Alice confirms a candidate batch in her private thread; capture the confirm response, Alice's view transition, and Bob's view/rail while the run is `QUEUED` → `RUNNING` → terminal.
3. While the run is active, capture every request Bob's browser issues and inspect the rendered tree, `localStorage` and the `GET /trips/:tripId` payload for all three members.
4. After the run completes, inspect the rendered plan cards for a candidate whose stay/hotel/activity provider returned `UNAVAILABLE`, and for an offer whose `expiresAt` has passed.
5. Alice and Bob vote `ACCEPT`, Chen votes `NEEDS_CHANGES`; re-submit Alice's vote with the same idempotency key; then Chen votes `ACCEPT`.
6. Remove Chen from the Trip and reload his surface. Disable `localStorage` in Bob's browser and reload. Interrupt Bob's SSE connection mid-run.
7. Attempt to find any input, send, comment or mention control on the surface, and any manual replan action.

**Expected outcomes:**

- The pinned entry appears for every active member, including when the Trip has no plan yet (empty state). The non-member receives `403` and no plan, constraint or run field is rendered.
- Alice is switched to the surface only when her run reaches a terminal state. Bob's rail shows an unread marker while his centre pane stays on his private thread and his unsent draft survives.
- Bob's rendered tree and `localStorage` contain no plan content, constraint value, snapshot, vote authority, run authority, owner-only constraints, pending brief proposal, research intent draft, personal research evidence, model rationale or conversation text. `localStorage` holds only the unread marker.
- `GET /trips/:tripId` returns `pinnedSession: null` for members other than the pinned run's creator, and the full DTO for its creator.
- The surface names no member as the trigger of the run and shows no `ORCHESTRATOR_CONFIDENTIAL` value or attribution.
- Every price renders with its currency, source and captured time; the expired offer is marked expired; the missing capability renders an explicit `UNAVAILABLE` gap and is never substituted from another candidate or an earlier run.
- One `NEEDS_CHANGES` blocks activation; the repeated vote with the same idempotency key creates no second vote; exactly one `ACTIVE` plan appears after all required members accept; `STALE` cards expose no vote or booking control.
- Chen's post-removal reload fails closed with the shared unauthorized message and clears the data area. Bob's surface renders correctly with `localStorage` unavailable (unread marker treated as 0) and recovers plan state by polling after the SSE interruption.
- No input, send, comment, mention or manual replan control exists anywhere on the surface; no shared `chat_thread` or `chat_messages` row is created by any step.

### TS-H6 — Confirm and run booking orchestration sandbox

**Stories:** H6  
**Objective:** Prove an Agent can prepare controlled action only after every required member approves.

**Starting conditions:** Current plan has all three services; sandbox configured.

**Steps:**

1. Alice and Bob confirm; Chen chooses `Needs changes`.
2. Attempt orchestration.
3. Chen confirms the current plan; inspect all three confirmations and no-charge disclosure.
4. Invoke sandbox; sign the exact callback JSON bytes with the configured HMAC
   secret and a timestamp exactly at the accepted window boundary.
5. Deliver the signed success callback twice and a signed late failure callback.
6. Repeat with a missing signature, malformed timestamp, expired timestamp,
   invalid signature, and a body modified after signing.
7. Change a price and attempt to invoke using old confirmations.

**Expected outcomes:**

- One non-confirming member blocks orchestration, even when the other two have confirmed.
- Current, unanimous three-member confirmation displays service items, price/currency, sources and no-charge boundary.
- Sandbox returns a single set of reference IDs; duplicate/late callbacks do not duplicate action.
- Callback auth is independent of Cognito bearer authentication; valid boundary requests pass,
  while missing/malformed/expired/invalid/tampered requests return the same
  generic `401` without leaking the secret, signature, or failure detail.
- Price change expires confirmations; stale plan cannot orchestrate.
- No payment is collected or claimed.

## PROOF 与 SUPPORT 测试

### TS-P1 — Run the three-minute Hero Demo deterministically

**Stories:** P2  
**Objective:** Verify the stated demo can run without manual data edits or unstable tools.

**Starting conditions:** Three seeded Profiles, two origins, two to three destination candidates, nationality rules, test-only provider doubles and a shock event are available.

**Steps:**

1. Run profile → invite two members → selective consent → candidate comparison → plan → visa → shock → re-plan + diff → three confirmations → sandbox.
2. Force one live tool unavailable.
3. Reset demo and rerun.

**Expected outcomes:**

- Entire flow completes in three minutes with deterministic test-only provider doubles.
- A production-like unavailable provider is visibly represented as `UNAVAILABLE`; no substitute data is shown.
- Reset removes shared-trip session state, not seeded Profiles.

### TS-P2 — Explore a map location without fabricating travel facts

**Stories:** P1
**Objective:** 验证地图探索可收集用户兴趣，同时保持 fixture-first 和隐私边界。

**Starting conditions:** 地图显示两到三个 fixture 目的地，且存在没有候选数据的空白区域。

**Steps:**

1. 点击预置候选地点标记，并查看地点档案。
2. 在国家、省/州、城市三个名称缩放层级分别点击地图；确认新图钉依次归类为对应国家、省/州和城市，同时始终停在用户实际点击的经纬度；随后缩放地图不会改变已有图钉的实体或位置。
3. 在同一城市范围再次点击，然后在聊天框中输入一个主要城市/首都名称。
4. 从地点详情打开私有灵感管理器，分别查看所选图钉周围 50 km 与全部标记。
5. 手动勾选多个私有灵感并执行批量删除；从详情执行单点删除，然后刷新页面。
6. 在全球、区域和本地缩放级别，确认国家、省/州和城市按层级显示；地图不显示图层控制面板。
7. 打开一个地点抽屉后，确认地图不会显示图层控制面板，且默认地理标注仍按缩放级别显示。
8. 点击国家、城市或省/州名称，再点击空白地图位置。
9. 从全球缩放逐步放大到区域缩放，检查陆地与海洋材质和地图标签。
10. 在未登录、未配置 Cognito 的浏览器会话中点击一个陆地点，并连续提交超过 30 次同一地点参考请求。
11. 在 Home 聊天框发送第一条消息后，点击“前往行程规划继续对话”。

**Expected outcomes:**

- 候选地点档案显示来源/时间或 `Demo data`，且解释只使用当前用户可见的资料。
- 客户端提交的 `FIXTURE` 只有在 source ID、名称和坐标均匹配服务端版本化地点时才可信；伪造或不匹配的数据必须降级为未验证灵感。
- 私聊在模型调用前拒绝实时价格、库存、签证/入境结论和预订状态问题；模型输出若包含此类无 provider 支撑的断言，必须替换为显式 `SAFE_REFUSAL`。
- 空白区域档案明确没有可验证候选资料，不生成地点、价格、库存、签证或预订结论。
- 对覆盖数据内的空白地图点击，离线位置参考可显示国家、一级行政区和最近主要城市，并带来源/版本/检查时间；城市超过 75 km、海洋或边界未匹配时必须省略相应字段或返回 `NO_REFERENCE`，不能猜测。
- 国家参考数据必须使用 Natural Earth 1:10m Admin 0，覆盖新加坡、香港、澳门、马耳他、摩纳哥、巴林等微型行政体：点击新加坡岛内坐标必须返回 `Singapore`/`SG`，不得返回马来西亚等邻国；France、Norway 等源记录 `ISO_A2` 为 `-99` 的国家仍必须返回 `FR`、`NO` 并能解析省/州与最近城市。
- 坐标不落在任何国家多边形内时，只在 10 km 海岸容差内回退到最近国家（例如圣淘沙返回 `Singapore`）；容差外的公海（例如 `0,80`）仍返回 `NO_REFERENCE`。容差回退结果与多边形命中同为位置参考，不得表述为行政归属、边界主张或地址。数据文件缺失或不可读时返回 `503`，不推断。
- 两档简化国家边界 mesh 必须都能画出跨度小于 1.5° 的微型国家轮廓（新加坡在 LOD-0/1 均有完整环），LOD-0 gzip 仍需在 200 KB 首屏预算内。
- 国家边界覆盖层的视口剪裁不得改变可见结果：视口内的 arc 必须绘制，横穿视口但端点都在视口外的 arc 不得被丢弃，跨 ±180° 的视口两侧都要绘制；zoom < 3、视口跨度接近全球或 map 无法报告 bounds 时退回不剪裁，绝不能出现边界整段消失。
- zoom ≥4.5 的全精度边界瓦片只能按视口请求：低 zoom 不得请求 `country-borders-lod3/index.json`，只请求视口覆盖且索引中列出的瓦片（不得因海洋瓦片缺失产生 404），瓦片信息必须与 `index.json` 的 sha256 一致且单片 gzip ≤150 KB。索引或任一必需瓦片缺失/失败时必须继续绘制 LOD-1 且不得出现边界缺口，也不得与瓦片同时绘制造成重复描边；失败的瓦片允许后续重试。
- 未登录会话只能匿名调用地点参考端点，成功时替换临时 `Pinned place N`；第 31 次同一客户端一分钟窗口内请求返回 `429`，不记录原始坐标或地址。Profile、行程、私聊、授权、规划、确认和预订在相同未登录会话中仍为 `401`。
- 空白区域只能保存私有灵感或请求后续加入候选；不改变共享约束、方案或确认状态。
- 点击时的 zoom band 决定新私有灵感的粒度：远景为国家，中景为省/州，近景为城市。手动图钉始终使用用户实际点击的经纬度；国家、省/州名称中心数据和服务端城市参考只负责识别、命名及去重，不得把手动图钉移动到首都或行政中心。图钉创建后粒度与实体不随之后的缩放升级、降级或聚合。相同层级、相同规范实体的第二次点击以最新点击坐标替换旧图钉，并通过 `role="status"` 提示已更新；不同层级允许共存，例如“中国”“浙江”“杭州”可以同时存在。区、县、街道和街区不得成为地图 pin。
- 聊天中的明确城市名称使用版本化页面城市目录识别；命中后创建同样的会话内图钉，地球移动到该城市，且不得把文本命中提升为旅行事实。若聊天命中已有城市，必须保持聊天框打开并只把地球转到现有图钉，不重复显示手动地图点击使用的“已标记”提示。拉丁字母城市名必须保留专名大小写，避免把普通词误判成地点。
- 首条聊天消息创建的 `DRAFT` Trip 与默认私有 thread 成功返回后，聊天框显示 Trip Planner 跳转入口；链接必须使用该响应中的 Trip ID 和 thread ID。跳转后的工作台加载同一 thread 的既有消息，且不得创建第二个 Trip 或 thread。
- 多个私有灵感在缩放和移动地图时保持绑定各自归一后的经纬坐标；管理器默认不打开、不预选标记，单独删除只移除目标标记，批量删除只移除已勾选标记。
- `Within 50 km` 明确表示以所选图钉为中心的 50 km 半径，不得把距离范围伪装为城市边界。离线位置参考仅能来自版本化、来源化的专用 resolver；不得从地图 tile、地图标签、Natural Earth SVG overlay 或模型推断。
- 原型刷新后临时标记消失；生产实现必须将任何持久化操作交由服务端授权模型处理。
- 国家、省/州、城市名称按与点击粒度相同的 zoom band 分层显示。点击名称或其周边地图区域都创建该层级的会话内私有灵感，不会创建共享约束、方案、价格、库存、签证或预订结论。
- 如果配置的 style 缺少兼容的 OpenMapTiles source 或缺失任一必需图层，地图保留原有候选入口和故障回退；不报错或伪造地图数据。开发者可在 dev 模式下通过 `window.__wanderlyMap.readiness` 观察 5 种 readiness（loading / ready-supported / ready-style-unsupported-source / ready-style-missing-layers / unavailable-network）。
- 地图就绪生命周期分两阶段（mounting → ready）：MapLibre 6.6 的 globe projection 必须写入传给 `new Map()` 的 style JSON，`style.load` 是 style 兼容性检查的唯一就绪前置；不得在 style 创建前或 `style.load` 后调用 `setProjection()`。OpenMapTiles 的 `sourcedata` 只作为开发诊断，慢 TileJSON 或 PBF 不得触发 `unavailable-network`。只有 style 总超时、初始化异常或 style ready 前的 map error 才显示 globe error 回退。dev 模式下 `window.__wanderlyMap.stage` 实时反映当前阶段。
- 地图 ready 后，国家边界位于 provider style stack 顶层：即使 Liberty 的 fill/road layer 重排，全球缩放仍可看到本地 Natural Earth 共享 mesh 与独立九段线。国家边界和地理标签默认保持显示；zoom 2.6 起显示首都、zoom 2.8 起显示重要城市、zoom 4.2 起显示省州名称。SVG 标签必须在 MapLibre `render` 帧内同步重投影并随 resize 更新，平移或缩放时不得落后 WebGL 地球（标签位置只能直接写入 DOM，不得经由 React state 提交，否则会慢一帧并出现漂移）；必须剔除背半球并进行屏幕碰撞去重；已离开候选集但尚未卸载的标签节点必须当帧隐藏，不得停留在过期位置。视觉边界和标签不参与地点匹配、反向地理编码或旅行事实；位置参考只能使用专用、版本化的离线 resolver 数据。
- 国界构建必须仅在构建期读取 Natural Earth 10m，并从同一个 TopoJSON topology 输出三档共享 mesh；同一时刻前端只绘制当前 zoom 的一档，任意共享边界只出现一次。首屏只请求 LOD-0 与本地九段线，LOD-0 gzip 不得超过 200 KB；LOD-1/2 仅在进入对应 zoom 后请求。浏览器与 `build-geography-labels.mjs` 对 `geo.datav.aliyun.com` 的请求必须为 0。每一档必须在 MapLibre `render` 帧内同步更新、在半球边缘裁剪相交线段并随 resize 更新，旋转时不得落后 WebGL 地球或因顶点跨越背面而抖动。获取失败应保留既有地图和无障碍地点入口。
- 地球表面必须保持实体不透明：默认首屏可渐进加载 GEBCO `GEBCO_LATEST` WMS 的陆地与海底地势，但在其返回前 Natural Earth 与实色水面必须持续可见，不得出现白色、透明或方块状缺失地表。GEBCO source 必须使用 1024 逻辑 tile size 与相应的低一级 source minzoom，以限制公共 WMS 的并发请求且不阻塞默认 globe。zoom 更高时继续保留最后可用层级而非淡出为蓝底。GEBCO 未返回或失败时，Natural Earth 必须持续可见（包括高 zoom 的 overzoom）且不阻塞缩放。道路、标签和行政边界仍需在 relief 之上可读。必须显示 GEBCO attribution 与”不用于航海”限制；不得将地势像素解释成路线、天气、价格、签证或安全结论。
- 本地 SVG 国界、九段线与地名覆盖层必须按当前 MapLibre globe 的屏幕地平线轮廓裁剪，不能只按页面矩形裁剪。旋转、缩放、跨日期变更线或高纬度视图下，任何边界、九段线、文字或标记均不得显示在球体轮廓之外，或让背半球内容穿透到前景。地名必须在锚点接近地平线、或整个文字包围框不能留在球内时隐藏；若无法计算有效轮廓则 fail-closed 隐藏 SVG 覆盖层。裁剪路径与位置必须在 `render` 帧内更新，不能通过 React state 造成一帧滞后。

### TS-P2-LIC — Serve a shared cached introduction for a stable map location

**Stories:** S4, P1
**Objective:** Verify that a stable map location receives one non-personalized, locale-scoped introduction without widening the Explore lifecycle, leaking private context, or duplicating concurrent LLM calls.

**Starting conditions:** API and PostgreSQL are running; the server versioned location-introduction catalog contains `tokyo`; a fake ModelGateway is installed and records calls; no cache row exists for `tokyo` and `zh`.

**Steps:**

1. From an anonymous browser session, select the catalogued Tokyo location in Explore and call `POST /api/v1/explore/location-introductions` with `{ "sourceId": "tokyo", "locale": "zh" }`.
2. Repeat the request from a different anonymous session before the 7-day expiry. Inspect the ModelGateway fake call count and both response bodies.
3. Create 20 concurrent requests for the same missing key. Hold the fake model response until all requests have reached the service, then release it and poll all `202 GENERATING` responses.
4. Advance time beyond `expires_at` and repeat the request. Then force the model to return timeout, schema-invalid and policy-disallowed content on separate expired keys.
5. Request unsupported source IDs, arbitrary names/coordinates, and an `INSPIRATION` pin. Exceed the introduction endpoint's independent per-IP rate limit.
6. In the browser, select a stable location, then close the drawer or select another location while the original request is generating. Inspect `shared_trips`, `chat_threads`, `chat_messages`, `agent_task_runs`, `audit_events`, traces, logs and metric labels.

**Expected outcomes:**

- Step 1 returns `200 READY` with `cacheStatus: "MISS"`; the map drawer renders the text directly and neither opens chat nor creates a Trip, thread, message, task, consent, snapshot or user audit event.
- Step 2 returns `200 READY` with `cacheStatus: "HIT"`, identical content and expiry; the fake model was called exactly once. Cache entries are keyed by canonical source ID, locale and content version, so `en` is a separate entry.
- Step 3 produces exactly one lease owner/model call. Other requests return `202 GENERATING` with bounded retry guidance and eventually receive the same `READY` content; no transaction remains open while the model is awaited.
- Step 4 atomically regenerates once after expiry. Timeout, provider/network failure, schema failure or policy failure returns `503 LOCATION_INTRODUCTION_UNAVAILABLE`, releases the lease, and does not expose or cache partial/error content.
- Step 5 returns `400 LOCATION_INTRODUCTION_UNSUPPORTED_PLACE` for unrecognised entries and `429 LOCATION_INTRODUCTION_RATE_LIMITED` after the configured limit. Unsupported and inspiration selections do not invoke the model.
- Step 6 aborts only client observation. A valid server-side lease may finish and populate the public cache, but no user-specific business data is written. Logs, audit, metric labels and spans contain no source ID, name, coordinate, cache key, prompt, generated content, user, Trip or thread context.
- Generated content contains no current prices, inventory, visa/entry decision, weather, operating hours, booking, legal or safety claim. The UI does not display an AI badge or generation timestamp.

### TS-P2-LR — Resolve coordinates through the three source modes

**Stories:** P1
**Objective:** Verify the `LOCATION_REFERENCE_MODE` source abstraction keeps the public route, internal caller, rate limit, and metric contract identical across `in-process`, `sidecar`, and `disabled` modes. See `apps/api/src/location-reference/SIDECAR.md` for the full failure-mode matrix.

**Starting conditions:** API is running locally; Postgres is up; `apps/api/data/location-reference/` data is versioned.

**Steps:**

1. With `LOCATION_REFERENCE_MODE` unset (default `in-process`), POST `{ “latitude”: 38.7223, “longitude”: -9.1393 }` to `/api/v1/explore/location-reference`. Record the full response body.
2. Stop the API. Start the sidecar via `docker compose --profile location-reference up -d` and restart the API with `LOCATION_REFERENCE_MODE=sidecar LOCATION_REFERENCE_SIDECAR_URL=http://127.0.0.1:3002`. Repeat the same POST.
3. Restart the API with `LOCATION_REFERENCE_MODE=disabled`. Repeat the same POST.
4. In each mode, fire 31 rapid POSTs from the same client IP and confirm the 31st returns `429 LOCATION_REFERENCE_RATE_LIMITED`.
5. With `LOCATION_REFERENCE_MODE=sidecar`, stop the sidecar container and POST again. Then with `LOCATION_REFERENCE_MODE=sidecar` but a stale URL, POST again.
6. With `LOCATION_REFERENCE_MODE=sidecar` and the sidecar down, POST a conversation turn with a `place` field (e.g. via `apps/web` explore chat) and observe `place.sourceType`.

**Expected outcomes:**

- Steps 1 and 2 produce **byte-identical** JSON for the same coordinates; `disabled` (step 3) returns `{ “outcome”: “NO_REFERENCE”, “datasetVersion”: “disabled”, ... }` with the rest of the discriminated union intact.
- Step 4: rate limit is honored in all three modes; the `429` body and `location_reference_requests_total{outcome=”rate_limited”}` label are unchanged.
- Step 5: sidecar HTTP 5xx / timeout / connection-refused all return `503 LOCATION_REFERENCE_UNAVAILABLE` with `outcome=”unavailable”`. Schema drift (sidecar returns `{“wrong”:”shape”}`) also returns `503`, never silently fabricates a result.
- Step 6: the conversation turn returns `202`; the persisted `place` has `sourceType: “INSPIRATION”`, not `500`. The conversation-safety `resolveConversationPlace` soft-degrades and never throws to the caller.
- The sidecar container's `/health` reports `{ status: “ok”, dataLoaded: true }` after the 70 MB GeoJSON warm-up completes; `GET /api/v1/explore/location-reference` rate-limit metrics never double-count (the sidecar does not rate-limit).
- Switching modes does not require code changes; flipping `LOCATION_REFERENCE_MODE` is sufficient. The default `in-process` mode is what production deploys inherit with zero configuration change.

### TS-S1 — Protect data and trace the Agentic workflow

**Stories:** S1  
**Objective:** Verify profile privacy, event traceability and safe telemetry.

**Starting conditions:** Two profiles, one shared trip and a completed sandbox flow exist.

**Steps:**

1. Attempt cross-user reads/writes of unshared Profile and private conversation threads.
2. Inspect timeline for profile edit, consent, a completed/stopped/failed chat turn, tool calls, visa, re-plan, approval and sandbox call.
3. Inspect logs, traces and metrics by correlation ID.
4. Search telemetry for private conversation text, document numbers, payment data and unapproved Profile values.
5. Attempt to emit user/trip/plan/booking/correlation/request identifiers and a
   free-form model/error message as metric labels.
6. Attempt audit summaries containing depth greater than three, raw payloads,
   secrets, functions, class instances, `Buffer`, `Date`, cycles and custom prototypes.

**Expected outcomes:**

- Cross-user access to Profile and private conversation threads is denied.
- Timeline has versions and correlation IDs for every sensitive decision.
- Metrics show required low-cardinality outcomes and trace errors safely.
- Prohibited data does not appear in telemetry.
- Metrics accept only their documented bounded dimensions; high-cardinality or
  free-form labels are rejected before emission.
- Audit summaries preserve valid finite primitives, `null`, arrays and plain
  nested objects through depth three, and explicitly reject unsafe shapes.

### TS-S1b — Stream only safe planning and replan progress

**Stories:** H3, H5, S1
**Objective:** Verify planning/replan uses the shared streaming platform without exposing internal reasoning or unverified state.

**Starting conditions:** An authorized trip has an active snapshot; one replan trigger and one consent-revocation trigger are available.

**Steps:**

1. Start planning and capture all stream events through final plan activation.
2. Trigger replan and verify progress events reference the active run/version while the old plan remains authoritative until replacement is validated.
3. Revoke consent while a replan is running, then inspect emitted terminal state and persisted plans.
4. Search client payloads, audit, logs and traces for raw snapshot fields, tool payloads, chain-of-thought and unvalidated plan candidates.

**Expected outcomes:**

- The client receives only documented safe phases and an identifier/version-safe terminal result; it never receives model reasoning, prompt, raw provider payload or unvalidated plan content.
- A final `COMPLETED` event refers only to an already validated and persisted plan version; a final `COMPLETED_WITH_GAPS` event refers only to an already persisted safe research summary and carries no commercial authority.
- The API and Web task-status contracts accept `COMPLETED_WITH_GAPS`; a durable planning run in that state remains readable and the Web fetches its persisted plan instead of presenting a response-schema error.
- `COMPLETED_WITH_GAPS` never reuses the `COMPLETED` status line. Such a run produced no plan, so the Shared surface must not read "Plan is ready" above an empty list; it names the missing-data outcome instead.
- The gaps explanation renders from the run alone. The research row supplies *which* capabilities were missing, so a slow or absent research read degrades the panel to its summary line rather than falling back to a status bar over an empty surface.
- After the proposal is adopted, the Web accepts and renders a grounded flight plan even when optional stay or ground evidence is absent; the missing capabilities remain explicit gaps and are never populated with fixtures.
- Consent revocation or a newer run makes the old stream terminal/stale; it cannot activate, display or overwrite a plan after invalidation.
- Stream identifiers remain out of metric labels, and no event widens membership or snapshot authorization.

### TS-S2 — Recover from missing, conflicting and uncertain information

**Stories:** S2  
**Objective:** Ensure the Agent makes uncertainty actionable instead of giving confident fiction.

**Starting conditions:** Missing Profile, conflicting budget/date, tool failure and uncertain visa fixture exist.

**Steps:**

1. Join a trip without a Profile or consent.
2. Enter conflicting budgets/dates.
3. Trigger Flight tool failure.
4. Trigger uncertain visa rule source.
5. Try to confirm/orchestrate from each error state.

**Expected outcomes:**

- System requests specific trip data or consent and names affected members.
- Conflicts point to editable fields rather than silently choosing a winner.
- Tool and visa uncertainty are visible with official verification/fallback boundaries.
- No error path creates confirmation, orchestration, payment or booking.

## 发布回归检查清单

后端集成测试通过 `TEST_DATABASE_URL` 使用隔离数据库。测试运行器只接受
loopback 主机，并要求数据库名或 `search_path` schema 以 `_test` 结尾；默认使用
`travelagent_test` schema。任何会删除数据库记录的测试都必须保留这层守卫，不能
直接指向日常开发或共享数据库。

### Frontend Slice 回归

- 自定义账号模式的登录只接受用户名；勾选“30天内记住我”后 token 上限为 30 天并使用持久存储，未勾选时只使用 session storage。当前本地和线上 demo 均采用 `PASSWORD_RESET_MODE=direct`：输入邮箱后直接设置两次一致的新密码；该模式未验证邮箱所有权，是 demo 阶段明确接受的风险，接入真实用户前必须替换。切换为 `email-code` 后恢复六位验证码、60 秒重发、10 分钟过期和最多五次失败的流程。成功页面可立即返回登录，并在 5 秒后自动返回。生产邮件只经配置好的 AWS SES 发送，日志不得包含邮箱、验证码、reset token 或密码。
- 前端不提供 Demo 身份选择，也不允许客户端提交用户 ID；身份只能来自正常 Cognito 登录会话，或仅在 loopback `custom-local` 模式来自 API 验证的本地用户名/密码会话。
- fixture 与 HTTP 模式使用同一组 Zod 合同；不符合合同的 Profile、Trip 或 error 响应必须进入显式错误状态。
- 所有受保护的 HTTP 请求在 Cognito 模式通过 AWS Amplify session 读取当前 access token；`custom-local` 仅在 loopback 开发环境从受控浏览器会话读取 API JWT。无 session 时不发送 Authorization，token 刷新后使用新 token；登录会话变化或退出时必须替换 TanStack Query client，使旧私有缓存不可见且活跃查询以新会话重新执行。`POST /api/v1/explore/location-reference` 与稳定地点专用的 `POST /api/v1/explore/location-introductions` 是仅有的匿名、限流 Explore 例外；后者只写非个性化共享缓存，不写用户业务状态。应用自身不得把 Cognito token 复制到 localStorage。
- `AUTH_MODE` 默认必须为 `cognito`。显式 `local-dev`（固定单用户）和 `custom-local`（数据库用户名/密码、多用户）仅允许 `NODE_ENV=development|test`。`local-dev` 必须 loopback server、loopback socket 客户端及精确 loopback HTTP Origin；`custom-local` 还必须有至少 32 字符的 API `JWT_SECRET`，且仅可为短期可信内网测试使用精确 RFC1918 IPv4 server host 与 Origin（公网、tunnel、HTTPS、路径或宽泛网段均须拒绝）。production、staging、缺失环境或其他非 loopback/non-private 边界必须拒绝启动/请求。浏览器不能发送 fake token/user ID；`local-dev` 的固定身份和 `custom-local` 的已验证 JWT 身份都须通过原 owner-only thread 授权。非允许 Origin 不得获得 CORS 读权限，且对受保护写操作必须返回 `403` 并不创建业务状态；允许 Origin 的 `OPTIONS` 预检必须返回 `204`、正确的 CORS header、包含目标写方法（包括 `PATCH`）的 allow-methods 和可解析的 `traceparent`，且不触发认证。
- Home 覆盖 Profile/Trip 的 loading、empty、error、unauthorized 与 `Demo data` 状态，不混入其他用户数据或未确认的 plan/action 字段。
- 未登录的 Home 会阻止 Profile 与 Trip 私人查询，并在两个区域显示“请先登录”及登录入口；服务不可达提示只在已认证会话的读取失败时显示。
- Profile nullable 字段映射为空表单值；PUT 只提交已修改的可写非空字段，不包含只读字段，失败时保留输入。
- Explore Map 选择已知演示目的地时只提交服务端规范的 fixture `sourceId`、名称与 `[longitude, latitude]`；动态灵感点和地理搜索结果必须标记为 `INSPIRATION`，浏览器不得提交 `role`、`senderUserId` 或伪造受信任来源。
- Explore 私聊首次提问通过幂等 start 命令创建当前用户的 Draft Trip 与默认 private thread，后续提问复用该 thread；站内路由切换只从内存探索会话恢复 owner-only history，整页刷新或新标签页不恢复 thread 指针，也不在浏览器持久化消息正文。
- 每个新 turn 使用新的 UUID `requestId`；acceptance 网络结果不确定时必须复用原 request ID，发送期间禁止并发重复提交。接受成功后 UI 以 durable run status 为准，SSE 断线只降级为轮询；Worker 自动处理受控网络/5xx 重试。最终 `MODEL` 正常展示，terminal provider/model failure 保留 USER、不得持久化 partial ASSISTANT 或伪造 fallback。
  **已知缺口（202/SSE 切换引入）**：`SAFE_REFUSAL` 的核验提示当前不显示。旧的同步响应会返回 `responseMode`，acceptance 响应不再包含它，而 `responseMode` 目前只写入 idempotency `resultPayload` 与 audit summary，既不在 `chat_messages` 上，也不在 `AgentRunResponse` 或 `turn.completed` 事件中。恢复该提示需要先扩展契约，与后续的签证/拒答呈现设计一并处理。
- 浏览器聊天请求在 Cognito 模式必须使用真实 Cognito access token；没有可用登录 token provider 时，三人真实 API 端到端演示属于显式阻塞项，不得硬编码 token 或退回 demo identity。`local-dev` 仅覆盖一个服务端固定身份的单人 smoke test；本地三用户隔离验收可使用 `custom-local` 的独立数据库账户，登录后必须确认 A 无法读取 B 的 Trip、私有 thread 与消息，且切换账号会清空前一账号的查询缓存。
- 375px、768px、1024px、1440px 下身份、导航、主要操作与私密提示均可见，交互目标至少 44px，并尊重 reduced motion。

### 数据库与 Seed 回归

- `npm run db:migrate` 至少连续运行两次幂等：第二次必须报"schema already up to date"且不产生未应用 migration。
- `npm run db:seed` 至少连续运行两次幂等：第二次必须成功，**不**重复插入 `users` 或 `user_profiles` 行；调用方已通过 API 修改过的 Profile 必须被保留（seed 不覆盖）。
- 新增 unique 索引 `user_profiles(user_id)`、`trip_members(trip_id,user_id)`、`constraint_snapshots(trip_id,version)`、`itinerary_plans(trip_id,version)`、`member_confirmations(plan_id,user_id)`、`booking_executions(orchestration_request_id)` 在生产部署前必须先走数据预去重（见 `apps/api/migrations/0005_hardening_constraints.sql` 注释与 `docs/mvp-readiness-review.md`）。
- `audit_events.correlation_id` 上存在索引；按 correlation id 查询审计链的 EXPLAIN 不应触发顺序扫描。
- **TS-MIG-0005-replay**：连续跑两次 `npm run db:migrate` 后，`enum_range(NULL::audit_action)` 必须包含 `apps/api/src/db/schema.ts:18-28` 列出的所有值，包括 `VISA_CHECK` 与 `PLAN_RESTART`；断言方式为尝试 `recordAudit({ action: "VISA_CHECK", ctx, summary: {} })` 不抛 `invalid input value for enum`。
- **TS-MIG-0008-legacy-system**：在 develop 的 `0007_remove_demo_provider_state.sql` 之后，从允许浏览器以认证用户身份写入 `USER | SYSTEM` 的 pre-0008 状态开始，迁移必须原地将 `SYSTEM` 规范化为 `USER`，保留消息 ID、thread、sender、正文、脱敏摘要、分享标记和时间戳；随后强制 `USER/non-null sender` 与 `ASSISTANT/null sender`，且再次运行迁移无新增变更。
- **TS-MIG-0032-email-invitation-replay**：当目标 schema 已具备 `trip_invitations.recipient_email_hash` 与 `recipient_email_masked`，但迁移追踪记录需要重建时，重放 `0032_email_bound_trip_invitations.sql` 必须成功，并重建两条 pending invitation 唯一索引。
- **TS-MIG-0036-trip-scoped-conversation-task**：在已执行 `0034_personal_research_columns_and_checks.sql` 的升级库上执行 `0036_restore_trip_scoped_conversation_task_constraint.sql` 后，`CONVERSATION` task 必须接受同一可信 Trip 的 `thread_id`、`user_message_id` 与非空 `trip_id`，并拒绝缺少 `trip_id` 的写入；`PLAN`、`REPLAN`、`RESEARCH` 仍必须具备 `trip_id` 与 `snapshot_id`。随后对 `POST /api/v1/threads/:threadId/turns` 发送有效请求必须返回 `202`，而不是约束错误 `500`。

### TS-OTEL-1 — Inbound `traceparent` propagation through the request lifecycle

**Stories:** P3
**Objective:** Verify that one owner HTTP request produces a single OpenTelemetry trace from HTTP ingress through the LLM outbound call and the DB hot-spots, with `trace_id`/`span_id` bindings on every Pino log line.

**Starting conditions:** Local API + Worker dev servers, `NODE_ENV=test` so spans flush to the in-memory exporter; one test thread owned by `test-alice`.

**Steps:**

1. `app.inject("POST", "/api/v1/threads/:threadId/turns", { headers: { "traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01" }, payload: { requestId, question, ... } })`.
2. Capture the response headers — must include `traceparent` whose `trace-id` equals `aaaa…aaaa` and `span-id` differs.
3. Capture the in-memory exporter span list — must include one `http.*` span whose `http.route` is the thread path, one `db.agent_task_runs.INSERT` span, one `llm.openai.stream` span (or `llm.openai.parse` if not streamed). All three must carry the same `trace_id`; the LLM and DB spans must have `parent_span_id` matching the HTTP span's `span_id`.
4. Capture the Pino log lines for the request — every line must include both `trace_id=aaaa…aaaa` and `span_id=<matching http span id>` bindings.
5. Repeat the call without an inbound `traceparent` and confirm the server mints a fresh 32-hex trace id; the response `traceparent` echoes that id; no span in the exporter shares its `trace_id` with any prior call.
6. Send an allowed-origin `OPTIONS` CORS preflight for `PATCH /trips/:tripId/draft-brief` and confirm it returns `204` with an allow-origin header, an allow-methods header containing `PATCH`, and a parseable, freshly minted `traceparent`; it must not emit a tracing error or enter authentication.

### TS-THREAD-TRIP-1 — Trip-scoped private thread lifecycle

**Stories:** H1, S1
**Objective:** Verify that every accepted conversation is attached to an existing Trip, each member receives an owner-only default thread, and direct thread turns never create or replace a Trip.

**Starting conditions:** Alice has created a Trip; Bob is a registered user invited to that Trip.

**Steps:**

1. Create the Trip and assert the response creates only Alice's membership plus one `is_default=true` thread owned by Alice.
2. Attempt to pass `memberUserIds` to `POST /trips`; expect validation failure. Create and accept Bob's invitation concurrently; assert one membership and one Bob-owned default thread result.
3. Have Alice and Bob each list Trip threads, create an additional thread, and request conversations using the other's thread ID.
4. Remove Alice's membership after a turn is queued but before Worker completion, then process the task.
5. Directly call the thread turn endpoint without a valid owner thread and assert it cannot create or select a Trip.

**Expected outcomes:**

- Direct membership injection and non-member thread creation are rejected; invitation acceptance is idempotent.
- Each list contains only the caller's threads. Cross-owner read, write, delete, run and SSE access return `403` without message content or thread metadata.
- The removed owner cannot cause an assistant message to persist after task pickup.
- The thread turn endpoint never accepts a client `tripId` or creates/replaces a Trip; Explore initialization is covered separately by TS-EXPLORE-TRIP-1.

### TS-INVITATION-JOIN-1 — Token-bound invitation decision

**Stories:** H2, S1

**Steps:**

1. Create an active Trip invitation and open `/trips/join/:inviteToken` while signed out, then while signed in as the invited user.
2. Call invitation preview, accept and decline with a valid token; repeat with a Trip UUID substituted for the token, an expired/revoked/declined token, and a valid token while signed in as another user.
3. Accept concurrently twice, then inspect memberships, default threads and audit events. Decline a separate invitation and inspect the same records.

**Expected outcomes:**

- No trip facts render before authentication. The preview exposes only decision-critical summary fields after token and account binding; all unavailable token states return the same minimal response and disclose no trip/member/inviter metadata.
- Acceptance is idempotent and creates at most one required membership and one recipient-owned default thread. The post-success primary action is setting the sharing scope; acceptance itself grants no consent or snapshot fields.
- Decline creates no membership or thread and records `TRIP_INVITATION_DECLINE`; creator revocation remains distinct. Audit summaries contain IDs/status only, never the raw token or private profile data.

### TS-INVITATION-EMAIL-1 — Email-bound invitation without account enumeration

**Objective:** Verify that the workspace invite control creates an invitation for an email without disclosing whether an account exists.

**Starting conditions:** An active Trip has a creator and at least one existing member.

1. As creator, open `/trips/:tripId/invite`. At 375px, 768px, 1024px and 1440px widths, verify the invite form and current-member list remain within one responsive workspace, use the standard Wanderly card colors, show translated member roles, and have no horizontal overflow. Enter a valid email and create an invitation. Verify the page returns a one-time link with a seven-day expiry and explicitly says email delivery is not configured.
2. Verify no API searches users and neither request/response, audit event nor telemetry contains the raw recipient email; storage contains only HMAC and masked display data.
3. Repeat as a non-creator (expect `403`) and against an archived or cancelled Trip (expect `409 TRIP_NOT_INVITABLE`); a Draft Trip invitation must succeed and the creator control must not be disabled.
4. Open the link signed out, then sign in or register with the invited email and return to the link. Verify that only the matching email can preview, accept or decline; a different email gets the same unavailable result.

**Expected:** The creator can create an email-bound invitation without account enumeration. The recipient must still authenticate (or register) with the invited email and explicitly accept; no consent is created by creation or acceptance.

### TS-INVITATION-DRAFT-1 — Inviting into a Draft keeps the creator's private conversation private

**Stories:** H1, H2, S1
**Objective:** Verify that a `DRAFT` trip may form a team before activation, while the creator's private conversation, profile and unconfirmed exploration stay hidden from invitees; only the normal collaboration gates (`DRAFT` → `PLANNING`) still block shared planning actions.

**Starting conditions:** Alice owns a Draft Trip in `DRAFT` status; Bob has registered with `bob@example.com`; the system has configured the email-bound invitation HMAC secret.

**Steps:**

1. As Alice, open the workspace invite control. Confirm the control is enabled (not disabled) and links to `/trips/:tripId/invite` with no `DRAFT` restriction copy.
2. Submit Bob's email and create an email-bound invitation. Confirm a one-time `inviteToken` is returned with a seven-day expiry.
3. As Bob, open `/trips/join/:inviteToken`. Confirm the preview shows `{ trip.name, status: "DRAFT", destinationCandidates: [], travelDateStart: null, travelDateEnd: null, expiresAt }` and explicitly states that joining grants only a blank private thread.
4. Accept the invitation as Bob. Confirm Bob is added as a required `MEMBER`, his own blank default `TRIP` thread is provisioned, and Bob's `GET /threads/:creatorThreadId/conversation` returns `403`.
5. As Alice, complete the Draft brief via `PATCH /trips/:tripId/draft-brief` (departures, destinations, dates) and then `POST /trips/:tripId/activate` to transition to `PLANNING`.
6. As a separate flow, create a Draft Trip, cancel it, then attempt to create another invitation; expect `409 TRIP_NOT_INVITABLE`. Bob's pending token against a cancelled trip must return `409 TRIP_NOT_INVITABLE` on accept.

**Expected outcomes:**

- Draft invitations create exactly one membership row and one recipient-owned default thread; the creator's existing thread remains invisible to the invitee (`403`).
- Cancelled or archived trips reject both `POST /trips/:tripId/invitations` and `POST /trip-invitations/:inviteToken/accept` with `409 TRIP_NOT_INVITABLE`. Audit events continue to record only IDs and status, never raw emails or token text.
- After the creator activates the brief, the team enters the existing PLANNING collaboration flow without re-issuing invitations; Bob's previously accepted membership continues to count as a required member for activation rules.

### TS-EXPLORE-TRIP-1 — Create a Draft Trip only on first submitted exploration message

**Stories:** H1a, H1, S1
**Objective:** Verify Explore creates no empty archive records, creates exactly one owner-only Draft Trip when the user first sends a message, and preserves the agreed browser lifecycle.

**Starting conditions:** Alice is authenticated and has zero or more historical Trip records; API exposes the exploration start endpoint and the normal durable conversation endpoint.

**Steps:**

1. Open `/home`, browse the map, click several locations, open and close chat, then inspect `shared_trips`, `chat_threads`, idempotency and audit rows.
2. Submit the first message. Force a client retry, a double-click and two concurrent start requests with the same start request ID; then accept the first conversation turn.
3. Simulate start success followed by turn rejection/network loss; retry the start and the conversation command.
4. Navigate client-side `/home → /projects → /profile → /home`; submit another message. From the Draft workspace, open the mini-globe or full-map control, then open the Home chat history and continue the same thread; return through the Home Trip Planner link. Then perform a full browser reload and open bare `/home` in a new tab before submitting messages there.
5. Open the Draft from `/projects`; verify it uses the same project workspace as a `PLANNING` trip, retains the private thread, and does not show a separate brief form. Confirm a complete brief in the private conversation, then use the workspace activation control.
6. Attempt invitation, consent, planning, confirmation and booking both before and after activation.
7. Repeat with Alice logged out and Bob logged in before returning to `/home`.

**Expected outcomes:**

- Before the first submitted message, no Trip, thread, idempotency or audit row is created; map input is not persisted as a business fact.
- One start request ID yields exactly one `DRAFT` Trip, one creator membership and one owner-only default `TRIP` thread, even under concurrent retry. The browser must accept the `201`/`200` response with `trip.status = DRAFT`, then submit the first turn to `POST /api/v1/threads/:threadId/turns` and receive `202`. Audit summaries contain IDs/status only, never the question or map data.
- The first task derives the created thread's `trip_id`; start success plus turn failure/retry cannot create another Trip.
- Client-side route changes preserve the same in-memory Trip/thread. Reloads, new tabs and post-logout sessions have no old in-memory context and create a distinct Trip only upon their first submitted message.
- The explicit Trip Workspace → Home map handoff carries the current Trip/thread IDs but is not authorization: Home must re-query the caller's own Trip threads before rendering the history or accepting a turn. A matching, authorized handoff shows the same private messages in Home and Trip Planner and returns to the same `?thread=` route; missing, malformed, cross-Trip or unauthorized IDs show no prior messages and never create a replacement Trip/thread.
- An unarchived, non-expired `DRAFT` owned by the authenticated member appears in the default `/projects` active list immediately after its creation, contributes to the active count, and is labelled as a draft needing completion. A Draft explicitly archived by the user, or one whose end date has elapsed, is excluded from that default list.
- `Start new exploration` does not delete, archive or mutate the old Trip. Historical Trips are restored only through an explicit project route.
- Draft commands for consent, snapshot/planning/replan, confirmation and booking return `409 TRIP_NOT_ACTIVE` without side effects. Draft invitation creation and acceptance are explicitly allowed: the creator can copy an email-bound invitation link, the invitee sees a minimal summary (trip name, `DRAFT` status, expiry and "joining grants only a blank private thread"), and accepting adds the invitee as a member while still hiding the creator's private conversation. Cancelled or archived trips reject both new invitations and acceptance with `409 TRIP_NOT_INVITABLE`. A Draft opens the same workspace as a `PLANNING` trip; only its creator sees the workspace activation control and the creator-authored draft brief editor, both of which are required to reach `PLANNING`. A creator's valid explicit activation changes status to `PLANNING`, after which the normal collaboration path works.

### TS-EXPLORE-TRIP-1a — Create a Draft directly from My program and resize the planning workspace

**Objective:** Verify the My program entry point creates one idempotent Draft Trip and opens its workspace directly. On desktop, the workspace order is thread list → trip/planning panel → Agent, and users can resize both boundaries without changing Trip state.

**Steps:**

1. From `/projects`, select **New trip** once; simulate a delayed response and repeat only after an error.
2. Verify the resulting route is `/trips/:tripId?thread=:threadId`, the Trip is `DRAFT`, and the creator sees the bounded brief/activation controls in the right inspector.
3. On a desktop-width viewport, verify the thread list is on the left, trip overview/Shared planning is in the centre, and Agent conversation is on the right.
4. Drag both vertical dividers and repeat with keyboard Left/Right arrows on each divider. Verify the thread rail can shrink to its bounded minimum and the planning panel can grow while keeping a usable Agent pane.
5. Narrow the viewport below the desktop breakpoint and verify the existing inspector drawer remains usable.

**Expected outcomes:**

- New trip uses the existing idempotent exploration-start command; it never creates a second Trip after a response retry and never routes the user through the map merely to reach the Draft workspace.
- Resizing changes only local layout. It neither writes browser-persisted business state nor changes the Trip, snapshot, preference, task or plan. The desktop bounds preserve a minimum usable width for all three panes.
- Mobile/tablet keeps the existing explicit inspector open/close behavior.

### TS-EXPLORE-TRIP-1b — Report the private thread's real state, and only that

**Stories:** H1a, H1
**Objective:** Verify the chat's thread banner describes what is actually happening. Because Explore provisions its thread lazily, "no thread yet" is a resting state and must not be reported as work in progress; the Trip workspace, which is always on its way to a thread, must still report the wait.

**Starting conditions:** Alice is authenticated. The exploration start endpoint and the Trip threads endpoint can each be held in flight and failed on demand.

**Steps:**

1. Open `/home` and, without sending anything, browse the map, open and close the chat panel, and inspect both the collapsed composer and the expanded conversation panel.
2. Submit the first message while holding the start response, then release it successfully.
3. Repeat step 2 but fail the start response.
4. Open a Trip workspace at `/trips/:tripId?thread=:threadId` while holding the threads response, then release it.
5. Fail the threads response for the same workspace.

**Expected outcomes:**

- Before the first submitted message, no thread banner is rendered on either the collapsed or the expanded Explore surface, and the composer stays enabled. The absence is the point: nothing is being prepared, so nothing may claim to be.
- While the start request is in flight, "Preparing your private chat…" is shown; it disappears when the thread becomes available.
- A failed start shows "Private chat is unavailable." with a working Retry, and Retry reuses the original start request ID.
- In the Trip workspace the preparing banner is shown for the whole wait — list fetch and default-thread auto-provisioning alike — and clears once a thread is active. This surface never renders the idle state, because it never rests without a thread.
- A failed threads fetch stops the workspace claiming a thread is coming; the thread rail remains the place the failure is reported in full, and the banner is not duplicated as a second error.

### TS-EXPLORE-TRIP-2 — Derive a trip title from explicit brief fields

**Stories:** H1, H2
**Objective:** Verify title generation is deterministic, localized and, on this path, independent of private conversation text. The country/region label path and the owner-triggered model path are covered by TS-EXPLORE-TRIP-2b.

**Starting conditions:** Alice owns a Draft Trip and has sent private messages containing destinations or dates that differ from the explicit activation brief.

**Steps:**

1. Activate with two destinations, `2026-10-01` through `2026-10-07`, and `titleLocale: en`.
2. Activate another Draft with a Chinese locale and destinations but no complete date range.
3. Submit an invalid or reverse date range.
4. As Bob, attempt `PATCH /trips/:tripId/title`; then rename as Alice and inspect audit data.
5. Activate with `travelDateStart` and `travelDays` only (no `travelDateEnd`) — both English and Chinese locales.
6. With the UI in Chinese, confirm a brief proposal card and then start shared planning **from the Trip workspace**, not from Explore.

**Expected outcomes:**

- The first title is `Tokyo · Bangkok Trip Planner｜7 Days`; the Chinese title uses `行程规划` and no day suffix when dates are incomplete.
- The `travelDays`-only activation derives `travelDateEnd` from `travelDateStart + travelDays - 1` and the resulting title carries the day suffix (`｜3 Days` / `｜3天`).
- Both surfaces that can write a title — Explore and the Trip workspace — send the reader's own locale, so a Chinese session never produces a half-English title such as `新加坡 Trip Planner｜4 Days`. The client prop defaults to `en`, so this is asserted per call site rather than assumed.
- On this path the title never reflects private chat text, profiles or inferred facts, and no LLM call is made. `PATCH /trips/:tripId/title` never reads chat history or calls a model under any circumstance.
- A trip with no destination label behaves byte-for-byte as before the label column was introduced.
- Invalid calendar dates and reverse ranges are rejected; no title is fabricated from them.
- Only the creator may manually rename. The change sets `name_source=MANUAL`; the audit event records the source but never title text.
- Bob cannot submit through, view, or restore Alice's old session identifiers.

### TS-EXPLORE-TRIP-2b — Name a trip from a country, and disambiguate same-name cities

**Stories:** H1, H2
**Objective:** Verify a country-level intent produces an informative title without ever becoming a planner destination, that same-name cities resolve by population dominance, and that every model-path failure leaves the stored title untouched.
**Contract:** [Trip 标题目的地标签实施规范](trip-title-destination-label-implementation.md)

**Starting conditions:** Alice owns a Draft Trip with an empty brief, UI language Chinese.

**Steps:**

1. Send "我想去法国" in the private thread.
2. Inspect the trip row and the trip list card.
3. Submit `巴黎` through the brief confirmation card; then submit `Valencia` on another Draft.
4. Rename the trip manually, then send another country mention.
5. On a Draft whose deterministic path found nothing, trigger `POST /trips/:tripId/title/suggest`; repeat it past the per-user quota.
6. Force the gateway to time out, and separately force it to return free text rather than a resolvable place name.
7. While a suggest call is in flight, rename the trip from another tab.
8. As Bob, open the invitation preview for Alice's Draft trip.

**Expected outcomes:**

- The title becomes `法国行程规划`, while `destinationCandidates` stays `[]`. The label never reaches the planner, a provider query, or a `constraint_snapshot`.
- Because the brief still has no city, the trip card shows a destination-pending marker and the assistant asks for a specific city — on the chat-text path, not only on map selection.
- `巴黎` resolves to Paris/FR by population dominance and becomes a real destination; the title becomes `巴黎行程规划` and the label is cleared. `Valencia` stays `422 DESTINATION_UNRESOLVED` because no country dominates.
- After a manual rename, `name_source='MANUAL'` and no automatic or model path ever overwrites the title.
- Quota exhaustion returns `RATE_LIMITED` without calling the model. A gateway timeout returns `UNAVAILABLE`; unresolvable model output returns `REJECTED`. In every case the stored title and label are unchanged.
- The in-flight suggest loses to the concurrent rename and exits through `MANUAL_LOCKED`; the user's own title survives.
- The invitation preview for a Draft with `name_source='AUTO'` shows a generic localized planner name in the invitee's own language (`?locale=en|zh`, defaulting to `en`) — it discloses neither the destination label nor the confirmed destinations, matching how the same response already redacts `destinationCandidates` and dates. A `MANUAL` Draft title is preserved.
- What the model returns is validated *and canonicalised*: the stored label is always the reference dataset's own spelling, never the model's raw text. A zh caller whose model answers `France` stores `法国`; `tokyo` stores `Tokyo`.
- A Draft whose brief still has no destination city says so on both the trip card and the workspace overview, so a title naming a country never reads as a complete brief.
- `rejected` and `unavailable` are counted as themselves on `trip_title_writes_total`, not folded into `superseded`.
- No audit row, log line, metric label or span attribute contains the label text; `TRIP_TITLE_LABEL_UPDATE` carries only `{ source }`.

### TS-EXPLORE-TRIP-3 — Destination references fail closed and stay city-scoped

**Stories:** H1
**Objective:** Verify that discussion, route extraction and direct writes never persist an unresolved or non-city destination.

**Starting conditions:** Alice owns a `DRAFT` Trip. The server location-reference dataset is available and contains Shanghai and Suzhou. No destination proposal is pending.

**Steps:**

1. Send `Introduce Shanghai to me`, `Tell me about Tokyo`, and `Is Paris expensive?` in separate private turns.
2. Send `from Singapore to Shanghai` and inspect the private brief proposal card.
3. Select a country-level map reference such as `法国`, then send the accompanying private-chat turn.
4. Submit `me`, an unknown city, an ambiguous city, and `法国` directly to `PATCH /trips/:tripId/draft-brief` as Alice.
5. Submit a supported localized city spelling such as `上海` through the same endpoint.
6. Make the location-reference resolver unavailable, then send an otherwise explicit destination request.

**Expected outcomes:**

- The discussion turns create no `tripBriefProposal`, no `pendingBriefProposal`, and no destination card; assistant prose mentioning a city does not itself become a trip fact.
- A country-level selection remains exploration context: the reply asks the traveller to choose one or more cities, no save card is emitted, and no default city is inferred. A stale country-level proposal returned by an older deployment is hidden rather than rendered as an unsaveable card.
- The route proposal names server-normalized cities and appears only after both route endpoints resolve uniquely.
- Each invalid PATCH returns `422 DESTINATION_UNRESOLVED`; the existing brief, title and pending proposal remain unchanged.
- A supported localized spelling is persisted as its canonical city name. No browser label, LLM output, fixture or free-text fallback substitutes for a failed resolution.
- Resolver failure fails closed: no destination proposal is emitted and no trip fact is written. Telemetry records only the bounded resolution result, never the conversation text or city value. `trip_brief_proposal_destination_resolution_total{result}` records accepted and rejected confirmation proposals without a place label.

### TS-EXPLORE-TRIP-4 — Brief proposal dates hold together before they reach the trip

**Stories:** H1
**Objective:** Verify that a proposed travel date pair is dated from today and is internally consistent, so the confirmation card can never offer a save the write boundary must refuse.

**Starting conditions:** Alice owns a `DRAFT` Trip with no travel dates and no pending proposal. Today is a fixed, injected date (`2026-09-04`). The brief extractor and the deterministic parser both run.

**Steps:**

1. Send `我想要10月1号到10月7号去上海` — a range with no year stated — and inspect the proposal stored on the trip and the card rendered from it.
2. Repeat with `10月1号到7号`, `12月28号到1月3号`, `October 1 to October 7`, and `2026-10-01 to 2026-10-07`.
3. Force the model extractor to return `travelDateEnd` in a past year while the parser reads a future start, and inspect what is persisted.
4. Across two separate turns, settle a start date in one and let the model supply a contradicting end date in the other, so the pair is only assembled by the cross-turn merge.
5. Click the confirmation card. Then submit a pair with `travelDateEnd` before `travelDateStart` directly to `PATCH /trips/:tripId/draft-brief`.
6. Inspect a trip whose stored proposal predates this guard (an end date earlier than its start) and run `scripts/clean-incoherent-brief-proposals.ts` in dry-run, then with `--apply`.

**Expected outcomes:**

- Every range yields both ends in the year that is still ahead: `2026-10-01`/`2026-10-07`, and the New Year range crosses into `2027-01-03`. A bare month/day is never dated into a past year, and the extractor's system prompt carries the current date.
- A model end date that contradicts the parsed start is dropped before persistence; the destination and other candidates survive. The same holds when the contradiction is only visible after the cross-turn merge — the merge takes a row lock and rejects the combined pair rather than overwriting one key.
- A pair that is internally consistent but already in the past is dropped too, and no trip is silently given past travel dates or a title derived from them.
- `trip_brief_proposal_dates_total{result}` records `ok`, `end_before_start`, `in_past` or `malformed`. No date value, city or conversation text appears in the metric, the log or the trace.
- The card shows the dates it is about to save alongside the destination, and a coherent proposal saves on the first click.
- The direct PATCH returns `400 BRIEF_DATES_INVALID`; the client renders copy that tells the traveller to restate the dates, never to refresh. The existing brief, title and pending proposal are unchanged.
- The cleanup script is a dry run by default, is idempotent, strips only the incoherent date fields from stored proposals, and reports — never rewrites — confirmed trips whose travel dates are in the past.

### TS-EXPLORE-TRIP-5 — Destination cues use hybrid language classification and bounded prompting

**Stories:** H1
**Objective:** Verify that deterministic policy, current-USER-turn language classification and server resolution jointly identify a single destination interest without treating the model as write authority.

**Starting conditions:** Alice owns a `DRAFT` Trip. The server location-reference dataset is available and contains Beijing, Shanghai and Chengdu. No Destination Cue is pending.

**Steps:**

1. In separate clean states send `北京`, `北京怎么样？`, `介绍一下北京`, `我在考虑北京`, `北京有哪些酒店？` and `帮我查去北京的机票`.
2. Send `从上海飞北京`; then test a one-origin/multiple-destination flight request and a hotel comparison across several cities.
3. Send neutral lists/comparisons such as `北京、上海、南京、苏州` and `北京和上海哪个好？`.
4. Have the Assistant mention Shanghai while the USER says only `sounds good`; then test pronouns, a country, an unknown label and an ambiguous same-name city.
5. Dismiss a valid Cue and retry another automatic Cue before and after 30 minutes. Repeat until the third dismissal in the user's local day, cross the local-day boundary, and retry.
6. During both cooldown and daily mute send `把东京设为目的地`; refresh before acting and repeat the same action request.
7. Send direct exclusions (`不想去北京`, `不要安排北京`, `排除北京`) and non-direct negatives (`不是不想去北京`, `如果不去北京`, `朋友不想去北京`, `为什么有人不想去北京`). Confirm and then undo one valid exclusion.
8. Send the mixed explicit command `把上海设为目的地，北京不要去`, then make the model and location-reference resolver unavailable independently.

**Expected outcomes:**

- Every single-city interest and single-city hotel/flight destination shows one concrete canonical city. `从上海飞北京` shows only Beijing; the origin never becomes a destination candidate.
- Neutral multi-city lists/comparisons and multi-destination searches produce no ordinary Destination Cue. Assistant-only mentions, browser state and unresolved references cannot create one.
- A dismiss starts a Trip-wide 30-minute cooldown. The third dismissal in one user-local day mutes automatic Cues until that local day ends; refresh, retries, model failures and non-candidates do not increment the count.
- An explicit set command bypasses both mute layers but still requires resolver validation, user confirmation, idempotency and optimistic locking.
- Direct exclusion language produces a separate confirmation and no destination Cue. Only confirmation writes a durable exclusion; conditional, quoted, double-negative and unclear-scope language writes nothing. Undo reverses the exclusion and invalidates dependent planning state consistently.
- The mixed explicit command retains both independently confirmed actions. Model/resolver failure produces no Cue or exclusion proposal and never fails or delays the conversation reply.
- Telemetry and audit contain only safe enums, IDs and counts—never message text, city names, prompts or model rationale.

### TS-OTEL-2 — Worker continuity after durable boundary

**Stories:** P3
**Objective:** Verify that the Worker process reattaches to the originating trace by reading `agent_task_runs.trace_context` and that the `agent_task_worker.run` span is a `CONSUMER` with a `SpanLink` to the inbound HTTP span.

**Starting conditions:** Same as TS-OTEL-1; one accepted conversation turn from `test-alice`.

**Steps:**

1. After step 3 of TS-OTEL-1 finishes, trigger one `processNextAgentTask()` cycle on the Worker.
2. Capture the in-memory exporter span list on the Worker — must include `agent_task_worker.run` whose `trace_id` equals the inbound HTTP trace id from step 2 of TS-OTEL-1, with `kind=CONSUMER`, `tasks.run.id` matching the agent_task_runs row, and at least one link with `trace_id` equal to the same trace.
3. Capture the SSE event stream — first `turn.started` and `run.phase` events must carry the inbound `traceparent` in the JSON payload (server-side assert via `agentStreamEventSchema.parse`).

### TS-OTEL-3 — Forbidden span attribute enforcement

**Stories:** S1, P3
**Objective:** Verify that `safeSetAttribute` rejects every key in `FORBIDDEN_SPAN_ATTRIBUTE_KEYS` and that no production source file calls `safeSetAttribute` with a forbidden key.

**Starting conditions:** Clean checkout.

**Steps:**

1. `npx vitest run tests/spans-forbidden-attributes.test.ts` — all suites must pass. The "throws on every key in the forbidden set" suite asserts every member of `FORBIDDEN_SPAN_ATTRIBUTE_KEYS` triggers a throw. The "no production call site uses a forbidden key" suite statically scans `apps/api/src` and fails on any forbidden match.
2. Manually introduce a temporary `safeSetAttribute(span, "nationality", "DE")` in any source file under `apps/api/src/` — the static-scan suite must fail with the file path and line number reported.

### TS-OTEL-4 — Pino trace binding preserves redaction

**Stories:** S1, P3
**Objective:** Verify that adding the `trace_id`/`span_id` Pino bindings does not weaken `LOGGER_REDACTION` — passport, nationality, message bodies still appear as `[REDACTED]` while the trace binding survives.

**Starting conditions:** In-memory Pino stream for capture; `correlationChild` invoked under an active span.

**Steps:**

1. Capture a `correlationChild` log line that includes `req.body.passportNumber`, `req.body.nationality`, `req.body.prompt`.
2. Assert `trace_id` and `span_id` are present and match the active span.
3. Assert `req.body.passportNumber === "[REDACTED]"`, `req.body.nationality === "[REDACTED]"`, `req.body.prompt === "[REDACTED]"`.

### TS-UI-OBS-1 — Safe frontend action correlation

**Objective:** Verify a failed authenticated browser action can be correlated to API/Agent telemetry without collecting browser content.

**Steps:**

1. As an authenticated user, force `POST /api/v1/threads/:threadId/turns` to return 500 from the Explore screen.
2. Inspect the resulting `POST /api/v1/diagnostics/ui-events` record, local NDJSON output and Tempo trace.
3. Repeat with an offline network failure, a route render error and an unhandled rejected Promise.
4. Attempt to submit diagnostic fields named `message`, `stack`, `url`, `prompt`, `question`, a form value or an unknown key.

**Expected outcomes:**

- The diagnostic event contains only the fixed `conversation.submit` action, `explore` screen, bounded outcome/error category, bounded status/latency and validated request/correlation UUIDs.
- The log has `runtime_event.component="ui"`; the endpoint's Tempo HTTP span has safe `ui.*` enum attributes. Correlation IDs are not metric labels.
- Raw chat text, form values, URLs, error messages/stacks, profile/passport data and credentials are absent from browser payloads, logs, traces and metrics. Unknown fields return 400 before a runtime event is emitted.
- Diagnostics are authenticated, rate-limited and best-effort: an unavailable diagnostic endpoint never blocks the original action or retry. An unauthenticated sign-in failure is not sent to this endpoint.

### TS-LOG-ROTATION-1 — Daily local diagnostics retention

**Objective:** Verify local API and Worker diagnostics rotate by one configured calendar day without sharing files or retaining stale local data indefinitely.

**Steps:**

1. Set `LOCAL_DEBUG_LOG_FILE=auto` and `LOCAL_LOG_TIMEZONE=Asia/Singapore`; write one safe API event before and one after midnight in that zone.
2. Place dated API files representing the current day, six prior calendar days and an eighth-old day in `apps/api/runtime/`; start the API process.
3. Repeat with Worker files present in the same directory.

**Expected outcomes:**

- API writes `api-YYYY-MM-DD.ndjson`, Worker writes `worker-YYYY-MM-DD.ndjson`; the two processes never append to one file.
- A write after midnight switches to a new dated file without restart.
- Startup retains the newest seven calendar days for its own role and deletes only older files matching that role/date pattern. Legacy or another role's files are not deleted.
- Rotation remains a local Pino behavior and never changes redaction, prompt/private-data exclusions, OTLP export or product state.

### TS-EXTERNAL-PROVIDER-TELEMETRY-1 — Safe outbound HTTP observability

**Objective:** Verify each configured external Provider call is visible in
local diagnostics, traces and metrics without exposing request or response
content.

**Starting conditions:** Start API and Worker with local NDJSON enabled; use a
mock Nuitee, SerpApi, Amadeus, FlightAPI, OpenTripMap, openrouteservice or
Viator response with an HTTP status and a response body containing distinctive
private-looking text.

1. Run the applicable tool once with a successful provider response, then once
   with an HTTP failure and once with an aborted request.
2. Inspect the matching `external_provider_call` NDJSON records and Tempo
   trace by `trace_id`.
3. Inspect `/metrics` for `external_provider_http_calls_total` and
   `external_provider_http_latency_ms`.

**Expected:** Every actual outbound HTTP attempt has `started` and `completed`
records and an `external.provider.*` client span with only bounded provider,
operation, method, HTTP status/outcome, duration and optional response size.
Retries appear as separate attempts in the same trace. HTTP failure is
observable; aborted requests classify as `timeout`; network failures classify
as `network`. URLs, API keys, headers, guest nationality, coordinates,
request/response bodies, supplier IDs and raw error text do not appear in
logs, spans or metric labels.

- Profile memory is explicit, editable, deletable and private by default.
- Shared workspace never shows unapproved Profile/private-chat fields.
- Flight/Stay/Ground and Visa outputs use one consent snapshot and show source/time or demo label.
- Change event invalidates old plan and confirmations before replanning.
- All three required members must confirm before sandbox orchestration; no money moves.
- Missing consent, tool failure, visa uncertainty, member conflict, consent revocation and duplicate callback are tested.
# Confirmed chat brief update

### TS-FLIGHT-TOOL-1 — Durable Shared flight research and guarded plan finalization

**Stories:** H2, H3, S1
**Objective:** Verify that only the Shared PLAN/REPLAN Worker can ground a plan with live, task-bound flight evidence.

**Steps:**

1. Confirm flight search preferences, create a trip snapshot with two controlled origins and two destination candidates, then accept a `PLAN` command.
2. Drive the Worker with a deterministic model double that requests `flight.search` for every origin × destination cell and then requests final synthesis.
3. Verify each Tool request against the task snapshot, controlled airport reference and accepted preference version; inspect only normalized `provider_search_runs` and offers.
4. Repeat with an unknown Tool, malformed arguments, a wrong snapshot/destination, an `UNAVAILABLE` provider result, a changed preference version, cancellation, and a lost lease.
5. In the Shared Trip workspace, confirm bounded preferences and start planning. Refresh the page while the task is active, then verify that the latest server-owned planning run is recovered. Confirm that only an ACTIVE plan displays flight source and captured time; a failed run displays only its stable safe code.

**Expected outcomes:**

- The HTTP command returns `202` with a run ID; browser disconnect does not cancel it. Trip members can read, subscribe and cancel the run; non-members cannot. Private conversation runs remain owner-only.
- Only same-task, same-snapshot `LIVE` evidence fills a matrix cell. Wrong-task/wrong-snapshot evidence and `UNAVAILABLE` never satisfy coverage.
- The model receives only normalized Tool output. It cannot select arbitrary tools, snapshots, providers, airports, dates, passengers, cabin or currency; raw Amadeus payloads, OAuth values and private snapshot data never leave the server boundary.
- Final model synthesis and the atomic plan/task completion transaction are rejected unless the full matrix is live, the task is still `RUNNING` with its lease, and the accepted preference version is still current. Repeated or late finalization cannot activate a second plan.
- Provider/model transient failures may retry according to Worker policy. Policy, schema, preference-stale, cancellation, matrix and bounded-tool-loop failures are terminal and create no active plan.
- A forced missing-flight Tool turn omits the final-answer JSON response format because Gemini's OpenAI-compatible endpoint rejects forced function calling combined with a JSON response MIME type; auto/final turns continue to require strict JSON output.
- Stateless multi-turn Tool history returns the complete in-memory assistant message to the model so Gemini thought-signature metadata is preserved; opaque signatures are never logged, persisted or exposed in Tool results.
- SerpAPI LIVE and UNAVAILABLE outcomes are accepted by the bounded `flight_tool_invocations_total` metric; observability validation must never turn a normalized provider outcome into an `INTERNAL` task failure.
- When `flight.search` is the only registered planning Tool, completing every authoritative flight cell switches the next model turn to `tool_choice: none` so Gemini must synthesize the final strict JSON instead of repeating cached Tool calls until the turn limit.
- The completed research message uses an explicit final-plan schema instruction rather than the intermediate `serverFlightResearchProgress` JSON envelope, preventing Gemini from echoing progress as the final response; missing stay evidence still fails closed later as planning-data unavailable.
- OpenAI-compatible model responses that materialize optional plan arrays as `null` are normalized to omission at the provider boundary; required fields and supplied non-null values remain strictly validated.
- A structurally invalid final model response receives a content-free schema-path correction and is retried inside the existing bounded loop; exhaustion fails closed as `SCHEMA_PARSE`.
- Final Shared-plan evidence selections are treated as ids, rebound to complete server-owned normalized evidence, and assigned a server-derived `generatedAt`; unknown ids remain unbound and fail deterministic validation.
- The final model contract returns compact `{id}` references rather than copying full provider evidence, keeping multi-offer responses bounded while the server remains authoritative for all normalized fields.
- After the flight matrix is complete, missing required flight-origin coverage fails as `PLANNING_DATA_UNAVAILABLE`; unavailable stay evidence is normalized to `stays: []` and persisted as the Phase 4 `stay:NO_RESULTS` service gap, with no runtime fixture substitution.
- The browser never treats submitted preferences, a run ID, Tool result or plan as authoritative local state. It reloads the durable planning run and, only after completion, the server-activated plan.

- A DRAFT-trip private-chat turn may emit only an in-memory brief candidate (departure, destination, explicit date and/or duration); raw conversation content is never included in the event, audit summary, or client persistence.
- The creator must explicitly confirm the candidate. Confirmation updates the DRAFT brief and AUTO title; ignoring it performs no write. The client accumulates multiple unconfirmed turns into one review card rather than discarding earlier fields.
- A non-creator and a trip no longer in `DRAFT` receive `403` and `409` respectively; a MANUAL title remains unchanged after confirmation.

### TS-HOTEL-TOOL-1 — Snapshot-bound hotel search, comparison and safe gaps

**Stories:** H3, H5, S1
**Objective:** Verify that only the Shared PLAN/REPLAN Worker can obtain live hotel evidence and that the result is safe for comparison but never becomes a booking action.

**Steps:**

1. In a private conversation, let the model ask for missing room count, adults per room and currency. Confirm the resulting stay-search-preferences proposal as the trip owner; repeat without confirmation and with a non-member.
2. Create a snapshot with two candidates and a confirmed preference version. Drive the Worker with a model double that calls `hotel.search` once for each `destinationId`.
3. Attempt tool arguments containing dates, room count, adults, currency, price, provider, address, coordinate, URL, snapshot ID and a cross-run destination. Repeat with a missing/ambiguous `DestinationReference`, stale preference version, lost lease and duplicate tool call.
4. Return normalized LIVE offers carrying total/per-night prices and `INCLUDED`, `PARTIAL`, then `UNKNOWN` taxes/fees; inspect the plan DTO, `provider_search_runs`, `provider_offers`, source evidence and telemetry/audit output.
5. Repeat the exact query in a second run before expiry, concurrently repeat it in the same run, and repeat a transient `UNAVAILABLE` within and after the 30-second negative-cache window. Force `NOT_CONFIGURED`, `NO_RESULTS`, 429, timeout, 5xx, malformed supplier payload and expired offer outcomes. Change dates, occupancy, stay preference and consent after a live plan exists.

**Expected outcomes:**

- The model can ask only to create a user-confirmed structured preference; no private message directly writes preference, invokes supplier search or starts planning.
- `hotel.search` accepts only a current task's allowed `destinationId`; all supplier parameters are server-derived. The provider receives a complete canonical city/ISO country/coordinate reference and there is no free-text overload. SerpApi properties without coordinates or beyond the configured city radius are discarded before the 10-result cap; if nothing remains the outcome is explicit `NO_RESULTS`, never a wrong-city offer. The Tool is unavailable to Personal/Review agents and exposes no raw payload, URL, supplier credentials, rate ID, address or location coordinates.
- LIVE rows are bound to the current snapshot/run and exact normalized evidence; the validator rejects fabricated, stale, expired or cross-run hotel offers. A same-run duplicate cannot pass the database uniqueness guard. A cross-run cache hit performs no supplier request but creates a fresh current-run query/evidence ID; expired or less-than-60-second evidence is not reused.
- Exact-query LIVE results are cached for at most 15 minutes and never beyond supplier expiry. `UNAVAILABLE` is cached for 30 seconds only. Concurrent misses share a bounded database lease; a waiter that times out fails closed without issuing a duplicate supplier request. Rows expired for more than 24 hours are opportunistically removed through the expiry index. Cache rows contain only a hash, bounded state/timestamps/error code and normalized-evidence pointer—never user IDs, raw payload, URL or key.
- Every hotel card includes total price, per-night price, source, captured time and expiry. `PARTIAL` and `UNKNOWN` taxes/fees always display “可能另计”; only explicit `INCLUDED` is presented as included.
- Failure or missing data creates only a `hotel` `RESEARCH_UNAVAILABLE`/`COMPLETED_WITH_GAPS` result. Sandbox fixtures are never used at runtime; no supplier order, payment, redirect or booking link is created or persisted.
- Date, occupancy, preference, consent and offer-expiry changes stale dependent plan/confirmations and enqueue a new run. Audit, logs, metrics and traces contain no user input, price, property, supplier URL or high-cardinality identifiers.

### TS-HOTEL-PROVIDER-1 — Provider switching, run-binding, and cache isolation

**Stories:** H3, S1
**Objective:** Verify that `HOTEL_PROVIDER` switches the live adapter used by
newly accepted tasks, that an in-flight task keeps the adapter it was bound to,
and that the per-provider cache never collides. Spec:
[nuitee-serpapi-hotel-provider-switching-implementation.md](../nuitee-serpapi-hotel-provider-switching-implementation.md).

**Steps:**

1. With `HOTEL_PROVIDER=serpapi` and `SERPAPI_HOTEL_ENABLED=true`, accept a
   research task and verify `agent_task_runs.hotel_provider =
   'serpapi_google_hotels'`.
2. Change `HOTEL_PROVIDER=nuitee` (and `NUITEE_API_KEY=<sandbox>`) and roll the
   API. Accept another research task; verify the new row's
   `hotel_provider = 'nuitee_connect'` while the row from step 1 is unchanged.
3. Repeat the same `(destination, dates, occupancy)` under both providers.
   Verify the `provider_search_cache.request_fingerprint` is different and
   that no row in `provider_search_runs` ever carries both provider names
   for the same `(task, snapshot, destination)` tuple (the unique index
   `provider_search_runs_hotel_task_provider_unique` enforces this).
4. Read the boot log; confirm `[hotel] provider selection: nuitee` (or the
   `NOT_CONFIGURED` line when the key is missing).
5. Set `HOTEL_PROVIDER=disabled` and verify new tasks carry
   `hotel_provider = NULL` and `hotel.search` returns `UNAVAILABLE /
   NOT_CONFIGURED` without any HTTP probe.

**Expected outcomes:**

- New tasks persist `agent_task_runs.hotel_provider` from the env-resolved
  selection; tasks accepted before the env change are never rewritten.
- Provider-scoped cache keys never collide across providers; cache hits
  reuse only the provider that originally produced them.
- The provider selection never swaps an in-flight task's source. The
  shared planner service reads the run-bound value, not the live env.
- Boot log emits the resolved selection exactly once. Unknown values or
  missing credentials fall through to a labelled `NOT_CONFIGURED`
  selection; the API never crashes on misconfiguration.

### TS-HOTEL-PROVIDER-2 — Provider-only quote nationality authorization and redaction

**Stories:** H3, S1, S6
**Objective:** Verify that Nuitee `guestNationality` is encrypted at rest,
resolved only inside the supplier call, never echoed to the browser, and
that a grant/revoke invalidates dependent plans.

**Steps:**

1. `PUT /api/v1/trips/:tripId/stay-search-provider-authorizations` with
   `{ "provider": "nuitee_connect", "field": "guest_nationality", "value":
   "us" }`. Verify 201 with `id` and `version`; confirm the response does
   **not** echo `"us"`, `"US"`, or the encrypted payload.
2. `SELECT value_encrypted FROM stay_search_provider_authorizations WHERE
   id = …;` — confirm the column does not contain the plaintext.
3. Inspect `audit_events` for `HOTEL_PROVIDER_GRANTED`; confirm the summary
   carries `{provider, field, version}` and never the value or any PII.
4. Accept a hotel-capable research task; verify the worker invokes the
   adapter and the request body includes `guestNationality: "US"`.
5. Revoke the authorization via the DELETE endpoint and accept another
   research task; verify `hotel.search` returns
   `UNAVAILABLE / SEARCH_CONSTRAINTS_INCOMPLETE` and no supplier request is
   made (mocked fetch impl).
6. Grep logs, traces, telemetry, plan DTOs, audit summaries, and the
   `provider_search_runs` / `provider_offers` payloads for the
   nationality string. The string MUST NOT appear in any of them.

**Expected outcomes:**

- The nationality is encrypted with a server-only key. The same input
  yields a different ciphertext across processes because the local-mode
  key is derived from process-local secrets.
- The plaintext appears only inside the local variable that calls
  `NuiteeHotelProvider.searchHotels`; nothing the adapter or its callers
  return ever carries the value.
- A grant invalidates dependent ACTIVE/PROPOSED plans (`status='STALE'`,
  `stale_reason='quote_nationality_changed'`).
- A revoke performs the same stale cascade.
- The authorization endpoint returns `404` for foreign trip/member
  combinations; `422` for non-ISO-3166-1 alpha-2 input.

### TS-HOTEL-TOOL-2 — Non-price accommodation discovery and destination integrity

**Stories:** H3, H5, S1
**Objective:** Verify that OpenTripMap can provide a low-cost accommodation planning skeleton without being mistaken for live hotel pricing, and that every location provider is structurally protected from silent wrong-city results.

**Steps:**

1. Create a snapshot containing a uniquely resolvable Tokyo candidate, then call `accommodation.discover({ destinationId })` from the Shared planning Worker without confirming stay-search preferences.
2. Inspect the OpenTripMap request, normalized output, current-run evidence, cache row, research matrix, public DTO and UI attribution.
3. Repeat the exact request in a second run, concurrently repeat it in the same run, then test a 30-second negative cache, expired lease, 429, timeout, malformed payload, unnamed POI and POI beyond the configured radius.
4. Repeat with a missing destination, an ambiguous same-name destination without country disambiguation, and a destination reference missing ISO country code or coordinates. Exercise ORS place search with the resolved reference and inspect `boundary.country`.

**Expected outcomes:**

- `accommodation.discover` accepts only the snapshot `destinationId`; the server resolves a complete `DestinationReference` or returns `SEARCH_CONSTRAINTS_INCOMPLETE` without calling any provider. No fallback passes a city string into a country boundary.
- OpenTripMap is called by latitude/longitude with its documented `accomodations` taxonomy. Results include name/type/location/distance/source/captured/expiry and `© OpenStreetMap contributors`; they contain no price, availability, booking link, key, raw OSM payload or claim of bookability.
- ORS receives a real ISO-3166 country code and only a valid geocoder layer. The removed `accommodation` layer and permissive destination-ID-as-country behavior cannot recur.
- Same-task duplicates are rejected atomically. Cross-run cache hits copy evidence to a fresh `queryId` without a provider call; LIVE discovery is cached at most 24 hours and `UNAVAILABLE` for 30 seconds. A cache wait timeout fails closed rather than issuing another request.
- Missing, ambiguous, out-of-radius, quota-limited, timed-out or malformed data produces only a bounded accommodation gap and never a fabricated candidate or hotel quote.

### TS-HOTEL-PROVIDER-SWITCH-1 — Nuitee default and SerpApi task-bound switching

**Stories:** H3, H5, S1
**Objective:** Verify that Nuitee Connect / LiteAPI and SerpApi Google Hotels are selectable only by server configuration, remain isolated per task, and preserve privacy/fail-closed semantics.

**Steps:**

1. With `HOTEL_PROVIDER=nuitee`, accept a hotel-enabled task with complete preferences but no provider-only quote nationality; then grant, revoke and change its ISO nationality confirmation.
2. Inspect the Nuitee request and normalized output for one room and two rooms. Return HTTP 200 with business `error.code=2001`, 401/403, 429, 5xx, timeout and malformed schema.
3. Accept a task under `HOTEL_PROVIDER=serpapi`, then change deployment config to `nuitee` while that task runs and accept a second task. Repeat a cacheable equivalent query across providers and attempt model/browser supplied provider or nationality arguments.
4. Inspect task rows, cache keys, evidence, plan DTO, LLM context, logs, metrics, traces and audit events. Force a live plan, then revoke/change the Nuitee authorization.

**Expected outcomes:**

- New tasks persist exactly one provider; a config change affects only later tasks. Existing runs neither switch providers nor combine results, and cache/evidence from one provider never satisfies the other.
- Nuitee receives only server-derived dates, currency, city/country, occupancies and a valid provider-only nationality. It supports canonical multi-room occupancies; SerpApi multi-room requests fail before any upstream call. Neither provider can be selected by the LLM or browser.
- Nuitee 2001 becomes explicit `NO_RESULTS`; all other unavailable, malformed or unauthorized outcomes become bounded `RESEARCH_UNAVAILABLE`/`COMPLETED_WITH_GAPS`. No automatic SerpApi fallback or runtime fixture occurs.
- Nuitee `offerId`, supplier URL/raw payload, nationality and unverified tax detail never leave the server boundary. `PARTIAL`/`UNKNOWN` taxes always render “可能另计”. Authorization changes stale dependent evidence, plan and confirmations before replan.

### TS-ACTIVITIES-TOOL-1 — Durable Shared activities research and guarded plan finalization

**Stories:** H3, H5, S1
**Objective:** Verify that only the Shared PLAN/REPLAN Worker can ground a plan with live, task-bound activities evidence, and that flight + activities stages are independently schedulable.

**Steps:**

1. Confirm activity search preferences, create a trip snapshot with two controlled origins and two destination candidates, then accept a `PLAN` command.
2. Configure the task scheduler to enable both flight and activities sub-stages; drive the Worker with a deterministic model double that requests `activities.search` for every destination candidate independently of any flight call.
3. Verify each Tool request against the task snapshot, controlled destination list and accepted preference version; reject browser/model coordinates, free-text query, provider URL/session ID and a theme outside the fixed allow-list.
4. Inspect only normalized Shared `provider_search_runs` rows with `category='activity'`; assert Tool output and persistence contain neither raw MCP payload, `clickOffToLander`/booking link nor currency-less `fromPrice`.
5. Repeat with an unknown Tool, malformed arguments, a wrong snapshot/destination, an `UNAVAILABLE` provider result, a changed preference version, cancellation, a lost lease, MCP schema drift and Viator MCP 429 responses with no reset window, a <=5-second `Retry-After`, and a longer reset window. Repeat the exact request concurrently and in a second run before expiry.
6. Disable the activities sub-stage via configuration while keeping the flight sub-stage enabled; verify it does not schedule activities research. With the sub-stage enabled but unavailable, verify a safe `COMPLETED_WITH_GAPS` research result is displayed without any activity evidence or booking authority.

**Expected outcomes:**

- The HTTP command returns `202` with a run ID; browser disconnect does not cancel it.
- Only same-task, same-snapshot `LIVE` activities data becomes evidence. A same-task `UNAVAILABLE` row satisfies the required-attempt matrix but becomes a bounded service gap; wrong-task/wrong-snapshot rows and `MISSING` never satisfy coverage.
- The model receives only normalized Tool output. It cannot select arbitrary tools, snapshots, providers, destination coordinates, free-text searches, dates or themes; raw MCP payloads, session IDs, currency-less prices, click-off links and private snapshot data never leave the server boundary.
- A Viator MCP 429 retries only when the provider supplies a reset window no longer than five seconds and retry budget remains; absent or longer windows return bounded `RATE_LIMITED`. Activities and Amadeus Flight have independent credentials/configuration and failure domains.
- Same-task exact duplicates are rejected by the database guard. Cross-run LIVE and 30-second negative cache hits do not call Viator again and always create current-run `queryId`/evidence; expired/dangling cache rows miss safely, and a concurrent cache waiter never issues a duplicate provider request.
- Final atomic plan/task completion is rejected when any activities cell is `MISSING`, the task has lost its `RUNNING` lease, or the accepted preference version changed. An `UNAVAILABLE` cell persists only a safe `COMPLETED_WITH_GAPS` summary with service/candidate/reason codes; it never creates an activity offer or source evidence.
- Flight and activities evidence are distinct categories with independent staleness triggers and application-controlled freshness expiry; the unavailable summary is not evidence and cannot be selected by a plan.
- Provider/model transient failures may retry according to Worker policy. Policy, schema, preference-stale, cancellation, `MISSING` matrix and bounded-tool-loop failures are terminal; a bounded provider `UNAVAILABLE` result is a non-commercial gap, not invented evidence.
- An activities offer whose `expires_at` has passed causes the dependent plan to enter `STALE` independent of any flight offer expiry.

### TS-PERSONAL-TRIP-ORCHESTRATION-1 — Owner-confirmed Solo research reuses Shared activities evidence

**Stories:** H1, H3
**Objective:** Verify that a Personal Agent can guide a Solo Trip into a durable, snapshot-bound activities research task without direct tool authority or a second Personal evidence store.

**Steps:**

1. As one authenticated owner, create a Draft through Explore. Ask “查东京活动”, then inspect tasks, snapshots, provider search rows and audit events before activation.
2. Confirm a complete Solo brief with one Tokyo candidate, activate the Trip, save required owner consent/preferences, and submit the research confirmation command twice concurrently with the same request ID.
3. Verify the accepted task is `RESEARCH`, has server-written trip/snapshot/run authority and uses the existing `activities.search` registry entry with the Shared policy gate. Attempt browser/model supplied snapshot ID, owner ID, coordinates, radius, free-text provider query, theme outside allow-list and MCP URL.
4. Inspect provider search/evidence rows and the owner result DTO. Then request `PROPOSE_PLAN`, accept the resulting plan as owner, and inspect status transitions.
5. Force revoked consent, preference change, `UNAVAILABLE`, expired activity evidence, feature-disabled adapter and a lost Worker lease while a run is active.

**Expected outcomes:**

- Draft creates no snapshot, provider request or research task; it only returns an activation/required-input prompt.
- The confirmed command creates exactly one immutable Solo snapshot, one durable task and one outbox event. It reuses `provider_search_runs` / evidence binding; `personal_provider_search_runs` and a duplicate Personal Skill are not created.
- Repeating the same request ID returns the original run and snapshot without allocating another snapshot. Missing departure city, travel dates, or a capability-required confirmed preference returns `422` before any snapshot, task or outbox write. A safe partial result is exposed as `COMPLETED_WITH_GAPS` through the run-read API.
- The model receives only normalized tool output. It cannot read chat text, raw profile, another Trip/user, MCP payload, click-off link or currency-less price, and it cannot choose provider authority.
- `RESEARCH_ONLY` writes no plan or booking authority. `PROPOSE_PLAN` creates a validated `PROPOSED` plan; the owner’s `ACCEPT` is required before `ACTIVE`.
- Consent/preference/evidence changes stale current results atomically. `UNAVAILABLE` is a safe gap, while policy/schema/lease errors produce no plan; no fixture or Demo fallback appears.
- Logs, trace attributes, metric labels, audit summaries and non-owner responses contain no conversation text, owner profile values, activity names or private snapshot fields.

### TS-ACTIVITIES-TOOL-3 — Activities evidence is excluded from readiness

**Stories:** H4, S1
**Objective:** Verify that visa/entry readiness remains grounded only in authorized nationality, route and official verification sources, never in activity search evidence.

**Steps:**

1. Build a planning run with persisted Shared activities evidence for two destinations and an `ACTIVE` plan.
2. Attempt to include an activities evidence ID, name, price or provider link in readiness input/output.
3. Repeat with a Personal activity result and a route/nationality record that requires an official verification gap.

**Expected outcomes:**

- Any activities evidence or booking link reference is rejected by the readiness and plan validators; it is not persisted as authoritative readiness text.
- Missing authoritative visa/entry data yields the existing official verification gap, not a conclusion inferred from activities.
- Personal activity results are never eligible as Shared or readiness evidence.

### TS-ORS-TOOL-1 — LLM tool whitelist exposes ORS skills when enabled

**Stories:** H3
**Objective:** Verify that `places.search`, `places.adopt`, and `navigation.route` appear in the LLM tool list when `PLAN_ENABLE_PLACES=true` and `PLAN_ENABLE_NAVIGATION=true`, and disappear when those flags are false. The provider layer still works server-side regardless of the flag.

**Steps:**

1. Run `generatePlan` with `PLAN_ENABLE_PLACES=false`, `PLAN_ENABLE_NAVIGATION=false`; capture the `tools` argument passed to `modelGateway.generateStructuredPlanWithTools`.
2. Repeat with `PLAN_ENABLE_PLACES=true`, `PLAN_ENABLE_NAVIGATION=true`.
3. Inspect the captured tool list.

**Expected outcomes:**

- Step 1: the tool list contains `flight.search` and (when `PLAN_ENABLE_ACTIVITIES=true`) `activities.search`; it does NOT contain `places.search`, `places.adopt`, or `navigation.route`.
- Step 2: the tool list additionally contains `places.search`, `places.adopt`, and `navigation.route`. Each tool's JSON Schema parameter list is exactly the versioned spec in `apps/api/src/services/{place-search,navigation-route,trip-place}-service.ts`.
- Flipping `PLAN_ENABLE_PLACES=false` and `PLAN_ENABLE_NAVIGATION=true` (or vice versa) hides only the tools gated by the disabled flag; the other set remains visible.

### TS-ORS-TOOL-2 — ORS tools are gated by the configured model's tool-calling capability

**Stories:** H3
**Objective:** Verify that `places.search`, `places.adopt`, and `navigation.route` are not advertised unless the configured OpenAI-compatible model has been validated against the function-tool-calling compatibility spike (`MODEL_GATEWAY_TOOL_CALLING_ENABLED=true`).

**Steps:**

1. Set `MODEL_GATEWAY_TOOL_CALLING_ENABLED=false`; set `PLAN_ENABLE_PLACES=true`, `PLAN_ENABLE_NAVIGATION=true`.
2. Run a Shared planning task that takes the durable planning path.
3. Repeat with `MODEL_GATEWAY_TOOL_CALLING_ENABLED=true`.

**Expected outcomes:**

- Step 1: the durable planning service raises `PlanningDataUnavailableError(["tool_calling_not_supported"])`. The legacy `generateStructuredPlan` (no tools) path is selected.
- Step 2: the durable planning service takes the tool loop path and the ORS tools are visible to the model as expected.

### TS-ORS-TOOL-3 — LLM cannot pass raw coordinates to `places.search` / `navigation.route`

**Stories:** H3, S1
**Objective:** Verify that the dispatcher refuses model-supplied raw coordinates, provider names, URLs, or private profile data, and surfaces a deterministic `POLICY_DENIED` error.

**Steps:**

1. Trigger `places.search` with `keyword` containing raw coordinates (`"35.6762, 139.6503"`) or provider name (`"amadeus"`).
2. Trigger `places.adopt` with `action: "propose"` and `candidate` missing required `displayName` / `latitude` / `longitude`.
3. Trigger `navigation.route` with an `originPlaceId` that is not in the trip's `trip_places` table.
4. Trigger `navigation.route` with `originPlaceId === destinationPlaceId`.

**Expected outcomes:**

- All four attempts return `UNAVAILABLE/POLICY_DENIED` or are wrapped by the skill registry as `INPUT_INVALID`; the request never reaches ORS.
- The dispatcher never logs the rejected payload content; the audit row records only `POLICY_DENIED` with the offending skill name and `redactedReason` (no raw coordinates).
- Provider metrics (`place_search_tool_invocations_total`, `navigation_route_tool_invocations_total`) increment `outcome="unavailable", error_category="policy_denied"`.

### TS-ORS-TOOL-4 — ORS UNAVAILABLE flows back through the model as a tool result

**Stories:** H3, S4
**Objective:** Verify that when ORS is not configured (`ORS_API_KEY` unset) and the model calls `places.search` / `navigation.route`, the tool returns `UNAVAILABLE/NOT_CONFIGURED` and the LLM loop completes with `COMPLETED_WITH_GAPS` rather than failing hard.

**Steps:**

1. Unset `ORS_API_KEY`. Set `PLAN_ENABLE_PLACES=true`, `PLAN_ENABLE_NAVIGATION=true`, `MODEL_GATEWAY_TOOL_CALLING_ENABLED=true`.
2. Trigger a Shared planning task that calls `places.search` from the model.
3. Repeat with `navigation.route`.

**Expected outcomes:**

- Tool result is `{ outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" }`.
- Planning completes; `summarizeProviderGaps` records `navigation: NOT_CONFIGURED` only when the LLM actually called `navigation.route` (the post-deprecation gate no longer emits a `navigation: NO_RESULTS` gap from an empty `ground[]`).
- No `provider_offers` row is written with `category="ground"`.
- `itinerary_plans.planData` JSON does NOT contain a top-level `ground` key.
## TS-H1g — Personal research confirmation and route binding

**Starting conditions:** An owner has a `PROPOSED` navigation intent in an active eligible trip and two active non-private TripPlaces.

**Steps and expected results:**

1. Submit a route selection with distinct endpoint IDs and an explicit mode; it is persisted against the intent run and the draft becomes `READY`.
2. Confirm with `originatingIntentRunId`; the API creates one RESEARCH run and atomically changes the source draft to `CONFIRMED`.
3. Retry with the same request ID; the API returns the original run. Confirm with a different request ID or a dismissed source draft; the API returns `409` and creates no task.
4. Change either selected endpoint to private/inactive before confirmation; confirmation fails closed with a capability gap.
5. Worker execution uses the selected IDs and mode; it must never select the earliest TripPlaces or default to `WALK`.

## TS-CONVERSATION-HOTEL-TOOL-COMPAT — Gemini 流式酒店工具调用

**Objective:** Verify that a Gemini OpenAI-compatible stream reliably
persists a complete private hotel query and dispatches exactly one live
`hotel.search` request without a second confirmation step or
depending on a provider-specific `finish_reason`.

**Steps:**

1. In one private thread submit a complete hotel query.
   Simulate a streamed `tool_calls` response terminated by `stop` and then a
   prose follow-up after the tool result.
2. Verify that exactly one provider request occurred, exactly one
   `conversation_hotel_search_states` row holds city/date/occupancy/currency,
   its legacy confirmation marker is null, bounded evidence is persisted, and
   the second stream returns a grounded response. No hotel confirmation UI or
   `CONFIRMATION_REQUIRED` result is produced.
3. Submit an explicit refresh; simulate a legacy streamed `function_call`
   envelope with no finish marker and the current city code. Verify the
   dispatcher reuses the remaining persisted fields and executes the new turn
   without interpreting it as booking/payment authority.
4. Repeat with Gemini `tool_calls`, `finish_reason = stop`, and an opaque
   `extra_content.google.thought_signature`; verify the assistant tool-call
   message in the second request carries that opaque field unchanged. Repeat
   with OpenAI `tool_calls` and `finish_reason = tool_calls`; behavior is
   identical. Repeat a confirmed request with malformed JSON arguments, mixed
   prose plus a tool call, and a missing function name.
5. Inspect safe runtime events and audit records.

**Expected outcomes:**

- `stop`, `function_call`, and a missing finish marker never discard a fully
  accumulated tool call or become an empty-content `SCHEMA_PARSE`.
- Invalid/mixed tool envelopes fail closed with `TOOL_PROTOCOL`; the provider
  is not called and no raw tool arguments or conversation text enter logs,
  traces, metrics, or audit summaries.
- A Gemini thought signature is replayed only to Gemini as opaque request
  compatibility metadata; it is never logged, traced, persisted, or exposed
  to the client. A retryable second-completion failure before visible text
  yields a safe fallback reply rather than a failed message.
- Only a server-recognised explicit confirmation for the current USER message
  may invoke the provider. New query fields replace the private state and
  invalidate any previous confirmation.
- Telemetry contains only the bounded tool envelope family, normalized finish
  reason, operation, outcome and correlation identifiers. It contains neither
  city/date/occupancy/currency nor provider request/response payloads.

## TS-CONVERSATIONAL-SETUP — Conversational hotel setup (§9)

**Starting conditions:** An owner has an activated Solo Trip (`PLANNING`) with no travel dates, no departure city, no stay preferences, no flight preferences, and a `PROPOSED` hotel research intent draft whose readiness is `NEEDS_SETUP` with `missing = ["DATES_MISSING", "STAY_PREFERENCES_MISSING"]`.

### TS-CONVERSATIONAL-SETUP-1 — Owner fills only dates; confirm blocks until stay prefs are also supplied

1. The owner submits a chat turn that the classifier turns into `RESEARCH_ONLY: [hotel]`. The conversation worker opens a `personal_research_setup_sessions` row with `expires_at` ≈ now + 15 min, emits `research.intent_extracted` + `research.setup.followup`, and persists no question text.
2. The owner enters check-in / check-out via the inline card; one `POST /agent-runs/:runId/research-setup/answers` with `{ field: "travelDates", value: { start, end } }` persists the ordered date pair under a single optimistic-version update.
3. `missing[]` recomputes to `["STAY_PREFERENCES_MISSING"]`. The card disables 确认并搜索.
4. The owner bypasses the disabled button and calls 确认并搜索. The API returns `422` because `STAY_PREFERENCES_MISSING` is still unresolved. No `trip_stay_search_preferences` row is written and no RESEARCH task is accepted.

### TS-CONVERSATIONAL-SETUP-2 — Owner confirms; preferences + dates are persisted atomically

1. Continuing from the previous step, the owner supplies `stayPreferences = { roomCount: 1, adultsPerRoom: [2], currency: "TWD" }`.
2. Click 确认并搜索 with `requestId = uuid()`. The server returns `202 { runId, snapshotId, status: "QUEUED" }`, writes a new `trip_stay_search_preferences` row (version +1), updates `shared_trips.travel_date_start` / `travel_date_end`, cascades stale plans, transitions the source draft to `CONFIRMED`, and accepts a RESEARCH task bound to `originatingIntentRunId`. The setup session is set to `CONFIRMED`. Audit row `PERSONAL_RESEARCH_SETUP_CONFIRMED` exists.
3. Client receives `research.stage SNAPSHOT_CREATED` for the new RESEARCH run; the existing `ResearchRunCard` mounts in place of the setup card.

### TS-CONVERSATIONAL-SETUP-3 — Idempotent retry of confirm-and-search

1. After TS-CONVERSATIONAL-SETUP-2, the client retries the same `POST /confirm-and-search` with the same `requestId`. The server returns the original 202 envelope; no second `trip_stay_search_preferences` row, no second RESEARCH task, no second audit row.
2. A second request with a different `requestId` and an already-confirmed session returns `409`.

### TS-CONVERSATIONAL-SETUP-4 — Hotel provider disabled or Nuitee auth missing

1. With `PLAN_ENABLE_HOTEL=false`, `confirm-and-search` returns `422`; no preferences persisted.
2. With `HOTEL_PROVIDER=nuitee_connect` and no `stay_search_provider_authorizations` row, the confirm tx throws `422` from `loadActiveQuoteNationality`; the audit row records the failure but no preferences / task / intent transition is committed.

### TS-CONVERSATIONAL-SETUP-5 — Stale-cascade ordering

1. With an in-flight `RESEARCH` task on the trip, the confirm tx must call `stalePlansAndConfirmationsForTrip` BEFORE `acceptResearchTask`. The transition is atomic; the new task lands only after the prior slot is freed.
2. If the prior run is `RUNNING` rather than `QUEUED`, the partial unique index frees after `status='STALE'`; no `agent_task_runs_one_active_planning` constraint violation surfaces.

### TS-CONVERSATIONAL-SETUP-6 — Cancel vs expiry

1. The owner clicks 关闭. `POST /agent-runs/:runId/research-setup/cancel` sets `status='CANCELLED'`. A subsequent `confirm-and-search` returns `410 Gone`.
2. A separate session past `expires_at` is opportunistically transitioned to `EXPIRED` on the next `applyAnswer` or `confirm-and-search` call; the API returns `410 Gone`. No RESEARCH task is created.

### TS-CONVERSATIONAL-SETUP-7 — Cross-user 403

1. A second owner calls `GET / POST /answers /cancel /confirm-and-search` on the run. `getAuthorizedAgentRun` rejects with `403` before any setup row read or write fires. No audit / metric row is emitted.

### TS-CONVERSATIONAL-SETUP-8 — Followup generator fallback when LLM fails

1. With `generateSetupFollowup`'s model gateway throwing, the conversation worker still emits `research.setup.followup` whose `source = "fallback"` and whose `questionCode` is one of the server-known missing codes. The metric `personal_research_setup_followup_total{outcome="fallback",reason="model_error"}` increments. The conversation task is not blocked; the setup card mounts and is editable.
2. The model gateway returns a `questionCode` not in `missing[]`. The generator falls back to the deterministic template and increments `reason="invalid_code"`. Audit summary for the fallback is `{ reason, missingCount }` only.

### TS-CONVERSATIONAL-SETUP-9 — Out-of-scope missing codes still surface the read-only card

1. The classifier returns `missing = ["HOTEL_PROVIDER_NOT_APPROVED"]`. The conversational card does NOT mount; the existing read-only `research-setup-card` renders with the `HOTEL_PROVIDER_NOT_APPROVED` hint and a single 关闭 button. The conversational API endpoints are not invoked.

### TS-CONVERSATIONAL-SETUP-10 — Privacy invariants

1. The setup row never contains the original question text, free-text extraction, the Profile, snapshot values, or any PII (passport / ID / phone / address). The audit summary contains only `{ sessionVersion, fieldsFilled }` (field names) plus bounded counters.
2. The followup generator's input is bounded to `missing[]`, `locale`, `filledFieldNames` (field labels only), and a server-known `missingCodeLabels` map; it never receives the original question.
3. The SSE `research.setup.followup` payload contains only `questionCode + promptText + source`; no `runId` echo, no original question.

### TS-CONVERSATIONAL-SETUP-11 — DRAFT and duplicate confirmation fail safely

1. A DRAFT Trip with missing dates produces `TRIP_NOT_ACTIVE` before date or preference gaps. It does not create an OPEN setup session or emit an editable setup follow-up; the read-only activation hint is shown instead.
2. Double-clicking 确认并搜索 while dates or stay preferences are being saved produces exactly one request per required slot and at most one confirm request. A failed request is rendered as a card error, never as an unhandled browser Promise rejection.

### TS-CONVERSATIONAL-SETUP-12 — Hotel-readiness reply template (direct help + dynamic currency example)

**Stories:** H1f, DRAFT Personal Research §3.5 stage 2
**Objective:** Verify the `HOTEL_SEARCH_READINESS` constraint produces a short, friendly, 4–6 line reply that says confirmed conditions can be included in the complete trip plan—not a separate hotel-search upsell—while asking for the missing query conditions in a stable order and providing a currency example dynamically generated from the owner's likely home currency and the destination's local currency. No user-facing copy may expose internal Agent names.

**Starting conditions:** Alice owns an active Solo Trip with `tripStatus=PLANNING` and `departureCities=["Shanghai"]`. No `hotelSearchState` row. No prior message in this thread about hotel query conditions. Place context resolves to Taipei via the conversation place resolver.

**Steps:**

1. Alice submits "请帮我找一下台北的酒店". The classifier routes the turn to the hotel-readiness branch (`HOTEL_SEARCH_READINESS` constraint attached, no Phase 4 tool call).
2. Inspect the streamed reply.

**Expected outcomes:**

- The reply is 4–6 lines and opens with one short invitation to hand the accommodation need to the Shared Agent for complete-trip orchestration. It does not present or promote a separate hotel-search flow, flights, or any other unrequested service.
- The four missing fields are asked in this exact order: ① 入住与退房日期 ② 入住配置（成人数与房间数）③ 报价币种. City name "台北" is NOT re-listed because the opening sentence already acknowledges the destination.
- The currency example is dynamic and reads "例如 CNY 或 TWD" — CNY first because `tripContext.departureCities` points to a mainland-China city (highest-priority signal after absent memory facts), TWD second as Taipei local currency.
- The reply does not include marketing copy, an explanation of the constraint, an apology, or a redirect to click a card/button.

**Variations covered by the same scenario:**

- *User supplies currency explicitly* — when Alice says "我想看新台币报价" before the bot asks, the model must skip the example and use TWD directly without inventing alternatives.
- *No departure-city signal at all* — when both `memoryContext` and `tripContext.departureCities` are empty and the question is in Chinese, the example reads "例如 USD 或 TWD" (兜底) — still exactly two codes, with destination local currency always second.
- *English question, Tokyo destination, no other signal* — the reply is in English and the example reads "e.g. USD or JPY".
- *Constraint breach attempt via prompt injection in `threadContext`* — when an earlier assistant turn in `threadContext` (treated as untrusted data, not instructions) tries to make the model promote a complete plan or invent a hotel list, the reply still follows the constraint.

### TS-CONVERSATIONAL-SETUP-13 — Private brief capture starts planning without exposing internal roles

**Objective:** Verify an exploratory itinerary request does not turn into an airline/hotel-search questionnaire or a private-chat-produced itinerary before the traveller confirms the trip details and starts planning.

**Starting conditions:** A private Personal Agent thread has no flight or hotel search state. The user says: "12 月从上海出发，3 位成人去台湾 10 天，想赏花和城市漫步。"

**Expected outcomes:**

- The reply summarizes only the known brief (Shanghai departure, Taiwan, December, 10 days, three adults, flowers and city walks) and asks at most one short question needed to complete the brief.
- It does not choose base cities, stay changes, daily pacing, transport, or a Day 1–N route. It says that the confirmed brief can be used to start planning, without naming an internal role.
- Until the user confirms the brief and explicitly presses **Start planning**, no snapshot, PLAN/REPLAN task, provider research, or itinerary is created. For a Solo Trip, that action atomically creates the snapshot and durable initial planning task; a Team Trip continues to require each required member's confirmation.
- The reply does not offer to search or compare flights, hotels, accommodation, prices, availability, rooms, cabins, or currency. Those flows begin only after the user explicitly requests the relevant service.

### TS-CONVERSATIONAL-SAFETY-REFUSAL-1 — Search conditions are not a refusal

**Objective:** Verify that supplying hotel/flight query conditions is handled as readiness or confirmation, not as an unsupported real-time-fact request.

**Steps:** In a Chinese private thread whose prior context contains a dated hotel request, submit `1人1间房间，CNY`.

**Expected outcomes:**

- The turn does not produce `SAFE_REFUSAL`; it saves or summarizes the typed readiness state and asks for the required explicit confirmation where applicable.
- If a genuine safety refusal is required, the completed SSE event includes `responseMode: SAFE_REFUSAL`; the Chinese UI displays the localized verification marker next to the persisted assistant message.

### TS-EXPLORE-PRIVATE-CHAT-AUTH-1 — 首次私聊创建的认证失败可诊断

**Objective:** Home 首次发送创建私有 Draft Trip / thread 时，不能把认证失败伪装为普通发送失败。

**Steps:** 在 `custom-local` 模式下移除或使浏览器 bearer token 失效，然后从 Home 发送首条消息。

**Expected outcomes:**

- `POST /explorations/start` 返回 `401`；不创建 Trip、thread、消息或 Agent task。
- UI 保留私人对话不可用状态，并显示“需要登录”的具体原因；不得显示网络错误或继续将消息标记为已发送。
- 点击重试只以同一 idempotency key 再次尝试创建；用户完成登录后可安全重试。

### TS-CONVERSATIONAL-FLIGHT-PREFERENCES-1 — 机票偏好对话选项卡

**Objective:** 在私有对话中补充机票偏好，而不因选择本身调用实时供应商。

**Steps:**

1. 服务端对当前 owner 的 conversation run 分类为包含 `flight`，并返回 `FLIGHT_PREFERENCES_MISSING`。
2. 在卡片中选择往返、成人数量、舱位和报价币种；不点击保存。
3. 点击保存，再更改成人数量并再次保存。

**Expected outcomes:**

- 非 flight 分类或未返回该 missing code 时不显示卡片；不能由聊天文本自行触发。
- 仅点击选项不会创建 preference version、使 plan 失效或调用 provider。保存后才以当前 trip membership 授权写入一条新的 search-preferences version；后一次保存是最新有效版本。
- 保存本身不是 provider 搜索确认；日期仍由 trip brief / 对话确认，实时机票搜索继续需要独立的明确确认。

## 已批准、已部分实现：DRAFT Personal Research（flight 已上线；其余 capability 按 §3.5 顺序逐项 PR 开放）

> 本节是 [DRAFT Personal Research 到 Shared Planning 实施规范](draft-personal-research-implementation.md) 的验收矩阵。
>
> **Phase 1 实施状态**（feature/draft-personal-research-phase1 分支，迁移 0047a/b/c 上线）：
>
> | capability | allow-list | executor | UI input card | UI result card | 备注 |
> | --- | --- | --- | --- | --- | --- |
> | `flight.search` | ✅ open | ✅ `services/personal-research-executors/flight.ts` | ✅ `inputs/flight-research-input-card.tsx` | ✅ `results/flight-research-result-card.tsx` | Phase 1 |
> | `hotel.search` | ❌ commented | ❌ stub only | ❌ 待实现 | ❌ 待实现 | §3.5 stage 2 — 等 Nuitee nationality contract + provider tests |
> | `accommodation.discovery` | ❌ commented | ❌ stub only | ❌ 待实现 | ❌ 待实现 | §3.5 stage 2 — 等 OpenTripMap contract tests |
> | `activities.search` | ❌ commented | ❌ stub only | ❌ 待实现 | ❌ 待实现 | §3.5 stage 2 — 等 Viator MCP contract tests |
> | `places.search` | ❌ commented | ❌ stub only | ❌ 待实现 | ❌ 待实现 | §3.5 stage 3 — 个人 place 绝不写入 `trip_places` |
> | `navigation.route` | ❌ commented | ❌ stub only | ❌ 待实现 | ❌ 待实现 | §3.5 stage 3 — 不含商业票价/班次 |
> | `mobility.search` | ❌ commented | ❌ stub only | ❌ 待实现 | ❌ 待实现 | §3.5 stage 3 — `PLAN_ENABLE_MOBILITY=false` → UNAVAILABLE |
> | `visa.*` | ❌ 故意不在 enum | ❌ | ❌ | ❌ | §3.5 stage 4 — 等真实 `VisaProvider` + DPA + 凭据 + audit + sandbox |
>
> **Phase 1 路由**（`apps/api/src/routes/personal-research.ts`）：`GET / PUT / POST confirm / POST cancel`，全部 owner-only via `requireRunAccess` 第三分支 + `getAuthorizedAgentRun`。
>
> **既有 CI 回归**仍按上一节 `TS-CONVERSATIONAL-SETUP-11` 跑：DRAFT research fail closed。下面四组断言在 Phase 1 实施后正式生效；其他 capability 解锁时按 §3.5 顺序逐项追加。

### TS-DRAFT-PERSONAL-RESEARCH-1 — Trip 与 Personal Session 不分叉

1. 首条已提交私聊消息仍原子创建一条 DRAFT `shared_trips`、一条创建者 membership 和一条 owner-only `chat_threads`；刷新/重连继续使用同一 thread。
2. 不存在无 `trip_id` 的 Personal query、第二张 Personal Session 表或由 Shared Agent/LLM 创建的 Trip ID。
3. 实施覆盖：`apps/api/migrations/0047a/b/c_personal_research*.sql` 的 CHECK 新分支 `(operation = 'PERSONAL_RESEARCH' AND trip_id NOT NULL AND snapshot_id NULL)` 保证新行永远 trip-bound 且不持 snapshot。

### TS-DRAFT-PERSONAL-RESEARCH-2 — 明确确认后才执行 Flight

1. DRAFT owner 在完整的受控 airport/date/passenger input 上以稳定 `requestId` confirm 后，恰好接受一条 `PERSONAL_RESEARCH` task；worker 用 server-built `{ tripId, threadId, ownerUserId, runId }` authority 调用已配置 FlightProvider。
2. 低置信度聊天、未确认 draft、缺字段、cancelled/expired draft 均不触发 provider network call。UI 可建议先规划，但不能仅因 DRAFT 拒绝有效确认。
3. provider 的 timeout、empty、rate limit、schema drift 或缺配置写/显示安全 `UNAVAILABLE`，绝不使用 fixture、Demo data、模型价格或 provider 自动 fallback。
4. 实施覆盖：`apps/api/src/tasks/handlers/personal-research-task-handler.ts` 在 provider 调用前先调 `DefaultPolicyGate.requirePersonalResearchAuthority(authority, run)`（拒绝 owner 不匹配 / capability 不在 allow-list），handler 失败路径走 `failPersonalResearchTask` 持久化 UNAVAILABLE 证据行，不重试无限循环。

### TS-DRAFT-PERSONAL-RESEARCH-3 — 私有结果与 Shared 边界

1. 成功结果只对同一 `owner_user_id + thread_id + trip_id` 可读，带 source、captured_at 和适用的 expires_at；raw provider payload、私聊正文、国籍/证件不被持久化或发到 SSE/telemetry。
2. 同 Trip 的另一 member、Shared Agent、snapshot 创建、plan validator 和 plan query 不能读取 Personal evidence。DRAFT research 不创建 snapshot、PLAN/REPLAN、plan、confirmation 或 booking request。
3. 用户点击开始规划后仍走既有 activate + consent + snapshot 路径；Shared research 重新查询 provider，不能采用 Personal evidence。
4. 实施覆盖：
   - `apps/api/migrations/0047c` 的 `personal_research_evidence` 表 `owner_user_id` 与 `agent_task_runs.created_by_user_id` 等价 CHECK 防漂移；
   - `apps/api/src/tasks/task-repository.ts` 的 `requireRunAccess` 第三分支对 `PERSONAL_RESEARCH` 仅校验 creator，不查询 `trip_members`；
   - handler 调 `personal-research-service.ts.persistAvailability/persistUnavailability` 写入 `personal_research_evidence`，绝不**写入 `provider_offers` / `provider_search_runs`（snapshot-bound 既有表）**；
   - audit summary 走 `PERSONAL_RESEARCH_COMMAND_ACCEPTED` / `PERSONAL_RESEARCH_COMPLETED` / `PERSONAL_RESEARCH_CANCELLED` 三值，bounded 且不含 user text。

### TS-DRAFT-PERSONAL-RESEARCH-4 — 授权、并发与恢复

1. cross-user、thread/trip mismatch、membership 已移除、operation 不匹配和取消后的 confirm 在读取私有 request/evidence 前 fail closed。
2. 重复 confirm、浏览器重试、worker lease recovery、cancel race 和乱序 callback 最多产生一次 execution/result；audit 与 trace 可按 run 关联，指标不以 trip/run ID 作标签。
3. 实施覆盖：
   - `apps/api/migrations/0047b` 的 partial unique index `agent_task_runs_personal_research_owner_request_unique (created_by_user_id, request_id) WHERE operation = 'PERSONAL_RESEARCH'` 保证同 owner + requestId 只能有一行；
   - `completePersonalResearchTask` 与 `failPersonalResearchTask` 复用既有 `WHERE id = ? AND lease_token = ? AND status = 'RUNNING'` lease-guarded 写模式；
   - `acceptPersonalResearchTask` 在事务内重检 owner / thread.tripId / trip membership，三处任一失败抛 4xx 而非依赖 DB 唯一约束；
   - 路由 `POST /confirm` 在事务内重新校验 draft valid + capability ∈ allow-list + provider gate，再接受 task，duplicate requestId 走 `findPersonalResearchTaskByRequestId` 返回原 envelope（idempotent）。

### TS-DRAFT-PERSONAL-RESEARCH-5 — 按 capability 放开

1. 未完成 contract 的 hotel、activities、places、navigation、mobility 和 visa 均被 Personal allow-list 拒绝；不能由 Flight 的开关间接启用。
2. Hotel 必须覆盖 dates/occupancy/currency、provider-only nationality authorization 与 provider binding；route 必须覆盖 owner 选择的两个 private endpoints；visa 在 `VisaProvider` 可用前只返回 `UNAVAILABLE` 和官方核验下一步。
3. 实施覆盖：
   - `apps/api/src/config/personal-research-allowed-capabilities.ts` 的 `PERSONAL_RESEARCH_ALLOWED_CAPABILITIES` 常量（默认只有 `flight.search`），其余 capability 显式注释；
   - `personal-research-service.ts.dispatchCapability` 的 switch 仅 `FLIGHT_SEARCH` 命中真 executor，其他 kind 抛 `ExecutorNotImplementedError` → UNAVAILABLE；
   - route 层 `deriveCapabilityFromDraft` + `isPersonalResearchCapabilityAllowed` 校验在 confirm 之前，返回 422；
   - 解锁新 capability 必须独立 PR：移除对应注释 + 新 executor + 新 input/result card + provider contract 测试 + 移除服务 dispatch 中的 throw + 增量 `test-scenarios.md` 条目。

### TS-DRAFT-PERSONAL-RESEARCH-6 — 自动化测试矩阵

| 类别 | 测试文件 | 覆盖 |
| --- | --- | --- |
| 路由契约 | `tests/routes/personal-research.test.ts` | cross-user 403 / 200 owner / 草稿持久化 / confirm 202 / 同幂幂幂 / capability not allowed 422 / cancel 幂等 / strict extra-key 400 / strict invalid IATA 400 |
| Schema 契约 | `tests/contracts/personal-research-schema.test.ts` *(待补)* | strict reject 越权字段；visa.* 拒；discriminated union 完整 7 schema |
| Migration | `tests/migrations/0047a-personal-research-enum.test.ts` *(待补)* | enum 值存在；CHECK 允许 PERSONAL_RESEARCH 分支 |
| Migration | `tests/migrations/0047b-personal-research-refs.test.ts` *(待补)* | partial unique 强制；不同 operation requestId 互不冲突 |
| Migration | `tests/migrations/0047c-personal-research-evidence.test.ts` *(待补)* | UNIQUE (run_id, capability) 强制；CASCADE；CHECK owner = creator |
| Authority | `tests/personal-research/authority.test.ts` *(待补)* | `policy-gate.requirePersonalResearchAuthority` 拒绝 owner/trip/snapshot/capability 越界 |
| Privacy | `tests/personal-research/privacy.test.ts` *(待补)* | Shared trip-member 不见 Personal evidence；navigation 不含票价；places 不写 `trip_places`；raw payload 不入库 |
| Cancel | `tests/personal-research/cancel.test.ts` *(待补)* | QUEUED 取消无 provider 调用；double-cancel 幂等 |
| Web 组件 | `apps/web/tests/personal-research/flight-input-card.test.tsx` *(待补)* | IATA 校验 / 日期校验 / saveAnswers 调用 |

### TS-DRAFT-PERSONAL-RESEARCH-7 — DRAFT 不得主推供应商搜索

**Starting conditions:** 一个 `DRAFT` Trip 的 owner 在自己的私有 thread 中对话；`PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED` 与 `MODEL_GATEWAY_TOOL_CALLING_ENABLED` 均为 `true`，`flight.search` 与 `hotel.search` 均在 capability allow-list 内。

1. owner 只表达整段旅行意图（例如「我想要带我女朋友国庆节的时候去新加坡玩4天」），没有提出查找、比较、筛选或报价机票/住宿。本轮 system prompt **不得**包含 `HOTEL_SEARCH_READINESS` 或 `FLIGHT_SEARCH_READINESS`；不得产生 `conversation_flight_search_states` / `conversation_hotel_search_states` 行；不得写 `PERSONAL_RESEARCH_TOOL_DISPATCH` audit；回复走 brief 归纳路径而不是搜索确认按钮。
2. `flight.search` 与 `hotel.search` 的 tool definition 仍然注册。owner 明确要求查询时（DRAFT Personal Research §1「不能以尚未完整规划为由阻断用户已经明确要求的查询」），模型可在同一轮自行发起调用；调用成功持久化 search state 后，**下一轮**起该 capability 的 readiness 契约恢复注入。
3. owner 本轮显式确认机票搜索（`确认搜索机票` / 未点名的 `确认搜索`）时，机票契约当轮即注入；酒店搜索不需要确认，显式酒店查询由已注册 tool 和完整参数直接执行，且不得授权另一 capability。
4. Trip 状态为 `PLANNING` / `STALE` / `CONFIRMED` / `BOOKED` / `CANCELLED` 时，行为与本次改动前一致：只要对应 tool 已注册，契约照常注入。
5. 任一 capability 的 tool 未注册（feature flag 关闭或 capability 未开放）时，其契约不得进入 prompt——该契约几乎全部是调用该 tool 的指令。

**自动化：** `apps/api/tests/conversation-response-constraints.test.ts`；`apps/api/tests/conversation-safety.test.ts` 覆盖 Skill 侧默认不附加契约与按 worker 选择透传。

### TS-DRAFT-PERSONAL-RESEARCH-8 — 助手提议、用户追认的行程事实必须进入简报

**Starting conditions:** 同上；Trip 为 `DRAFT`，brief 仍缺出发日期。

1. owner 用口语给出日期（「国庆节」「the first week of October」），助手在本轮回复中把它解析成具体日历日期，owner 在下一轮回复「日期确认」「确认」「没问题」之类的接受语。该日期**必须**作为 `tripBriefProposal` 产出，写入待确认的行程简报卡。
2. 取值只能逐字取自本轮 `assistantReply`；owner 未接受的助手取值、以及本轮 `assistantReply` 中不存在的取值，一律不得提取。
3. owner 只接受助手提议中的一部分时，只提取该部分；owner 的提问、纠正或反提议不算接受。
4. owner 单方面的模糊表述（仅「下个月」，助手未解析或 owner 未接受）仍不得提取。
5. 回归目标：日期不得只落在 `conversation_*_search_states` 而 `shared_trips.travel_date_start` 为空——那会让 `POST /trips/:tripId/activate` 无法创建 snapshot 与 `PROPOSE_PLAN` task，Trip 卡在无法规划的 `PLANNING`。

### TS-DRAFT-SHARED-HANDOFF-1 — 国家级目的地不得伪装为可开始的 Shared 规划

**Objective:** Verify DRAFT private chat gives an actionable, truthful next
step when dates are known but the destination is a country or another
non-city label.

**Starting conditions:** A Solo `DRAFT` Trip belongs to its creator. The
owner has confirmed `travelDateStart` and `travelDateEnd`, while
`departureCities=[]` and `destinationCandidates=[]`.

1. The owner discusses a country-level destination such as France and asks
   how to arrange a ten-day trip.
2. Inspect the conversation response, draft-brief proposal/card and the
   “Start planning” action.
3. The owner selects one unambiguous city, supplies an origin, confirms the
   draft brief, and then clicks “Start planning”.
4. Repeat with a natural-language “confirm” / “start” message before clicking
   the UI action.

**Expected outcomes:**

- The reply may discuss high-level options, but states that a city and origin
  are still required before full planning can start. It must not say that a
  Shared plan has started or imply an itinerary/provider query exists.
- The country name is never persisted as a destination city, and no fallback
  chooses a capital. Until an unambiguous city is confirmed,
  `destinationCandidates` remains empty and the CTA is disabled with a
  comprehensible missing-field explanation.
- Before the CTA click, no `constraint_snapshot`, snapshot-bound
  `PLAN`/`REPLAN`/`RESEARCH` task or itinerary plan exists. The private turn
  remains `CONVERSATION`; this scenario does not alter separately confirmed
  `PERSONAL_RESEARCH` behaviour.
- After confirmed city, origin and dates make the brief complete, only the
  explicit CTA calls `POST /trips/:tripId/activate`; the Solo activation
  transaction creates the snapshot and first planning task atomically.
- Natural-language confirmation alone cannot activate the Trip.

## 已实施：成员私有对话候选交接 Shared Agent

> 本节是 [成员对话候选到 Shared Agent 交接实施规范](member-conversation-handoff-implementation.md) 的验收矩阵。其范围是非敏感 Trip constraint 的成员对话交接；DRAFT Personal Research 的私有 provider 查询测试继续适用。

### TS-CONVERSATION-HANDOFF-1 — 任意成员与私有归属

**Starting conditions:** 一个 `PLANNING` Team Trip 有 creator Alice 和 active members Bob、Chen；Bob 与 Chen 各自拥有绑定该 Trip 的 private thread。

1. Bob 在自己的 thread 中表达 `no_red_eye` 和 `travel_pace`，Personal Agent 生成 Bob-owned candidate batch；Bob 确认后返回 `202` 的 Shared planning run。
2. Alice 请求读取、confirm、dismiss 或更新 Bob batch 中的 proposal；Chen 使用自己的 thread ID 尝试确认 Bob batch；已离开 Trip 的 Bob 重试 confirm。
3. Bob 以相同 `requestId` 并发提交两次 confirm；确认完成后再用旧 candidate version 提交。
4. 在同一个 batch 中生成 `no_red_eye` 与 `travel_pace` 两条候选；读取 batch 后只选择第一条确认。
5. 将 Bob 从 Trip membership 移除后，分别读取和确认他的旧 batch；另创建一个 `DRAFT` Trip 对话和一个 `PLANNING` Trip 对话，比较是否产生 handoff SSE。
6. 删除含有 `PENDING` handoff candidates 的 Bob private thread。

**Expected:**

- Bob 可完成交接，无需 creator 权限；其他三种跨成员/离开情形均 fail closed（403/409），且不写 fact/snapshot/task。
- 同一 request 只创建一组 facts、一个 snapshot 和一个 PLAN/REPLAN task；旧 version 不得覆盖新候选。
- audit/trace 可关联 actor、trip、run，但不记录聊天文本、值或 user ID 作为 metric label。
- 同一 batch 的全部候选返回同一个 `candidate_version`，多候选读取、部分选择确认均可用；新 batch 不会覆盖旧 batch。
- 已移除成员的读取和确认均 fail closed；`DRAFT` 对话不发 handoff SSE，`PLANNING`/`STALE` 对话才可发出。删除私聊先将待确认候选置为 `DISMISSED`，随后正文和 thread 可删除，终态候选不保留可用的 thread/run provenance。

### TS-CONVERSATION-HANDOFF-2 — 候选与敏感字段边界

1. 对话分别给出合法 `no_red_eye`、`interests` 候选，未知字段和 `nationality`、passport、health、accessibility 候选。
2. 将模型输出伪造为任意 JSON、超出字段目录的 HARD strength，或包含私聊原文的 rationale。
3. 确认合法 batch，然后查询 Shared member API、snapshot DTO、plan explanation、SSE、audit、log/trace fixture 和 metric labels。

**Expected:**

- 仅允许目录中的非敏感字段作为 `PENDING` candidate；异常或敏感字段只触发澄清/表单引导，不写 proposal/fact。
- Shared Agent 只接收确认后的最小 projection；私聊、候选 rationale 与 confidential 值不出现在任何公开或遥测路径。
- `ORCHESTRATOR_CONFIDENTIAL` 确认必须有残余推断提示；其他成员只可见 `TEAM_VISIBLE` facts。

### TS-CONVERSATION-HANDOFF-3 — 原子交接与自动最新方案

1. 无现有 plan 时确认一个合法 batch；检查 accepted operation。
2. 在已有 ACTIVE plan、confirmations 和 adoption votes 时确认另一个成员 batch；检查 mutation transaction 与 worker finalization。
3. 在 snapshot 创建后、Worker 持有 lease 时撤回 consent 或确认新 batch；随后尝试让旧 run 写入 plan。

**Expected:**

- 首次交接接受 `PLAN`；已有方案的交接原子 stale ACTIVE/PROPOSED plan、confirmations、votes 和在途结果，并接受一个 `REPLAN`。
- UI 仅显示“生成最新共享方案”，没有手动 replan CTA；旧方案只能比较，不能恢复或预订。
- snapshot manifest/lease guard 阻止旧 run 激活或覆盖新 plan；新 Shared Worker 重新取 provider evidence，绝不重用 Personal Research evidence。

### TS-CONVERSATION-HANDOFF-4 — Shared 方案与确认门

1. 对一个 batch 交接后的 Team Trip 执行 Shared Worker，验证每个 destination candidate 的 research coverage；模拟一个 provider 缺失。
2. 在 `PROPOSED` plan 上只由部分成员投 ACCEPT，或由一位成员投 NEEDS_CHANGES；尝试 booking sandbox。
3. 所有 required members adoption 后，再缺少一个 booking confirmation 时尝试 sandbox。

**Expected:**

- Shared plan 覆盖全部配置候选；provider gap 是来源化 `UNAVAILABLE`/`COMPLETED_WITH_GAPS`，没有 fixture fallback。
- 交接确认不会直接激活方案；仅全员 adoption 将 plan 变为 ACTIVE，只有全员既有 booking confirmation 才允许 sandbox。

### 自动化映射

| 类别 | 建议测试文件 | 覆盖 |
| --- | --- | --- |
| Migration/schema | `apps/api/tests/migrations/conversation-handoff.test.ts` | batch/origin/version、legacy compatibility、索引与约束。 |
| Service/route | `apps/api/tests/team-orchestration/conversation-handoff.test.ts` | 任意 active member、cross-member/thread/trip 拒绝、idempotency、stale/PLAN/REPLAN。 |
| Extraction | `apps/api/tests/skills/trip-constraint-propose.test.ts` | catalog strictness、敏感字段拒绝、无原文持久化。 |
| Worker | `apps/api/tests/team-orchestration/conversation-handoff-worker.test.ts` | snapshot manifest、全候选 coverage、late lease finalization。 |
| Web/E2E | `apps/web/src/components/trips/conversation-handoff-card.test.tsx` | 私有候选卡、visibility、确认恢复、无手动 replan UI。 |

### TS-SHARED-SURFACE-PHASE-0 — Close the `pinnedSession` cross-member leak

**Stories:** §10.1 (API regression)
**Objective:** Verify `GET /trips/:tripId` no longer surfaces another member's
`research_intent_draft` payload via `pinnedSession`, and that the confirm
response shape stays aligned with the Zod contract.

**Starting conditions:** Disposable test DB; Alice, Bob, and Carol
provisioned. Alice's `agent_task_runs` row carries a non-null
`research_intent_draft` (CONVERSATION with `thread_id`, `trip_id`,
`user_message_id`). The trip's `pinned_session_id` points at that run.

**Steps:**

1. `GET /trips/:tripId` as Alice — record the response body.
2. `GET /trips/:tripId` as Bob (active member) — record the response body.
3. `GET /trips/:tripId` as Carol (non-member) — record the status code.
4. Drop the trip's `pinned_session_id` to null. Repeat steps 1 and 2 as Alice
   and Bob; both must now return `pinnedSession: null`.
5. `POST /trips/:tripId/constraint-handoffs/:batchId/confirm` as Bob with a
   valid payload. Decode the response shape; it must contain
   `{ runId, snapshotId, operation: "PLAN" | "REPLAN", status: "QUEUED" }`.

**Expected outcomes:**

- Alice sees the populated `pinnedSession` DTO with her draft
  `destinationCandidates` intact.
- Bob receives `pinnedSession: null` — the cross-member leak is closed.
- Carol receives `403` — the upstream membership gate holds.
- A trip with no pinned run returns `pinnedSession: null` to every member.
- Confirm response shape exactly matches `constraintHandoffConfirmResponseSchema`;
  any drift surfaces immediately rather than as a runtime mismatch.

**Coverage:** `apps/api/tests/trip-pinned-session-ownership.test.ts`.

### TS-SHARED-SURFACE-PHASE-1 — Rail + read-only skeleton (minimum shippable)

**Stories:** §10.2 4/7/8/12/16
**Objective:** Verify the trip-scoped read-only view is reachable from the
rail, that `?view=shared` and `?thread=<uuid>` are mutually exclusive, and
that non-members see no plan/constraint/run data.

**Starting conditions:** A trip with one active thread.

**Steps:**

1. Open `/trips/:tripId` and confirm the rail shows the "Shared plan"
   pinned entry above the "New thread" button.
2. Click the entry; verify URL becomes `?view=shared`, the middle pane
   renders the empty state when no plans exist, and `localStorage`
   remains untouched.
3. From the empty state, pick a private thread; verify URL drops
   `view=shared` and adds `?thread=<uuid>`.
4. From the thread URL, click "Shared plan" again; verify `?thread=` is
   cleared.
5. Manually edit the URL to `?view=shared&thread=<unknown-uuid>` and
   reload. Verify the workspace does NOT bounce to a default thread
   (the §7.1 skip-thread-fallback rule holds).
7. Visit `/trips/:tripId?view=shared` as a non-member; verify a 403-styled
   alert and no rendered plan / constraint / run field.
8. Disable `localStorage` (`Object.defineProperty(window, 'localStorage',
   ...)`) and reload `?view=shared`; verify the view still renders and
   no script error is thrown.
9. Inspect every text node on the surface for member names or "by
   <member>" attribution; assert none are present.

**Expected outcomes:**

- Rail entry always visible, even with zero plans.
- `?view=shared` and `?thread=<uuid>` are strictly exclusive; setting
  either clears the other.
- A current member may open the Shared plan surface while the Trip is still
  `DRAFT`; the read-only plans and team-visible-constraints projections return
  empty collections and the UI renders the empty state. This does not permit
  any Draft collaboration write (snapshot, plan/replan, constraint mutation,
  confirmation or booking), all of which still return `409 TRIP_NOT_ACTIVE`.
- Unknown-thread fallback effect does NOT fire when `view=shared` is
  active, so refresh cannot bounce the user out.
- Non-member gets 403 with no plan / constraint / run data rendered.

### Agent stream replay and terminal reveal

- Submit a conversation run which completes before the browser installs its SSE
  effect. The initial SSE request (without `Last-Event-ID`) replays its durable
  frames in ascending `streamEventId` order, and `data-stream-chars` becomes
  non-zero before the terminal row is cleared.
- Disconnect after a delivered frame, then reconnect with its `Last-Event-ID`.
  Only later frames are replayed; a live/replay overlap is rendered once.
- If the run is terminal and no journal frame is available, the persisted
  assistant message is revealed in the terminal row before it returns to normal
  conversation history. No reconnect or replay creates a second task.

### DRAFT planning call to action

- In the trip workspace, do not render the **Start planning** card while the
  DRAFT brief lacks a departure city, destination, or travel dates. The chat
  remains the sole route to fill those fields.
- Render the card only after all planning fields are present. If quote
  nationality is required, the card collects it before enabling submission.

### Shared planning research outcomes

- A terminal `RESEARCH` run with `research_mode=PROPOSE_PLAN`,
  `COMPLETED_WITH_GAPS`, and no `resultPlanId` is visible in Shared plan as a
  non-plan outcome with safe service-gap codes; it must not render the generic
  "no shared plan yet" state or invent an itinerary.
- The pinned result links to `/trips/:tripId/runs/:runId`. Members can read the
  run status and safe gaps there; a run from another trip, a private run, or a
  non-member request returns no detail and reveals no private inputs or
  provider payloads.
- `localStorage` unavailability never blocks render.
- No member names or trigger attribution appear on the surface.

**Coverage:** `apps/web/src/components/trips/trip-workspace.test.tsx`,
`shared-plan-view.test.tsx`, `shared-plan-read-state.test.ts`.

### TS-SHARED-SURFACE-PHASE-3 — Voting, version trail, constraints panel

**Stories:** §10.2 9/10/11/14/15
**Objective:** Verify the per-destination proposal card renders the
allow-listed data sources only, gaps render explicitly, expired offers
are marked, and votes are scoped to PROPOSED plans.

**Starting conditions:** A trip with one PROPOSED plan (with `flights`,
no `stays`/`hotels`/`activities`), one ACTIVE plan, one STALE plan. Alice,
Bob, Chen are required members; no member has voted yet.

**Steps:**

1. Visit `?view=shared`; verify three plan cards render with status
   badges PROPOSED / ACTIVE / STALE.
2. Inspect the PROPOSED card: confirm `flights` group renders origin,
   segments, total price + currency, source, capturedAt. Confirm no
   vote block on ACTIVE or STALE.
3. Confirm the PROPOSED card shows an explicit `UNAVAILABLE` marker for
   stays / hotels / activities.
4. Find an offer whose `expiresAt` has passed; confirm the inline
   "Offer expired" marker renders.
5. Send `publicExplanationTokens: ["SATISFIES_ALL_PRIVATE_CONSTRAINTS"]`;
   confirm localized copy renders. Add `"UNKNOWN_TOKEN_42"`; confirm
   the unknown token does NOT appear in the DOM.
6. Click ACCEPT on the PROPOSED card as Alice; confirm the mutation
   fires with `{ decision: "ACCEPT" }` and the votes query refreshes.
7. Re-submit the same vote with the same idempotency key; confirm no
   second vote row is created.
8. Bob votes `NEEDS_CHANGES`; confirm the vote block continues to render
   (`hasBlocker` flag) but no `ACTIVE` plan appears.

**Expected outcomes:**

- Cards render only `ListedPlan[]` + `teamVisibleFacts`; component prop
  types reject `constraintsOwner`/`pendingBriefProposal`/`tripBriefProposal`
  /`researchIntentDraft`/`chat_messages` at compile time.
- Missing capabilities render `UNAVAILABLE` markers; they are not
  replaced by other candidates or earlier runs.
- Expired offers show an inline destructive marker.
- Unknown `publicExplanationTokens` are silently dropped (no raw token
  in the DOM).
- Idempotent vote submission is deduped server-side.
- `NEEDS_CHANGES` blocks transition to ACTIVE; the card continues to
  show vote controls; no booking control is present.

**Coverage:** `apps/web/src/components/trips/shared-plan/plan-proposal-card.test.tsx`,
`plan-version-trail.tsx`, `team-constraints-panel.tsx`.

---

## 已批准、待实施：规划器韧性与有界反思

**实施契约：** [规划器韧性与有界反思实施规范](planner-resilience-and-reflection-implementation.md)
**Stories:** `docs/backlog.md` S2 §7–§9

### TS-PLANNER-RESILIENCE-1 — 门禁分离：一格不可用不终结整轮

**Objective:** Verify an attempted-but-unavailable capability degrades to a
recorded gap while a never-searched cell stays a hard failure.

**Starting conditions:** A trip with two departure cities and two destination
candidates, all four flight cells resolvable to controlled airports. A
test-only flight provider double returns `LIVE` for three cells and
`UNAVAILABLE / UPSTREAM_FAILURE` for the fourth.

**Steps:**

1. Run a `PROPOSE_PLAN` task to completion.
2. Read `itinerary_plans`, `planning_research_results` and `agent_task_runs`.
3. Re-run with the provider double returning `LIVE` for three cells and never
   being called for the fourth (simulating a tool loop that skipped it).

**Expected outcomes:**

- Run 1 persists a `PROPOSED` plan; `planning_research_results.status =
  COMPLETED_WITH_GAPS` with exactly one `{capability:"flight",
  code:"UPSTREAM_FAILURE", destinationId}` gap; task status
  `COMPLETED_WITH_GAPS`; `result_plan_id` is the new plan.
- Run 2 fails with `FlightResearchIncompleteError` → `error_code =
  PLANNING_DATA_UNAVAILABLE`, `retryable = false`, and writes no plan row.
- `planning_gate_total{gate="research_completeness"}` records both outcomes.

### TS-PLANNER-RESILIENCE-2 — 零商业证据的目的地只产出 research summary

**Objective:** Verify a destination with no live commercial evidence yields a
summary that carries no booking authority.

**Starting conditions:** All flight cells for the recommended destination
return `UNAVAILABLE`; accommodation discovery returns `LIVE`.

**Steps:**

1. Run a `PROPOSE_PLAN` task to completion.
2. Attempt an adoption vote against the run's result.
3. Attempt a confirmation and a booking-sandbox submission.

**Expected outcomes:**

- No `itinerary_plans` row is written for this run; no existing plan changes
  status.
- `planning_research_results` holds `status = COMPLETED_WITH_GAPS` and
  `result_plan_id = NULL`; `agent_task_runs.status = COMPLETED_WITH_GAPS`
  with `error_code = NULL`.
- `provider_offers` / `source_evidence` gathered during the run are still
  persisted — the run found real things and must not discard them.
- Adoption, confirmation and booking all refuse: there is no `PROPOSED` plan
  to act on. No path turns a research summary into bookable state.
- `GET /trips/:tripId/research/latest` returns the summary with its gaps to
  every active member; the web renders the `resultPlanId === null` branch and
  never the generic failure copy.

### TS-PLANNER-RESILIENCE-3 — Provider 重试与配额语义

**Objective:** Verify transient failures retry once, quota failures use their
own clock, and deterministic failures never retry.

**Steps:**

1. Provider double fails once with `UPSTREAM_TIMEOUT`, then returns `LIVE`.
2. Provider double returns `RATE_LIMITED`.
3. Provider double returns `NO_RESULTS`.
4. Cancel the task (or expire its lease) while a provider call is in flight.

**Expected outcomes:**

- Case 1 returns `LIVE` after exactly one retry;
  `provider_retry_total{outcome="recovered"}` +1.
- Case 2 waits `rateLimitedMs` (not exponential backoff) before its retry and
  counts against `maxAttempts`.
- Case 3 performs no retry.
- Case 4 performs no retry: cancellation and lease loss are not capability
  unavailability.

### TS-PLANNER-RESILIENCE-4 — 有写副作用的 Skill 不可声明 retry

**Objective:** Verify the registration-time invariant.

**Steps:** Register a skill declaring `retry` whose `allowedTools` contains a
write scope (`plan:write:propose`, `bookings`, place adoption).

**Expected outcomes:** `registerSkill` throws `SkillError("POLICY_DENIED")`.
`places.adopt` remains registered without a retry policy. Read-only search
skills register normally.

### TS-PLANNER-RESILIENCE-5 — 任务重试续期，但有生命周期上限

**Steps:**

1. Force a retryable failure on a task whose `expires_at` is close.
2. Force repeated retryable failures past `AGENT_TASK_MAX_LIFETIME_SECONDS`.

**Expected outcomes:**

- Case 1 requeues with `expires_at` extended; the reaper does not mark it
  `EXPIRED` before the next attempt runs.
- Case 2 never extends `expires_at` beyond `created_at +
  maxLifetimeSeconds`; the task terminates instead of being renewed forever.

### TS-PLANNER-RESILIENCE-7 — 模型预算可配置，超时不被误报为上游故障

**Objective:** Regression for the 2026-09-05 incident where a turn whose pure
model time reached the hard-coded 15s budget was aborted, reported as
`UPSTREAM_FAILURE`, and then retried three more times against the already
aborted signal.

**Steps:**

1. Set `CONVERSATION_MODEL_BUDGET_MS` and submit a turn whose model call
   outlasts it. Repeat with the variable unset.
2. Set the variable outside `5000..90000`.
3. Inspect the `llm` runtime event and the provider call count for the
   aborted turn.

**Expected outcomes:**

- The Skill's `timeoutMs` follows `CONVERSATION_MODEL_BUDGET_MS`; unset it and
  the budget is 30000ms. Raising it requires no code change.
- An out-of-range value fails at boot with the variable named, in line with
  every other `positiveInteger` setting.
- A turn cut by this budget records `errorCode: "TIMEOUT"`, **not**
  `UPSTREAM_FAILURE` — the SDK reports its own `Error("Request was aborted.")`
  whose `name` is not `AbortError`, so classification must come from the
  signal, not the message.
- The provider is called exactly once for that turn: an aborted signal stops
  the retry loop instead of burning the remaining attempts and their backoff.
- The traveller still receives the `FALLBACK` notice; nothing throws to the
  SSE channel.
- Model budget + tool budget stay below `CONVERSATION_TURN_HARD_CAP_MS`, so
  the budget fires before the cap does.

### TS-PROVIDER-4XX — 供应商拒绝请求不再被报成供应商故障

**Objective:** Regression for the 2026-09-05 trip whose shared plan never
appeared. SerpApi answered `400` on every flight search; the adapter reported
`UPSTREAM_FAILURE` and discarded the response body unread, so nothing in the
logs could say which parameter it objected to.

**Steps:**

1. Make each flight/hotel provider answer `400` with a JSON body carrying an
   `error` message; repeat with `404`, `401`, `429` and `503`.
2. Answer `400` with a body that echoes the request URL, API key included.
3. Inspect the resulting gap code, the metric label and the log line.

**Expected outcomes:**

- `4xx` other than `401`/`403`/`429` maps to `PROVIDER_REQUEST_REJECTED`, not
  `UPSTREAM_FAILURE`: the supplier understood the request and refused it, which
  is our parameters and not its health. `401`/`403` stay
  `PROVIDER_NOT_APPROVED`, `429` stays `RATE_LIMITED`, `5xx` stays
  `UPSTREAM_FAILURE`.
- The supplier's own message is logged once, so an operator can see which field
  was rejected without reproducing the call.
- That log never carries a credential: an echoed `api_key` / `token` /
  `access_token` / `key` value is redacted and the message is truncated.
- `PROVIDER_REQUEST_REJECTED` is accepted end to end — the API Zod contract, the
  Web mirror, the bounded metric label and the service-gap payload — so the new
  value never blanks a surface through a failed response parse.

### TS-GAP-ATTRIBUTION — 我们自己的失败不得报成供应商故障

**Objective:** 同一趟 trip 的第二层问题。就算输出契约都对齐了，下一次任何
schema 收紧仍会以同样的方式说谎：编排层的 `classifyError` 按错误**文本**分类、
兜底 `UPSTREAM_FAILURE`，且整个 catch 不记日志。

**Steps:**

1. 让一个能力抛出 `OUTPUT_INVALID` / `INPUT_INVALID` / `SCHEMA_PARSE` /
   `SKILL_VERSION_MISMATCH`。
2. 抛出一个 `POLICY_DENIED`，但把 "upstream"、"timeout"、"rate" 都塞进它的
   message。
3. 抛出真正的 `NETWORK` / `UPSTREAM_5XX` / `UPSTREAM_FAILURE`。
4. 抛出一个非 `SkillError` 的普通 `Error`。
5. 让持久化、Web 契约镜像与详情页文案表分别接收 `SKILL_CONTRACT_VIOLATION`
   与 `places` / `readiness` 能力。

**Expected outcomes:**

- 契约类错误映射为 `SKILL_CONTRACT_VIOLATION`，界面文案明确说明「不是服务提供方的
  问题、重试无效」，不出现任何指向供应商健康度的措辞。
- 分类按 `SkillError.code` 而不是 message：带误导性关键词的 `POLICY_DENIED`
  仍映射为 `SEARCH_CONSTRAINTS_INCOMPLETE`。
- 真实上游故障仍映射为 `UPSTREAM_FAILURE`；非 `SkillError` 保留子串兜底。
- `SKILL_CONTRACT_VIOLATION` 端到端可用：服务端 `serviceGapSchema` 落库、
  Web 镜像 enum 解析、详情页有本地化文案。Web 的能力镜像必须与
  `ServiceCapability` 逐项一致——缺 `places` / `readiness` 会让携带该能力的响应
  解析失败，把整页变成一句「出错了，请重试」。
- 每一次能力失败在 worker 日志里留下一条受控诊断（能力/skill 名、类型码、
  attempt、耗时），且不含异常消息原文。
- 跨源可读性：`x-correlation-id` 在 CORS `exposedHeaders` 中，界面「技术详情」
  不再恒为 `null`。
- Web 的 `researchResultSchema` 能解析服务端**实际**发送的整个 DTO，包括恒定
  存在的 `offers` 数组。该 schema 是 `.strict()`，少一个字段就会让两个 research
  端点的每一个响应解析失败——gaps 面板丢掉能力清单，详情页整页报错。回归用例
  直接用 trip `8a634324` 的真实 payload。

### TS-SKILL-OUTPUT-CONTRACT — Skill 输出上界必须容纳 provider 的合法输出

**Objective:** Regression for the same 2026-09-05 trip as `TS-PROVIDER-4XX`.
`accommodation` 与 `places` 两个能力的 `provider_search_runs` 都是 `LIVE`，
`provider_offers` 里落了 16 条真实住宿，而共享方案面告诉成员「服务提供方暂时
不可用」。原因不在供应商：skill handler 跑完并落库之后，skill registry 的
输出校验拒绝了它自己的结果，异常被编排层的 catch 归类成 provider 故障。

**Steps:**

1. 让 accommodation provider 返回 OpenTripMap 文化遗产波段的 `rate`（5/6/7），
   经 `accommodation.discover` 的输出契约解析。
2. 让 place provider 返回其上界 10 条候选，调用 `places.search`。
3. 核对每个 shared skill 的输出数组上界与其 provider 的结果上界。

**Expected outcomes:**

- 遗产波段评级通过输出校验：`popularityTier` 的域是 1..7（上游 `0` 已在
  provider 内映射为 `null`），不是 1..3。
- `places.search` 返回恰好 `PLACE_SEARCH_MAX_RESULTS`（5）条候选，收口发生在
  服务端而不是某一个 provider 内，因此换 provider 不会重新打开这个缺口。
- 收口发生在持久化之后：`provider_search_runs` 仍然记录供应商实际的
  `LIVE` 结果与空 `errorCode`。
- 逐条核对留痕：activities `limit:5` 对 `.max(5)`、hotel provider 10 对
  `.max(10)`、accommodation `RESULT_LIMIT=20` 对 `.max(20)` 均一致，
  places 是唯一错位的一处。

### TS-PLANNER-RESILIENCE-6 — 慢 provider 不再被报成模型故障

**Objective:** Regression for `docs/shared-agent-findings.md` #32.

**Starting conditions:** A private thread turn that triggers a hotel search;
the hotel provider double sleeps long enough to exhaust the tool budget while
the model budget remains available.

**Expected outcomes:**

- The search result is persisted in `personal_research_evidence` as today.
- Further tool calls in the same turn return `UNAVAILABLE /
  UPSTREAM_TIMEOUT`; the turn is not aborted.
- The model still generates its reply inside its own budget.
- If the model call itself fails while evidence exists, the persisted
  ASSISTANT message renders the stored evidence (capability, count, provider,
  `captured_at`) from a deterministic template and never says the model was
  unreachable. The template contains no model-generated text and no field
  that was not captured.
- `conversation_budget_exhausted_total{budget="tool"}` +1.

### TS-PLANNER-RESILIENCE-7 — 有界 repair

**Steps:**

1. Force the plan output validator to fail once, then accept.
2. Force it to fail more times than `MODEL_GATEWAY_PLAN_REPAIR_BUDGET`.
3. Force a `CommercialAuthorityMissingError`.

**Expected outcomes:**

- Case 1 succeeds after one repair; `plan_repair_total{outcome="repaired"}`
  +1; the tool-turn counter is unchanged by the repair iteration.
- Case 2 throws the original error unchanged; `outcome="exhausted"`.
- Case 3 produces no critique and no repair — it takes the research-summary
  branch of TS-PLANNER-RESILIENCE-2.
- Repair never activates a plan, relaxes a HARD constraint, or changes a gate
  outcome.

### TS-PLANNER-RESILIENCE-8 — critique 的隐私边界

**Objective:** Verify the critique returned to the model discloses nothing
beyond stable codes and field paths.

**Steps:** Trigger each `PlanCritiqueCode` with a snapshot containing
recognizable confidential constraint values and a model output containing
recognizable invented values.

**Expected outcomes:**

- The rendered critique message contains no snapshot value, no
  `ORCHESTRATOR_CONFIDENTIAL` content, no model-authored value and no
  provider raw payload — only stable codes, field paths and fixed templates.
- An error that cannot be safely reduced yields `null` and is rethrown rather
  than being paraphrased into the prompt.
- Nothing from the critique reaches audit summaries, metric labels or trace
  attributes.

**Coverage（待实施）:** `apps/api/tests/planning-gates.test.ts`,
`apps/api/tests/resilience-policy.test.ts`,
`apps/api/tests/plan-critique.test.ts`,
`apps/api/tests/conversation-turn-budget.test.ts`,
`apps/web/src/components/explore/travel-agent-chat.test.tsx`.

### TS-OFFER-CUE-1 — Flight / Hotel 采用 Cue 仅在真实选择时触发

**Starting conditions:** A DRAFT Trip creator owns a private thread with an already rendered, unexpired Flight or Hotel offer set. Each item has a server-issued opaque candidate reference; no provider offer ID is present in the browser DTO.

**Steps:**

1. Send explicit and strong selections: `第二班吧`、`最便宜的直飞就它`、`就住第一家`、`带免费取消的那家最合适，就它`.
2. Send detail, comparison, neutral-positive, rejection and search-again messages: `第一班几点到？`、`A 和 B 哪个好？`、`这家不错`、`不要这家`、`换便宜一点的`.
3. Send `订这个航班` and `订这家酒店`.
4. Repeat a message with an unresolved pronoun or a candidate from another/superseded result set.

**Expected outcomes:**

- The Flight and Hotel models, not keyword/regex fast paths, determine selection intent from the current USER message plus only the bounded eligible candidate set.
- Only unique explicit/strong selections create the respective confirmation card. Detail, comparison, neutral-positive, rejection, re-search and unresolved messages create none.
- `订` creates a non-booking selection confirmation only; no provider order, payment, redirect, Plan activation or booking authority is created.
- A model timeout/invalid output suppresses the Cue and leaves normal conversation unaffected. No user text, hotel/flight name, price, raw provider payload or provider ID appears in logs, metrics or browser persistence.

### TS-OFFER-CUE-2 — 采用状态、并发、过期与提示疲劳

**Steps:**

1. Accept a valid Flight candidate, then accept another candidate for the same route key; repeat for a Hotel candidate with the same stay key.
2. Double-submit accept/dismiss with one `requestId`; submit a stale `expectedVersion`; attempt an action from another owner/thread.
3. Expire or supersede an offer set before accept; refresh the page while a Cue remains OPEN.
4. Dismiss three Flight cues in one owner-local day, then trigger a Hotel cue; repeat an explicit Flight selection inside Flight cooldown.

**Expected outcomes:**

- Exactly one ACTIVE owner-only selection exists per `(trip, owner, capability, routeKey/stayKey)`; replacement supersedes the earlier selection atomically. No Personal selection enters a Shared snapshot, plan, confirmation or booking path.
- Duplicate actions are idempotent; stale, cross-owner/thread, expired and superseded actions fail closed. REST recovery restores the same OPEN cue after refresh.
- Flight and Hotel cooldown/daily counters are independent. Three Flight dismissals mute Flight only until the owner's local midnight; a model-classified explicit Flight choice may bypass mute but still cannot accept an expired or unowned candidate.
