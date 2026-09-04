---
name: personal.travel.conversation
source-of-truth: ./travel-conversation-skill.ts
agent: personal
status: implemented
---

# `travel.conversation` Personal Skill

## Purpose

Generates one private travel answer from the current owner question, optional
minimal place context, and a server-built bounded raw-message window from the
same owner thread. `thread.recall` remains a separate redacted Skill and is
not the runtime context source. It is registered by `personal-travel-agent.ts`
and invoked only through the Skill Registry with expected version `1.2.0`.

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `travel.conversation` | `Skill.name` |
| `agent` | `personal` | `Skill.agent` |
| `version` | `1.2.0` | `Skill.version` |
| `allowedTools` | `"chat:read"`, `"hotel:search"`, `"flight:search"` (Phase 4) | Personal Agent allow-list |
| `timeoutMs` | `15000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## Contract

- Input: trimmed question (1–4000 chars), optional validated coordinates and
  `REFERENCE | INSPIRATION` source type, and a server-built `threadContext` of
  at most 24 `USER | ASSISTANT` entries. Each entry is at most 8000 chars and
  total context is at most 20,000 chars; the builder enforces the stricter
  runtime turn/character budget.
- Output: non-empty answer plus `MODEL | SAFE_REFUSAL`.
- User-visible prose language: an explicit language/translation request in
  the current turn wins; otherwise the reply uses that turn's dominant
  language. Thread context, long-term memory, destination country and
  provider evidence never select the reply language. This rule does not
  apply to typed tool arguments, evidence, IDs or other machine-consumed
  fields.
- Allowed scope: `chat:read`; `hotel:search` and `flight:search` declared but
  **only dispatched, per capability, when the rollout flag
  `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED=true` is on AND that specific
  capability is in the personal-research allowed capabilities**. No profile
  writes, shared planning, bookings, or irreversible tools.

The service re-resolves every client-supplied coordinate against the server
location-reference source. A matching result becomes `REFERENCE`; otherwise it
remains `INSPIRATION`. Client names and source IDs are never authoritative.

## Phase 4 — inline `hotel.search` / `flight.search` tool dispatch

When the rollout flag is on for a given capability, the conversation worker
registers that tool (`hotel.search` and/or `flight.search`, independently)
with the streaming gateway. The model invokes the tool directly (no UI
button, no `POST /confirm` round-trip) once all required fields are present
and the user has expressed search intent. The tool result is persisted into
`personal_research_evidence` (deduped by `(run_id, capability)` via the
existing unique index), and the second LLM turn streams a grounded summary
back to the SSE channel. The conversation worker relaxes the price/hotel and
availability/hotel safety rules for the second turn only — every other
safety rule (visa, booking status, flight status, schedule) keeps firing
unconditionally.

The flag is the rollout lever. Default off in `.env.example`; flip on per
environment after deploy. Behaviour is byte-identical to v1.1.0 when the
flag is off.

Before model invocation, the Skill deterministically rejects explicit requests
for live/current prices, inventory or availability, visa/entry conclusions,
booking status and other real-time provider facts. After a model response, the
same narrow fact boundary replaces unsupported operational claims with an
explicit deterministic `SAFE_REFUSAL`. General destination inspiration and qualitative
guidance remain allowed.

Provider unavailability, timeout, retry exhaustion, or malformed model output
is not a refusal. It becomes a controlled `UPSTREAM_FAILURE`/`TIMEOUT`; the
service persists no USER or ASSISTANT row for that failed turn.

## Hotel-search readiness behaviour

Hotel searches remain inside the private conversation. The Conversation Worker
always invokes this Skill; it does not create a confirmation/setup card or
emit `research.intent_extracted`. The model reuses same-thread facts and asks
for only the missing city, dates, adult/room configuration and currency.

When `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED=true`, a complete hotel
query is written to the private, server-owned
`conversation_hotel_search_states` row for the thread. The row contains only
city code, dates, occupancy, currency and version — never raw chat text,
credentials, guest identity or a provider result. Legacy confirmation columns
remain null. The model receives this typed state on later turns and does not
need to reconstruct unchanged values from transcript context.

Once all required fields are complete, the read-only sandbox lookup dispatches
without a second confirmation card. It persists the bounded summary into
`personal_research_evidence` (deduped by `(run_id, capability)`) and re-streams
a grounded summary. This authority is search-only: it cannot book, pay, or
supply provider-only identity fields. Nuitee quote-nationality authorization
remains a separate explicit boundary. The model does not emit a prose claim
that the search has been made before the tool result arrives.

## Preferences-saved follow-up

Answering the trip's preference card used to end in silence: the card wrote
the overrides, closed, and nothing spoke. The traveller had just told the
assistant something and got nothing back, so there was no sign it had landed
or what would happen next.

The client now raises a turn with `intent: "preferences_saved"` once the card
resolves. Like `auto_intro`, nobody typed it — it narrows behaviour and
authorises nothing.

The reply is one short paragraph. What it asks for is decided by whether a
missing field actually blocks planning — not by whether memory happens to
hold it:

- **A destination is the one hard prerequisite.** Nothing can be laid out
  without one, and it must never be assumed on the traveller's behalf. Missing,
  the reply asks — and offers two or three concrete candidate directions chosen
  against what *is* known (budget, pace, how far from the departure city), so
  there is something to pick rather than a blank to fill. Dates are the same
  kind of thing, loosened to a rough month or season.
- **Budget, pace, stay style, red-eyes and the rest are not prerequisites.**
  Unstated, they take an ordinary middle value and planning continues. The
  reply may name the default it took and note it can be changed, but must not
  ask about it.
- **Destination already known.** Ask nothing. Say planning can start, and give
  a concrete direction or two to confirm or correct.

Never restate the card as a checklist, re-ask anything already answered, ask
about a field that has a sensible default, pose more than two questions, or
emit a day-by-day itinerary in this turn.

## Brief-saved follow-up

Confirming the destination card left the same silence the preference card
did: the card went, a line said it had been stored, and nothing said what
happens next. `intent: "brief_saved"` is raised when the brief is written, and
before the globe navigates to the planner, so the reply is already on its way
when the workspace opens.

One short paragraph. Acknowledge that it landed, then move:

- **Destination and dates both known.** Say the itinerary can be laid out, and
  in one sentence how — read off the preferences already held. Ask nothing.
- **Destination known, dates missing.** Ask for dates and nothing else, saying
  a rough month or season is enough. Budget, pace and stay style keep their
  defaults and are not raised here.

It must not re-introduce the destination the traveller has just read about,
restate the brief as a field list, or emit an itinerary.

A destination reaches the brief only from what the traveller typed or pinned:
`mergeTripBriefProposal` keeps scheduling fields from the model's own
extraction and drops everything else, so a place the assistant merely offered
as an example cannot become the trip's destination.

Nothing here is written in the client. What the reply says comes from
`memoryContext` and the thread, so a field added to the catalogue is spoken
about without touching this surface.

## Flight-search readiness behaviour

Flight searches follow the identical private-conversation pattern as hotel
search — same Conversation Worker invocation, same two-phase confirm/persist
state machine, same dedup and re-stream flow — for the `flight.search`
capability. The model reuses same-thread facts and asks for only the missing
origin/destination (as 3-letter IATA codes), trip type, dates, adult count,
cabin and currency.

When `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED=true`, a complete flight
query is first written to the private, server-owned
`conversation_flight_search_states` row for the thread. The row contains only
route, trip type, dates, adult count, cabin, currency, version and the current
USER-message confirmation marker — never raw chat text, credentials, passenger
identity or a provider result. The model receives that typed state on later
turns, so an explicit “确认搜索” can call `flight.search` with `{}` and cannot
depend on reconstructing values from transcript context. A field change
replaces the stored query and clears the prior confirmation unless the same
current turn contains a new explicit confirmation.

Only an explicit confirmation bound by the server to the current USER message
may reach the configured flight provider. Before that point the tool returns
`CONFIRMATION_REQUIRED` after persisting the typed query; no provider request
is made. A confirmed call dispatches against the provider, persists the
bounded summary into `personal_research_evidence` (deduped by
`(run_id, capability)`), and re-streams a grounded summary. The model does not
emit a prose claim that the search has been made before the tool result
arrives.

The stream adapter treats an accumulated OpenAI `tool_calls` envelope or the
legacy `function_call` envelope as authoritative even when an
OpenAI-compatible provider returns `stop`, `function_call`, or no finish
marker. Mixed text + tool payload, malformed arguments, and incomplete tool
envelopes fail as the explicit `TOOL_PROTOCOL` code rather than a misleading
empty-content `SCHEMA_PARSE`. Safe runtime events record only bounded protocol
metadata (envelope family and normalized finish reason), never arguments or
conversation content.

For Gemini 3, the adapter also preserves the opaque
`tool_calls[].extra_content.google.thought_signature` from streamed chunks and
returns it unchanged in the assistant tool-call message before sending a tool
result. Gemini requires this signature for the second completion in the same
tool turn. If that second completion has a retryable upstream failure before
any visible text is emitted, the conversation returns a safe fallback reply
instead of falsely reporting the successfully dispatched tool as a failed send.

When the rollout flag is off, the model still summarises the requested
search and asks the owner to reply with an explicit "确认搜索". Without a
UI button to press, the message acts as a verbal confirmation step in
prose; the next turn re-enters the same loop.

### When each readiness constraint is attached

The Skill attaches none of its own. The conversation worker chooses them per
turn in `selectResponseConstraints`
(`apps/api/src/tasks/handlers/conversation-task-handler.ts`) and passes them
through `TravelConversationToolContext.responseConstraints`; the registry path,
which hands the model no tools, therefore carries none.

A constraint is attached when its tool is registered for the turn, and in
`DRAFT` only when the traveller has already engaged that capability — a
persisted `conversation_{hotel,flight}_search_states` row, or an explicit
confirmation in the same turn. Both were previously attached unconditionally,
roughly 3.6k characters of "必须调用 `hotel.search`" against 569 characters of
planning-priority text in the base prompt, and last in the prompt: a traveller
who only described a trip was answered with airport codes, room counts and two
search-confirmation buttons, while the trip brief's dates stayed empty and the
trip could never be activated.

This gates the prompt only. The tools stay registered in `DRAFT`, because
[DRAFT Personal Research §1](../../../../docs/draft-personal-research-implementation.md)
requires that a query the owner explicitly asked for is not blocked for being
"not fully planned yet" — the model reaches such a search under the base
prompt's own priority 2, and the state it persists brings the full constraint
back on the next turn. Behaviour outside `DRAFT` is unchanged. Acceptance:
`TS-DRAFT-PERSONAL-RESEARCH-7` in `docs/test-scenarios.md`.

The `HOTEL_SEARCH_READINESS` and `FLIGHT_SEARCH_READINESS` constraints are
behavioural rules, not canned replies: when a user asks for areas, routes or
trade-offs, the model may reuse stated context and suggest which search
inputs matter. A neighbourhood, landmark, or airline preference may remain as
a preference, but it is not represented as a provider distance or route
filter. The model must not ask users to click a card, button or settings page.

Both constraints preserve the same live-data boundary: qualitative advice is
allowed, but it cannot be presented as current pricing, inventory, or booking
availability outside of an evidence-backed summary. They also forbid
collecting passport, payment, or full guest/passenger data in chat. Any
provider-specific identity requirement stays in the separate explicit
authorization flow.

## Privacy and observability

The current question and prior context are processed only for the active
Personal Agent request. The Worker, never the browser, builds `threadContext`
from the same owner thread and its acceptance-time message-sequence boundary;
the raw window is sent only to the configured model provider. Audit and Agent
run records contain IDs, version/status, timing, token counts, and output
hashes—not question, answer, or transcript text.

## 失败模式

| code | Trigger | HTTP | Retry |
| --- | --- | --- | --- |
| `INPUT_INVALID` | Question, place, or history violates the input schema | 400 | No; correct the request |
| `OUTPUT_INVALID` | Gateway result violates the output schema | 422 | No; fix the implementation |
| `TIMEOUT` | Execution exceeds 15000ms | 504 | Yes, with the same request ID |
| `UPSTREAM_FAILURE` | Configured model/provider fails or returns unusable output | 502 | Yes, with the same request ID |
| `TOOL_NOT_ALLOWED` | `chat:read` is denied by policy | 403 | No; correct policy/context |

## Verification

- `tests/conversation-gateway.test.ts`
- `tests/conversation-safety.test.ts`
- `tests/chat-conversation-e2e.test.ts`
