# AI Travel Agent — Personal Agents + Shared Trips 测试场景

**对应：** [Backlog](backlog.md) · [PRD](PRD.md)  
**范围：** 三个虚构用户、两个出发地、两到三个固定目的地候选、至少两种国籍、带来源的航班/酒店/地面交通工具、booking sandbox；不使用真实护照、支付资料或真实签证申请。产品运行时 live API 失败必须返回 `UNAVAILABLE`，不得使用 fixture fallback。

## Fixture

- Alice Profile：艺术兴趣、喜欢市中心、拒绝红眼航班；
- Bob Profile：预算上限、较重舒适度；Bob 可选择是否共享国籍资料；
- Chen Profile：第二出发地、有限出发时间与本次偏好；Chen 可选择是否共享国籍资料；
- 两个出发地、两到三个固定目的地候选、至少两国籍 readiness 规则与官方来源/检查时间；
- 测试专用 Flight、Stay、Ground 成功、缺失和失败 doubles；
- 航班涨价/售罄、成员日期/出发地变化、visa 来源不确定 fixture；
- sandbox orchestration 成功、失败、重复及乱序回调。

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

**Starting conditions:** A test-only FlightProvider double and an Amadeus adapter contract fixture cover configured Hero routes, dates and provider failures. Runtime paths never import these fixtures.

**Steps:**

1. Search the same supported origin, destination and date range twice under a snapshot ID.
2. Inspect source, capture time, price and normalized route fields.
3. Search a date range that excludes the configured departure.
4. Search an unsupported route.

**Expected outcomes:**

- Test-only supported searches return deterministic normalized offers; production adapter responses carry their real source, capture time and expiry.
- Results outside the requested date range are excluded.
- Unsupported searches return no offers and never fabricate inventory or price.

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
6. Inspect task rows, messages, idempotency records, audit, logs, traces and metric labels.

**Expected outcomes:**

- The command endpoint accepts the existing authenticated conversation request DTO and returns `202`; a separate authenticated `fetch` SSE observer receives live events. No native `EventSource` authorization workaround or WebSocket is required.
- The stream response itself carries the negotiated cross-origin headers and `x-correlation-id`. A browser observer on an allowed origin renders incremental deltas; it must not fall back to polling the run and revealing the whole answer at once.
- Event order for a connected observer is `turn.started` → zero or more safe progress/text events → exactly one terminal `turn.completed`, `turn.cancelled`, `turn.stale` or `turn.failed`; no event exposes prompt text, chain-of-thought, raw provider payload, unvalidated token or unapproved data.
- `COMPLETED` persists exactly one USER and one final-policy-approved ASSISTANT message atomically and is replayable by request ID.
- Browser/SSE disconnect does not cancel the run. Explicit Stop produces `CANCELLED`; terminal failure preserves the submitted USER message exactly once, persists no partial ASSISTANT body, and exposes only a safe terminal code/status.
- Concurrent Workers cannot both commit a result: lease expiry/recovery may repeat an external model call, but final persistence is conditional on the current lease token and task state. A concurrent request ID cannot duplicate the USER message or create a second task.
- Text, prompts, chunks and model payloads are absent from audit summaries, logs, traces and metric labels.

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
6. 在全球、区域和本地缩放级别，确认国家、省/州和城市按层级显示；分别关闭三个图层。
7. 打开一个地点抽屉后，确认三个图层开关仍可见并可操作。
8. 点击国家、城市或省/州名称，再点击空白地图位置。
9. 从全球缩放逐步放大到区域缩放，检查陆地与海洋材质和地图标签。
10. 在未登录、未配置 Cognito 的浏览器会话中点击一个陆地点，并连续提交超过 30 次同一地点参考请求。

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
- 多个私有灵感在缩放和移动地图时保持绑定各自归一后的经纬坐标；管理器默认不打开、不预选标记，单独删除只移除目标标记，批量删除只移除已勾选标记。
- `Within 50 km` 明确表示以所选图钉为中心的 50 km 半径，不得把距离范围伪装为城市边界。离线位置参考仅能来自版本化、来源化的专用 resolver；不得从地图 tile、地图标签、Natural Earth SVG overlay 或模型推断。
- 原型刷新后临时标记消失；生产实现必须将任何持久化操作交由服务端授权模型处理。
- 国家、省/州、城市名称按与点击粒度相同的 zoom band 分层显示。点击名称或其周边地图区域都创建该层级的会话内私有灵感，不会创建共享约束、方案、价格、库存、签证或预订结论。
- 如果配置的 style 缺少兼容的 OpenMapTiles source 或缺失任一必需图层，行政区/城市开关**保持可见但被禁用**，附 `role="status"` caption 说明缺失项（缺 source 或 `missing layers:` 列表）；地图保留原有候选入口和故障回退；不静默隐藏，不报错或伪造地图数据。开发者可在 dev 模式下通过 `window.__wanderlyMap.readiness` 观察 5 种 readiness（loading / ready-supported / ready-style-unsupported-source / ready-style-missing-layers / unavailable-network）。
- 地图就绪生命周期分两阶段（mounting → ready）：MapLibre 6.6 的 globe projection 必须写入传给 `new Map()` 的 style JSON，`style.load` 是 style 兼容性检查和图层控件的唯一就绪前置；不得在 style 创建前或 `style.load` 后调用 `setProjection()`。OpenMapTiles 的 `sourcedata` 只作为开发诊断，慢 TileJSON 或 PBF 不得触发 `unavailable-network`。只有 style 总超时、初始化异常或 style ready 前的 map error 才显示 globe error 回退。dev 模式下 `window.__wanderlyMap.stage` 实时反映当前阶段。
- 地图 ready 后，国家边界位于 provider style stack 顶层：即使 Liberty 的 fill/road layer 重排，全球缩放仍可看到本地 Natural Earth 共享 mesh 与独立九段线。关闭 Countries 时必须同时隐藏国家线、九段线与洲/国家名称；zoom 2.6 起显示首都、zoom 2.8 起显示重要城市、zoom 4.2 起显示省州名称。SVG 标签必须在 MapLibre `render` 帧内同步重投影并随 resize 更新，平移或缩放时不得落后 WebGL 地球（标签位置只能直接写入 DOM，不得经由 React state 提交，否则会慢一帧并出现漂移）；必须剔除背半球并进行屏幕碰撞去重；已离开候选集但尚未卸载的标签节点必须当帧隐藏，不得停留在过期位置。切换对应图层后标签即时消失。视觉边界和标签不参与地点匹配、反向地理编码或旅行事实；位置参考只能使用专用、版本化的离线 resolver 数据。
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
- `AUTH_MODE` 默认必须为 `cognito`。显式 `local-dev`（固定单用户）和 `custom-local`（数据库用户名/密码、多用户）仅允许 `NODE_ENV=development|test`、loopback server 绑定、loopback socket 客户端和 `LOCAL_DEV_ALLOWED_ORIGINS` 中的精确 loopback HTTP Origin；`custom-local` 还必须有至少 32 字符的 API `JWT_SECRET`。production、staging、缺失环境或任一非 loopback 边界必须拒绝启动/请求。浏览器不能发送 fake token/user ID；`local-dev` 的固定身份和 `custom-local` 的已验证 JWT 身份都须通过原 owner-only thread 授权。非允许 Origin 不得获得 CORS 读权限，且对受保护写操作必须返回 `403` 并不创建业务状态；允许 Origin 的 `OPTIONS` 预检必须返回 `204`、正确的 CORS header 和可解析的 `traceparent`，且不触发认证。
- Home 覆盖 Profile/Trip 的 loading、empty、error、unauthorized 与 `Demo data` 状态，不混入其他用户数据或未确认的 plan/action 字段。
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
6. Send an allowed-origin `OPTIONS` CORS preflight and confirm it returns `204` with an allow-origin header and a parseable, freshly minted `traceparent`; it must not emit a tracing error or enter authentication.

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

### TS-EXPLORE-TRIP-1 — Create a Draft Trip only on first submitted exploration message

**Stories:** H1a, H1, S1
**Objective:** Verify Explore creates no empty archive records, creates exactly one owner-only Draft Trip when the user first sends a message, and preserves the agreed browser lifecycle.

**Starting conditions:** Alice is authenticated and has zero or more historical Trip records; API exposes the exploration start endpoint and the normal durable conversation endpoint.

**Steps:**

1. Open `/home`, browse the map, click several locations, open and close chat, then inspect `shared_trips`, `chat_threads`, idempotency and audit rows.
2. Submit the first message. Force a client retry, a double-click and two concurrent start requests with the same start request ID; then accept the first conversation turn.
3. Simulate start success followed by turn rejection/network loss; retry the start and the conversation command.
4. Navigate client-side `/home → /projects → /profile → /home`; submit another message. Then perform a full browser reload and open `/home` in a new tab before submitting messages there.
5. Open the Draft from `/projects`; verify it uses the same project workspace as a `PLANNING` trip, retains the private thread, and does not show a separate brief form. Confirm a complete brief in the private conversation, then use the workspace activation control.
6. Attempt invitation, consent, planning, confirmation and booking both before and after activation.
7. Repeat with Alice logged out and Bob logged in before returning to `/home`.

**Expected outcomes:**

- Before the first submitted message, no Trip, thread, idempotency or audit row is created; map input is not persisted as a business fact.
- One start request ID yields exactly one `DRAFT` Trip, one creator membership and one owner-only default `TRIP` thread, even under concurrent retry. Audit summaries contain IDs/status only, never the question or map data.
- The first task derives the created thread's `trip_id`; start success plus turn failure/retry cannot create another Trip.
- Client-side route changes preserve the same in-memory Trip/thread. Reloads, new tabs and post-logout sessions have no old in-memory context and create a distinct Trip only upon their first submitted message.
- `Start new exploration` does not delete, archive or mutate the old Trip. Historical Trips are restored only through an explicit project route.
- Draft commands for invitation, consent, snapshot/planning/replan, confirmation and booking return `409 TRIP_NOT_ACTIVE` without side effects. A Draft opens the same workspace as a `PLANNING` trip; only its creator sees the workspace activation control, which remains disabled until the persisted brief is complete. A creator's valid explicit activation changes status to `PLANNING`, after which the normal collaboration path works.

### TS-EXPLORE-TRIP-2 — Derive a trip title from explicit brief fields only

**Stories:** H1, H2
**Objective:** Verify title generation is deterministic, localized and independent of private conversation text.

**Starting conditions:** Alice owns a Draft Trip and has sent private messages containing destinations or dates that differ from the explicit activation brief.

**Steps:**

1. Activate with two destinations, `2026-10-01` through `2026-10-07`, and `titleLocale: en`.
2. Activate another Draft with a Chinese locale and destinations but no complete date range.
3. Submit an invalid or reverse date range.
4. As Bob, attempt `PATCH /trips/:tripId/title`; then rename as Alice and inspect audit data.

**Expected outcomes:**

- The first title is `Tokyo · Bangkok Trip Planner｜7 Days`; the Chinese title uses `行程规划` and no day suffix when dates are incomplete.
- The title never reflects private chat text, profiles or inferred facts, and no LLM call is made.
- Invalid calendar dates and reverse ranges are rejected; no title is fabricated from them.
- Only the creator may manually rename. The change sets `name_source=MANUAL`; the audit event records the source but never title text.
- Bob cannot submit through, view, or restore Alice's old session identifiers.

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

**Expected outcomes:**

- The HTTP command returns `202` with a run ID; browser disconnect does not cancel it. Trip members can read, subscribe and cancel the run; non-members cannot. Private conversation runs remain owner-only.
- Only same-task, same-snapshot `LIVE` evidence fills a matrix cell. Wrong-task/wrong-snapshot evidence and `UNAVAILABLE` never satisfy coverage.
- The model receives only normalized Tool output. It cannot select arbitrary tools, snapshots, providers, airports, dates, passengers, cabin or currency; raw Amadeus payloads, OAuth values and private snapshot data never leave the server boundary.
- Final model synthesis and the atomic plan/task completion transaction are rejected unless the full matrix is live, the task is still `RUNNING` with its lease, and the accepted preference version is still current. Repeated or late finalization cannot activate a second plan.
- Provider/model transient failures may retry according to Worker policy. Policy, schema, preference-stale, cancellation, matrix and bounded-tool-loop failures are terminal and create no active plan.

- A DRAFT-trip private-chat turn may emit only an in-memory destination/days candidate; raw conversation content is never included in the event, audit summary, or client persistence.
- The creator must explicitly confirm the candidate. Confirmation updates the DRAFT brief and AUTO title; ignoring it performs no write.
- A non-creator and a trip no longer in `DRAFT` receive `403` and `409` respectively; a MANUAL title remains unchanged after confirmation.

### TS-HOTEL-TOOL-1 — Snapshot-bound hotel search, comparison and safe gaps

**Stories:** H3, H5, S1
**Objective:** Verify that only the Shared PLAN/REPLAN Worker can obtain live hotel evidence and that the result is safe for comparison but never becomes a booking action.

**Steps:**

1. In a private conversation, let the model ask for missing room count, adults per room and currency. Confirm the resulting stay-search-preferences proposal as the trip owner; repeat without confirmation and with a non-member.
2. Create a snapshot with two candidates and a confirmed preference version. Drive the Worker with a model double that calls `hotel.search` once for each `destinationId`.
3. Attempt tool arguments containing dates, room count, adults, currency, price, provider, address, coordinate, URL, snapshot ID and a cross-run destination. Repeat with a stale preference version, lost lease and duplicate tool call.
4. Return normalized LIVE offers carrying total/per-night prices and `INCLUDED`, `PARTIAL`, then `UNKNOWN` taxes/fees; inspect the plan DTO, `provider_search_runs`, `provider_offers`, source evidence and telemetry/audit output.
5. Force `NOT_CONFIGURED`, `NO_RESULTS`, 429, timeout, 5xx, malformed supplier payload and expired offer outcomes. Change dates, occupancy, stay preference and consent after a live plan exists.

**Expected outcomes:**

- The model can ask only to create a user-confirmed structured preference; no private message directly writes preference, invokes supplier search or starts planning.
- `hotel.search` accepts only a current task's allowed `destinationId`; all supplier parameters are server-derived. It is unavailable to Personal/Review agents and exposes no raw payload, URL, supplier credentials, rate ID, address or location coordinates.
- LIVE rows are bound to the current snapshot/run and exact normalized evidence; the validator rejects fabricated, stale, expired or cross-run hotel offers. A duplicate call does not create a second supplier query/evidence row.
- Every hotel card includes total price, per-night price, source, captured time and expiry. `PARTIAL` and `UNKNOWN` taxes/fees always display “可能另计”; only explicit `INCLUDED` is presented as included.
- Failure or missing data creates only a `hotel` `RESEARCH_UNAVAILABLE`/`COMPLETED_WITH_GAPS` result. Sandbox fixtures are never used at runtime; no supplier order, payment, redirect or booking link is created or persisted.
- Date, occupancy, preference, consent and offer-expiry changes stale dependent plan/confirmations and enqueue a new run. Audit, logs, metrics and traces contain no user input, price, property, supplier URL or high-cardinality identifiers.

### TS-ACTIVITIES-TOOL-1 — Durable Shared activities research and guarded plan finalization

**Stories:** H3, H5, S1
**Objective:** Verify that only the Shared PLAN/REPLAN Worker can ground a plan with live, task-bound activities evidence, and that flight + activities stages are independently schedulable.

**Steps:**

1. Confirm activity search preferences, create a trip snapshot with two controlled origins and two destination candidates, then accept a `PLAN` command.
2. Configure the task scheduler to enable both flight and activities sub-stages; drive the Worker with a deterministic model double that requests `activities.search` for every destination candidate independently of any flight call.
3. Verify each Tool request against the task snapshot, controlled destination list and accepted preference version; reject browser/model coordinates, free-text query, provider URL/session ID and a theme outside the fixed allow-list.
4. Inspect only normalized Shared `provider_search_runs` rows with `category='activity'`; assert Tool output and persistence contain neither raw MCP payload, `clickOffToLander`/booking link nor currency-less `fromPrice`.
5. Repeat with an unknown Tool, malformed arguments, a wrong snapshot/destination, an `UNAVAILABLE` provider result, a changed preference version, cancellation, a lost lease, MCP schema drift and a Viator MCP 429.
6. Disable the activities sub-stage via configuration while keeping the flight sub-stage enabled; verify it does not schedule activities research. With the sub-stage enabled but unavailable, verify a safe `COMPLETED_WITH_GAPS` research result is displayed without any activity evidence or booking authority.

**Expected outcomes:**

- The HTTP command returns `202` with a run ID; browser disconnect does not cancel it.
- Only same-task, same-snapshot `LIVE` activities data becomes evidence. A same-task `UNAVAILABLE` row satisfies the required-attempt matrix but becomes a bounded service gap; wrong-task/wrong-snapshot rows and `MISSING` never satisfy coverage.
- The model receives only normalized Tool output. It cannot select arbitrary tools, snapshots, providers, destination coordinates, free-text searches, dates or themes; raw MCP payloads, session IDs, currency-less prices, click-off links and private snapshot data never leave the server boundary.
- A Viator MCP 429 returns bounded `RATE_LIMITED` immediately and does not retry without a provider reset window. Activities and Amadeus Flight have independent credentials/configuration and failure domains.
- Final atomic plan/task completion is rejected when any activities cell is `MISSING`, the task has lost its `RUNNING` lease, or the accepted preference version changed. An `UNAVAILABLE` cell persists only a safe `COMPLETED_WITH_GAPS` summary with service/candidate/reason codes; it never creates an activity offer or source evidence.
- Flight and activities evidence are distinct categories with independent staleness triggers and application-controlled freshness expiry; the unavailable summary is not evidence and cannot be selected by a plan.
- Provider/model transient failures may retry according to Worker policy. Policy, schema, preference-stale, cancellation, `MISSING` matrix and bounded-tool-loop failures are terminal; a bounded provider `UNAVAILABLE` result is a non-commercial gap, not invented evidence.
- An activities offer whose `expires_at` has passed causes the dependent plan to enter `STALE` independent of any flight offer expiry.

### TS-ACTIVITIES-TOOL-2 — Personal Agent activities search with owner-scoped evidence

**Stories:** H1, H3
**Objective:** Verify that a Personal Agent can request `activities.search` only after the Personal feature flag and tool-loop boundary are enabled, and that results stay owner-scoped and invisible to Shared execution.

**Steps:**

1. As a single authenticated user, save a profile with budget, pace and interests; then save a trip-scoped override for `this trip`.
2. Open a private conversation bound to a trip; submit a question that prompts the model to call `activities.search`.
3. Verify the request carries a server-built `PersonalActivitiesSearchContext` (not a snapshot) from the authenticated owner, thread and bound trip; browser/model `ownerUserId`, trip ID, coordinates, radius and free-text destination are rejected.
4. Inspect `personal_provider_search_runs` rows: owner and trip are set, no snapshot exists, and the output/persistence omit `bookingLink`.
5. Submit a Shared PLAN/REPLAN command and verify neither Personal conversation text nor Personal evidence is present in its context, matrix or plan validation inputs.
6. Submit a wrinkle: revoked override, deleted profile field, malformed request, unknown destination, `UNAVAILABLE` provider result, repeated request.

**Expected outcomes:**

- This scenario remains disabled until the Personal streaming tool-loop and owner-scoped evidence store are implemented. Enabling Shared `activities.search` alone must not register the Tool for Personal Agent.
- `personal_provider_search_runs` records the run separately; every Shared repository, context builder, matrix and validator rejects these rows and Personal conversation text.
- The Personal Agent's evidence does not directly modify `itinerary_plans`, `constraint_snapshots`, or trigger any `STALE` transition on existing plans.
- A subsequent Shared planning run cannot reference conversation text or a personal run row. Only an owner-confirmed, schema-valid Trip constraint may enter its server-built snapshot projection.
- Revoked override, deleted profile field, malformed request, unknown destination, disabled feature flag and unknown theme each fail closed with a stable error code; `UNAVAILABLE` runs are recorded only in Personal storage with the standard 8 unavailable reasons.
- Logs, trace attributes, metric labels and audit summaries never contain the personal conversation text, the owner profile field values or the activity names.

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
