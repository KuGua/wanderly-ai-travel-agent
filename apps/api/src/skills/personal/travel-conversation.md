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
| `allowedTools` | `"chat:read"`, `"hotel:search"` (Phase 4) | Personal Agent allow-list |
| `timeoutMs` | `15000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## Contract

- Input: trimmed question (1–4000 chars), optional validated coordinates and
  `REFERENCE | INSPIRATION` source type, and a server-built `threadContext` of
  at most 24 `USER | ASSISTANT` entries. Each entry is at most 8000 chars and
  total context is at most 20,000 chars; the builder enforces the stricter
  runtime turn/character budget.
- Output: non-empty answer plus `MODEL | SAFE_REFUSAL`.
- Allowed scope: `chat:read`; `hotel:search` declared but **only dispatched
  when the rollout flag `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED=true` is
  on AND `hotel.search` is in the personal-research allowed capabilities**.
  No profile writes, shared planning, bookings, or irreversible tools.

The service re-resolves every client-supplied coordinate against the server
location-reference source. A matching result becomes `REFERENCE`; otherwise it
remains `INSPIRATION`. Client names and source IDs are never authoritative.

## Phase 4 — inline `hotel.search` tool dispatch

When the rollout flag is on, the conversation worker registers the
`hotel.search` tool with the streaming gateway. The model invokes the tool
directly (no UI button, no `POST /confirm` round-trip) once all required
fields are present and the user has expressed search intent. The tool result
is persisted into `personal_research_evidence` (deduped by
`(run_id, capability)` via the existing unique index), and the second LLM
turn streams a grounded summary back to the SSE channel. The conversation
worker relaxes the price/hotel and availability/hotel safety rules for the
second turn only — every other safety rule (visa, booking status, flight
status, schedule) keeps firing unconditionally.

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
query is first written to the private, server-owned
`conversation_hotel_search_states` row for the thread. The row contains only
city code, dates, occupancy, currency, version and the current USER-message
confirmation marker — never raw chat text, credentials, guest identity or a
provider result. The model receives that typed state on later turns, so an
explicit “确认搜索” can call `hotel.search` with `{}` and cannot depend on
reconstructing values from transcript context. A field change replaces the
stored query and clears the prior confirmation unless the same current turn
contains a new explicit confirmation.

Only an explicit confirmation bound by the server to the current USER message
may reach Nuitee. Before that point the tool returns
`CONFIRMATION_REQUIRED` after persisting the typed query; no provider request
is made. A confirmed call dispatches against Nuitee, persists the bounded
summary into `personal_research_evidence` (deduped by `(run_id, capability)`),
and re-streams a grounded summary. The model does not emit a prose claim that
the search has been made before the tool result arrives.

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

The `HOTEL_SEARCH_READINESS` constraint is a behavioural rule, not a canned
reply: when a user asks for areas or trade-offs, the model may reuse stated
context and suggest which search inputs matter. A neighbourhood or landmark
may remain as a preference, but it is not represented as a provider distance
filter. The model must not ask users to click a card, button or settings page.

The constraint preserves the live-data boundary: qualitative advice is allowed,
but it cannot be presented as current pricing, inventory, or booking
availability outside of an evidence-backed summary. It also forbids collecting
passport, payment, or full guest data in chat. Any provider-specific
nationality requirement stays in the separate explicit authorization flow.

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
