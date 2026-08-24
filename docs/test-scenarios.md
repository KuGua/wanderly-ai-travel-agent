# AI Travel Agent — Personal Agents + Shared Trips 测试场景

**对应：** [Backlog](backlog.md) · [PRD](PRD.md)  
**范围：** 三个虚构用户、两个出发地、两到三个固定目的地候选、至少两种国籍、航班/酒店/地面交通 fixture 或带来源工具、booking sandbox；不使用真实护照、支付资料或真实签证申请。live API 失败时必须使用明确标识的 fixture fallback。

## Fixture

- Alice Profile：艺术兴趣、喜欢市中心、拒绝红眼航班；
- Bob Profile：预算上限、较重舒适度；Bob 可选择是否共享国籍资料；
- Chen Profile：第二出发地、有限出发时间与本次偏好；Chen 可选择是否共享国籍资料；
- 两个出发地、两到三个固定目的地候选、至少两国籍 readiness 规则与官方来源/检查时间；
- 每个候选的 Flight、Stay、Ground 成功、缺失和失败 fixture；
- 航班涨价/售罄、成员日期/出发地变化、visa 来源不确定 fixture；
- sandbox orchestration 成功、失败、重复及乱序回调。

## HERO 测试

### TS-H0 — Bootstrap demo identity and list only member trips

**Stories:** H1, H2, S1

**Objective:** Verify the frontend can select a safe seeded identity and load
only that identity's private Profile and trip memberships.

**Starting conditions:** Alice, Bob and Chen exist as seeded users; their trip
memberships overlap only where explicitly configured.

**Steps:**

1. Call `GET /api/v1/demo/users` without `X-Demo-User`.
2. Call `GET /api/v1/trips` separately as Alice, Bob and Chen.
3. Attempt to read an Alice-only trip as Bob.
4. Read and partially update Alice's Profile, omitting unchanged fields.
5. Submit an unknown Profile field, a `null` value, a missing/unknown
   `X-Demo-User`, and an unknown route.

**Expected outcomes:**

- Demo discovery returns exactly the three seeded UUID/`externalId`/`displayName`
  tuples and no private Profile fields.
- Each trip list contains only server-verified memberships, with stable order,
  stored route/date fields, server-derived `memberCount`, and the caller's role.
- Trip details expose safe member `displayName` but not other members' private
  Profile data; unrelated access is denied.
- Profile PUT preserves omitted fields, permits owner nationality edits, rejects
  `null`/unknown/server-owned fields, and generates `updatedAt` server-side.
- Every failure uses the normalized error body and a matching
  `x-correlation-id` header.

### TS-H3a — Return deterministic normalized flight fixtures

**Stories:** H3, P1
**Objective:** Verify the fixture-backed `FlightProvider` respects its normalized search contract without fabricating availability.

**Starting conditions:** Versioned Flight fixtures exist for configured Hero routes and dates.

**Steps:**

1. Search the same supported origin, destination and date range twice under a snapshot ID.
2. Inspect source, capture time, price and normalized route fields.
3. Search a date range that excludes the configured departure.
4. Search an unsupported route.

**Expected outcomes:**

- Repeated supported searches return identical offers.
- Every result is marked `Demo data` and carries the fixture capture time.
- Results outside the requested date range are excluded.
- Unsupported searches return no offers and never fabricate inventory or price.

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

**Starting conditions:** Both members have current consent; Flight/Stay/Ground fixtures available.

**Steps:**

1. Start Shared Agent planning with Alice and Bob at origin A and Chen at origin B.
2. Inspect input snapshot IDs for all three tools and destination candidates.
3. Review destination comparison, per-origin flight, hotel and ground results, sources/times/prices and linked constraints.
4. Disable Ground fixture/tool for one candidate.
5. Inspect the missing-service and labelled-fallback response.

**Expected outcomes:**

- All tools and candidates use the same consent/constraint snapshot.
- Two to three candidates show three services when data exists and explain authorized constraints only.
- Each fact has a source/time or `Demo data` label.
- Tool failure is explicit; no inventory or price is fabricated.

### TS-H4 — Create individualized visa readiness safely

**Stories:** H4, P1  
**Objective:** Verify nationality-specific readiness without legal claims or unauthorized inference.

**Starting conditions:** Alice authorizes nationality; Bob initially does not; Chen has separate consent; two to three candidate routes and official-source fixtures exist.

**Steps:**

1. Generate candidate comparison and readiness checklists.
2. Inspect Alice’s checklist source, checked time, applicable traveler, candidate route and next actions.
3. Inspect Bob’s result without nationality consent.
4. Bob grants nationality consent, then revoke it after list creation.
5. Load uncertain/expired visa-source fixture.

**Expected outcomes:**

- Each authorized traveler has a personal, sourced readiness checklist or explicit verification gap for every displayed candidate, not a visa approval statement.
- Bob sees a request to self-check until he authorizes data; system does not infer nationality.
- Grant/revoke creates/invalidates Bob’s checklist and expires affected plan.
- Uncertain source directs official verification and does not state a certain conclusion.

### TS-H5 — Re-plan after a flight shock

**Stories:** H5  
**Objective:** Validate self-correction while preserving consent and personal constraints.

**Starting conditions:** Current shared plan includes three members, two origins, destination candidates, fixtures and authorizations.

**Steps:**

1. Trigger one flight-price-increase/sold-out event or Chen’s departure constraint change.
2. Inspect new tool/consent snapshots and old-plan expiry.
3. Review old/new destination ranking, flight, stay, ground, constraints, visa impact and explanation.
4. Trigger same event ID again.
5. Trigger a no-feasible-alternative fixture.

**Expected outcomes:**

- One change creates one re-plan; duplicate is idempotent.
- UI identifies preserved and affected constraints for all three travelers and the changed candidate ranking.
- No automatic charge, booking or silent replacement occurs.
- No-feasible state names blocking constraints and returns members to editing/consent.

### TS-H6 — Confirm and run booking orchestration sandbox

**Stories:** H6  
**Objective:** Prove an Agent can prepare controlled action only after every required member approves.

**Starting conditions:** Current plan has all three services; sandbox configured.

**Steps:**

1. Alice and Bob confirm; Chen chooses `Needs changes`.
2. Attempt orchestration.
3. Chen confirms the current plan; inspect all three confirmations and no-charge disclosure.
4. Invoke sandbox; deliver success callback twice and a late failure callback.
5. Change a price and attempt to invoke using old confirmations.

**Expected outcomes:**

- One non-confirming member blocks orchestration, even when the other two have confirmed.
- Current, unanimous three-member confirmation displays service items, price/currency, sources and no-charge boundary.
- Sandbox returns a single set of reference IDs; duplicate/late callbacks do not duplicate action.
- Price change expires confirmations; stale plan cannot orchestrate.
- No payment is collected or claimed.

## PROOF 与 SUPPORT 测试

### TS-P1 — Run the three-minute Hero Demo deterministically

**Stories:** P2  
**Objective:** Verify the stated demo can run without manual data edits or unstable tools.

**Starting conditions:** Three seeded Profiles, two origins, two to three destination candidates, nationality rules, fixtures and shock event available.

**Steps:**

1. Run profile → invite two members → selective consent → candidate comparison → plan → visa → shock → re-plan + diff → three confirmations → sandbox.
2. Force one live tool unavailable.
3. Reset demo and rerun.

**Expected outcomes:**

- Entire flow completes in three minutes with fixed data.
- Fallback is visibly marked `Demo data`.
- Reset removes shared-trip session state, not seeded Profiles.

### TS-P2 — Explore a map location without fabricating travel facts

**Stories:** P1
**Objective:** 验证地图探索可收集用户兴趣，同时保持 fixture-first 和隐私边界。

**Starting conditions:** 地图显示两到三个 fixture 目的地，且存在没有候选数据的空白区域。

**Steps:**

1. 点击预置候选地点标记，并查看地点档案。
2. 点击地图空白区域，并查看临时探索标记和打开的档案。
3. 将空白区域标记保存为私有灵感，然后刷新页面。

**Expected outcomes:**

- 候选地点档案显示来源/时间或 `Demo data`，且解释只使用当前用户可见的资料。
- 空白区域档案明确没有可验证候选资料，不生成地点、价格、库存、签证或预订结论。
- 空白区域只能保存私有灵感或请求后续加入候选；不改变共享约束、方案或确认状态。
- 原型刷新后临时标记消失；生产实现必须将任何持久化操作交由服务端授权模型处理。

### TS-S1 — Protect data and trace the Agentic workflow

**Stories:** S1  
**Objective:** Verify profile privacy, event traceability and safe telemetry.

**Starting conditions:** Two profiles, one shared trip and a completed sandbox flow exist.

**Steps:**

1. Attempt cross-user reads/writes of unshared Profile and private history.
2. Inspect timeline for profile edit, consent, tool calls, visa, re-plan, approval and sandbox call.
3. Inspect logs, traces and metrics by correlation ID.
4. Search telemetry for private conversation text, document numbers, payment data and unapproved Profile values.

**Expected outcomes:**

- Cross-user private access is denied.
- Timeline has versions and correlation IDs for every sensitive decision.
- Metrics show required low-cardinality outcomes and trace errors safely.
- Prohibited data does not appear in telemetry.

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

- Profile memory is explicit, editable, deletable and private by default.
- Shared workspace never shows unapproved Profile/private-chat fields.
- Flight/Stay/Ground and Visa outputs use one consent snapshot and show source/time or demo label.
- Change event invalidates old plan and confirmations before replanning.
- All three required members must confirm before sandbox orchestration; no money moves.
- Missing consent, tool failure, visa uncertainty, member conflict, consent revocation and duplicate callback are tested.
