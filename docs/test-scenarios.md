# AI Travel Agent — Personal Agents + Shared Trips Test Scenarios

**对应：** [Backlog](backlog.md) · [PRD](PRD.md)  
**范围：** 两个虚构用户、两种国籍、固定国际路线、航班/酒店/地面交通 fixture 或带来源工具、booking sandbox；不使用真实护照、支付资料或真实签证申请。

## Fixtures

- Alice Profile：艺术兴趣、喜欢市中心、拒绝红眼航班；
- Bob Profile：预算上限、较重舒适度；Bob 可选择是否共享国籍资料；
- 固定路线、两国籍 readiness 规则与官方来源/检查时间；
- Flight、Stay、Ground 的成功、缺失和失败 fixture；
- 航班涨价/售罄、成员日期变化、visa 来源不确定 fixture；
- sandbox orchestration 成功、失败、重复及乱序回调。

## HERO tests

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

**Starting conditions:** Alice has a Profile and a new shared trip; Bob has a Profile.

**Steps:**

1. Alice invites Bob; Bob joins using the shared-trip flow.
2. Alice shares no-red-eye and art interest; Bob shares budget but declines nationality.
3. Open shared workspace as Alice and Bob.
4. Revoke Alice’s art-interest consent.
5. Attempt cross-user access to Bob’s unshared fields/private history.

**Expected outcomes:**

- No chat copy/paste/upload is required.
- Shared workspace exposes only approved fields with member/source labels.
- Consent revocation expires affected plan outputs.
- Unshared Profile/private history is inaccessible to other users and Shared Agent output.

### TS-H3 — Build an authorized flight, stay and ground plan

**Stories:** H3, P1  
**Objective:** Confirm multi-service orchestration uses one authorized snapshot and grounded tool evidence.

**Starting conditions:** Both members have current consent; Flight/Stay/Ground fixtures available.

**Steps:**

1. Start Shared Agent planning.
2. Inspect input snapshot IDs for all three tools.
3. Review flight, hotel and ground results, sources/times/prices and linked constraints.
4. Disable Ground fixture/tool.
5. Inspect the missing-service response.

**Expected outcomes:**

- All tools use the same consent/constraint snapshot.
- Plan has three services when data exists and explains authorized constraints only.
- Each fact has a source/time or `Demo data` label.
- Tool failure is explicit; no inventory or price is fabricated.

### TS-H4 — Create individualized visa readiness safely

**Stories:** H4, P1  
**Objective:** Verify nationality-specific readiness without legal claims or unauthorized inference.

**Starting conditions:** Alice authorizes nationality; Bob initially does not; route and official-source fixture exist.

**Steps:**

1. Generate plan and readiness checklists.
2. Inspect Alice’s checklist source, checked time, applicable traveler and next actions.
3. Inspect Bob’s result without nationality consent.
4. Bob grants nationality consent, then revoke it after list creation.
5. Load uncertain/expired visa-source fixture.

**Expected outcomes:**

- Alice has a personal, sourced readiness checklist, not a visa approval statement.
- Bob sees a request to self-check until he authorizes data; system does not infer nationality.
- Grant/revoke creates/invalidates Bob’s checklist and expires affected plan.
- Uncertain source directs official verification and does not state a certain conclusion.

### TS-H5 — Re-plan after a flight shock

**Stories:** H5  
**Objective:** Validate self-correction while preserving consent and personal constraints.

**Starting conditions:** Current shared plan includes fixtures, authorizations and two members.

**Steps:**

1. Trigger one flight-price-increase or sold-out event.
2. Inspect new tool/consent snapshots and old-plan expiry.
3. Review old/new flight, stay, ground, constraints, visa impact and explanation.
4. Trigger same event ID again.
5. Trigger a no-feasible-alternative fixture.

**Expected outcomes:**

- One change creates one re-plan; duplicate is idempotent.
- UI identifies preserved and affected constraints for both travelers.
- No automatic charge, booking or silent replacement occurs.
- No-feasible state names blocking constraints and returns members to editing/consent.

### TS-H6 — Confirm and run booking orchestration sandbox

**Stories:** H6  
**Objective:** Prove an Agent can prepare controlled action only after every required member approves.

**Starting conditions:** Current plan has all three services; sandbox configured.

**Steps:**

1. Alice confirms; Bob chooses `Needs changes`.
2. Attempt orchestration.
3. Bob confirms current plan; inspect confirmation details and no-charge disclosure.
4. Invoke sandbox; deliver success callback twice and a late failure callback.
5. Change a price and attempt to invoke using old confirmations.

**Expected outcomes:**

- One non-confirming member blocks orchestration.
- Current, unanimous confirmation displays service items, price/currency, sources and no-charge boundary.
- Sandbox returns a single set of reference IDs; duplicate/late callbacks do not duplicate action.
- Price change expires confirmations; stale plan cannot orchestrate.
- No payment is collected or claimed.

## PROOF and SUPPORT tests

### TS-P1 — Run the three-minute Hero Demo deterministically

**Stories:** P2  
**Objective:** Verify the stated demo can run without manual data edits or unstable tools.

**Starting conditions:** Seeded Profiles, route, nationality rules, fixtures and shock event available.

**Steps:**

1. Run profile → invite → consent → plan → visa → shock → re-plan → confirm → sandbox.
2. Force one live tool unavailable.
3. Reset demo and rerun.

**Expected outcomes:**

- Entire flow completes in three minutes with fixed data.
- Fallback is visibly marked `Demo data`.
- Reset removes shared-trip session state, not seeded Profiles.

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

## Release regression checklist

- Profile memory is explicit, editable, deletable and private by default.
- Shared workspace never shows unapproved Profile/private-chat fields.
- Flight/Stay/Ground and Visa outputs use one consent snapshot and show source/time or demo label.
- Change event invalidates old plan and confirmations before replanning.
- Two members must confirm before only sandbox orchestration; no money moves.
- Missing consent, tool failure, visa uncertainty, member conflict, consent revocation and duplicate callback are tested.
