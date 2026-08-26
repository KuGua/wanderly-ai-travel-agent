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
- Fixture provider results narrow explicitly between `FALLBACK_DEMO` and `UNAVAILABLE`; unsupported requests contain no fabricated `data`.

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
2. 连续点击多个地图空白区域；对能识别到 75 km 内城市的点击，确认图钉落在返回的城市中心；对没有城市参考的点击，确认保留原始坐标。
3. 在同一城市范围再次点击，然后在聊天框中输入一个主要城市/首都名称。
4. 从地点详情打开私有灵感管理器，分别查看当前区域（当前点 50 km 内）与全部标记。
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
- 三档国家边界 mesh 必须都能画出跨度小于 1.5° 的微型国家轮廓（新加坡在 LOD-0/1/2 均有完整环），LOD-0 gzip 仍需在 200 KB 首屏预算内。
- 国家边界覆盖层的视口剪裁不得改变可见结果：视口内的 arc 必须绘制，横穿视口但端点都在视口外的 arc 不得被丢弃，跨 ±180° 的视口两侧都要绘制；zoom < 3、视口跨度接近全球或 map 无法报告 bounds 时退回不剪裁，绝不能出现边界整段消失。
- zoom ≥5.5 的全精度边界瓦片只能按视口请求：低 zoom 不得请求 `country-borders-lod3/index.json`，只请求视口覆盖且索引中列出的瓦片（不得因海洋瓦片缺失产生 404），瓦片信息必须与 `index.json` 的 sha256 一致且单片 gzip ≤150 KB。索引或任一必需瓦片缺失/失败时必须继续绘制 LOD-2 且不得出现边界缺口，也不得与瓦片同时绘制造成重复描边；失败的瓦片允许后续重试。
- 未登录会话只能匿名调用地点参考端点，成功时替换临时 `Pinned place N`；第 31 次同一客户端一分钟窗口内请求返回 `429`，不记录原始坐标或地址。Profile、行程、私聊、授权、规划、确认和预订在相同未登录会话中仍为 `401`。
- 空白区域只能保存私有灵感或请求后续加入候选；不改变共享约束、方案或确认状态。
- 命中城市的私有灵感使用服务端 `nearestCityCoordinates` 固定到 GeoNames 市级中心；区、县、街道和街区记录保留在版本化原始数据中，但不得成为地图 pin 或地点预览。上海的区级点击归一到上海，南京与苏州等不同城市仍保持独立。同名且中心点相距不超过 25 km 的第二次城市点击不新增图钉，并通过 `role="status"` 提示已标记。当前去重范围仅为城市，省/州/国家不得套用同一规则。
- 聊天中的明确城市名称使用版本化页面城市目录识别；命中后创建同样的会话内图钉，地球移动到该城市，且不得把文本命中提升为旅行事实。若聊天命中已有城市，必须保持聊天框打开并只把地球转到现有图钉，不重复显示手动地图点击使用的“已标记”提示。拉丁字母城市名必须保留专名大小写，避免把普通词误判成地点。
- 多个私有灵感在缩放和移动地图时保持绑定各自归一后的经纬坐标；管理器默认不打开、不预选标记，单独删除只移除目标标记，批量删除只移除已勾选标记。
- `Current area` 明确表示当前点 50 km 内，不得把距离范围伪装为城市边界。离线位置参考仅能来自版本化、来源化的专用 resolver；不得从地图 tile、地图标签、Natural Earth SVG overlay 或模型推断。
- 原型刷新后临时标记消失；生产实现必须将任何持久化操作交由服务端授权模型处理。
- 国家、城市/省州标签仅来自地图底图，并按缩放渐进显示；它们可打开 `Map location` 预览，但不会创建私有 pin、共享约束、方案、价格、库存、签证或预订结论。空白位置仍仅创建临时私有灵感。
- 如果配置的 style 缺少兼容的 OpenMapTiles source 或缺失任一必需图层，行政区/城市开关**保持可见但被禁用**，附 `role="status"` caption 说明缺失项（缺 source 或 `missing layers:` 列表）；地图保留原有候选入口和故障回退；不静默隐藏，不报错或伪造地图数据。开发者可在 dev 模式下通过 `window.__wanderlyMap.readiness` 观察 5 种 readiness（loading / ready-supported / ready-style-unsupported-source / ready-style-missing-layers / unavailable-network）。
- 地图就绪生命周期分两阶段（mounting → ready）：MapLibre 6.6 的 globe projection 必须写入传给 `new Map()` 的 style JSON，`style.load` 是 style 兼容性检查和图层控件的唯一就绪前置；不得在 style 创建前或 `style.load` 后调用 `setProjection()`。OpenMapTiles 的 `sourcedata` 只作为开发诊断，慢 TileJSON 或 PBF 不得触发 `unavailable-network`。只有 style 总超时、初始化异常或 style ready 前的 map error 才显示 globe error 回退。dev 模式下 `window.__wanderlyMap.stage` 实时反映当前阶段。
- 地图 ready 后，国家边界位于 provider style stack 顶层：即使 Liberty 的 fill/road layer 重排，全球缩放仍可看到本地 Natural Earth 共享 mesh 与独立九段线。关闭 Countries 时必须同时隐藏国家线、九段线与洲/国家名称；zoom 2.6 起显示首都、zoom 2.8 起显示重要城市、zoom 4.2 起显示省州名称。SVG 标签必须在 MapLibre `render` 帧内同步重投影并随 resize 更新，平移或缩放时不得落后 WebGL 地球（标签位置只能直接写入 DOM，不得经由 React state 提交，否则会慢一帧并出现漂移）；必须剔除背半球并进行屏幕碰撞去重；已离开候选集但尚未卸载的标签节点必须当帧隐藏，不得停留在过期位置。切换对应图层后标签即时消失。视觉边界和标签不参与地点匹配、反向地理编码或旅行事实；位置参考只能使用专用、版本化的离线 resolver 数据。
- 国界构建必须仅在构建期读取 Natural Earth 10m，并从同一个 TopoJSON topology 输出三档共享 mesh；同一时刻前端只绘制当前 zoom 的一档，任意共享边界只出现一次。首屏只请求 LOD-0 与本地九段线，LOD-0 gzip 不得超过 200 KB；LOD-1/2 仅在进入对应 zoom 后请求。浏览器与 `build-geography-labels.mjs` 对 `geo.datav.aliyun.com` 的请求必须为 0。每一档必须在 MapLibre `render` 帧内同步更新、在半球边缘裁剪相交线段并随 resize 更新，旋转时不得落后 WebGL 地球或因顶点跨越背面而抖动。获取失败应保留既有地图和无障碍地点入口。
- 地球表面必须保持实体不透明：GEBCO `GEBCO_LATEST` WMS shaded relief 同时提供陆地与海底地势，opacity 固定为 1；Liberty Natural Earth 位于其下，仅作为 GEBCO 请求失败时的视觉 fallback。道路、标签和行政边界仍需在 relief 之上可读，放大时不得退化为白色或透明地图。必须显示 GEBCO attribution 与“不用于航海”限制；不得将地势像素解释成路线、天气、价格、签证或安全结论。

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
- A final `COMPLETED` event refers only to an already validated and persisted plan version.
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

- 前端不提供 Demo 身份选择，也不允许客户端提交用户 ID；身份只能来自正常 Cognito 登录会话。
- fixture 与 HTTP 模式使用同一组 Zod 合同；不符合合同的 Profile、Trip 或 error 响应必须进入显式错误状态。
- 所有受保护的 HTTP 请求在发送时通过 AWS Amplify session 读取当前 Cognito access token；无 session 时不发送 Authorization，token 刷新后使用新 token，登录会话变化或退出时必须清空 TanStack Query 缓存且后续请求不得继续携带旧 token。`POST /api/v1/explore/location-reference` 是唯一匿名、无持久化且限流的例外。应用自身不得把 token 复制到 localStorage。
- `AUTH_MODE` 默认必须为 `cognito`。显式 `local-dev` 仅允许 `NODE_ENV=development|test`、loopback server 绑定、loopback socket 客户端和 `LOCAL_DEV_ALLOWED_ORIGINS` 中的精确 loopback HTTP Origin；production、staging、缺失环境或任一非 loopback 边界必须拒绝启动/请求。浏览器不发送 fake token/user ID，服务端固定身份仍须通过原 owner-only thread 授权。非允许 Origin 不得获得 CORS 读权限，且对受保护写操作必须返回 `403` 并不创建业务状态。
- Home 覆盖 Profile/Trip 的 loading、empty、error、unauthorized 与 `Demo data` 状态，不混入其他用户数据或未确认的 plan/action 字段。
- Profile nullable 字段映射为空表单值；PUT 只提交已修改的可写非空字段，不包含只读字段，失败时保留输入。
- Explore Map 选择已知演示目的地时只提交服务端规范的 fixture `sourceId`、名称与 `[longitude, latitude]`；动态灵感点和地理搜索结果必须标记为 `INSPIRATION`，浏览器不得提交 `role`、`senderUserId` 或伪造受信任来源。
- 私聊首次提问创建当前用户的 private thread，后续提问复用该 thread；刷新后只从本地 thread ID 指针恢复 owner-only history，服务端返回不存在的 thread 时清除失效指针，不在浏览器持久化消息正文。
- 每个新 turn 使用新的 UUID `requestId`；acceptance 网络结果不确定时必须复用原 request ID，发送期间禁止并发重复提交。接受成功后 UI 以 durable run status 为准，SSE 断线只降级为轮询；Worker 自动处理受控网络/5xx 重试。最终 `MODEL` 正常展示，terminal provider/model failure 保留 USER、不得持久化 partial ASSISTANT 或伪造 fallback。
  **已知缺口（202/SSE 切换引入）**：`SAFE_REFUSAL` 的核验提示当前不显示。旧的同步响应会返回 `responseMode`，acceptance 响应不再包含它，而 `responseMode` 目前只写入 idempotency `resultPayload` 与 audit summary，既不在 `chat_messages` 上，也不在 `AgentRunResponse` 或 `turn.completed` 事件中。恢复该提示需要先扩展契约，与后续的签证/拒答呈现设计一并处理。
- 浏览器聊天请求在 Cognito 模式必须使用真实 Cognito access token；没有可用登录 token provider 时，三人真实 API 端到端演示属于显式阻塞项，不得硬编码 token 或退回 demo identity。`local-dev` 仅覆盖一个服务端固定身份的单人 smoke test，不能替代三人授权/确认验收。
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

- Profile memory is explicit, editable, deletable and private by default.
- Shared workspace never shows unapproved Profile/private-chat fields.
- Flight/Stay/Ground and Visa outputs use one consent snapshot and show source/time or demo label.
- Change event invalidates old plan and confirmations before replanning.
- All three required members must confirm before sandbox orchestration; no money moves.
- Missing consent, tool failure, visa uncertainty, member conflict, consent revocation and duplicate callback are tested.
