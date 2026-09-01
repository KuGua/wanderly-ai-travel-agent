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
and invoked only through the Skill Registry with expected version `1.1.0`.

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `travel.conversation` | `Skill.name` |
| `agent` | `personal` | `Skill.agent` |
| `version` | `1.1.0` | `Skill.version` |
| `allowedTools` | `"chat:read"` | Personal Agent allow-list |
| `timeoutMs` | `15000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## Contract

- Input: trimmed question (1–4000 chars), optional validated coordinates and
  `REFERENCE | INSPIRATION` source type, and a server-built `threadContext` of
  at most 24 `USER | ASSISTANT` entries. Each entry is at most 8000 chars and
  total context is at most 20,000 chars; the builder enforces the stricter
  runtime turn/character budget.
- Output: non-empty answer plus `MODEL | SAFE_REFUSAL`.
- Allowed scope: `chat:read`; no profile writes, shared planning, bookings, or
  irreversible tools.

The service re-resolves every client-supplied coordinate against the server
location-reference source. A matching result becomes `REFERENCE`; otherwise it
remains `INSPIRATION`. Client names and source IDs are never authoritative.

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

The Skill attaches the server-owned `HOTEL_SEARCH_READINESS` response
constraint to each model call. It is a behavioural rule, not a canned reply:
when the user asks to find, compare, filter, or quote lodging, the model reuses
facts already stated in the current question and same-thread context, retains a
neighbourhood or landmark as a location anchor, and asks only for missing
search inputs. Those required inputs are dates, adult/room configuration, and
currency; a distance/walking limit is requested only when the stated location
anchor has no usable boundary. Budget and amenities are optional refinements.

The constraint limits clarification to three grouped prompts and preserves the
existing live-data boundary: qualitative advice is allowed, but it cannot be
presented as current pricing, inventory, or booking availability. It also
forbids collecting passport, payment, or full guest data in chat. Any
provider-specific nationality requirement stays in the separate explicit
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
