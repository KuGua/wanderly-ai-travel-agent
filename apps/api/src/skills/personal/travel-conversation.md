---
name: personal.travel.conversation
source-of-truth: ./travel-conversation-skill.ts
agent: personal
status: implemented
---

# `travel.conversation` Personal Skill

## Purpose

Generates one private travel answer from the current owner question, an
optional minimal place context, and bounded safe output from `thread.recall`.
It is registered by `personal-travel-agent.ts` and invoked only through the
Skill Registry with expected version `1.0.0`.

## 注册元数据

| Field / 字段 | Value / 值 | Source / 源 |
| --- | --- | --- |
| `name` | `travel.conversation` | `Skill.name` |
| `agent` | `personal` | `Skill.agent` |
| `version` | `1.0.0` | `Skill.version` |
| `allowedTools` | `chat:read` | Personal Agent allow-list |
| `timeoutMs` | `15000` | `Skill.timeoutMs` |
| `needsConfirm` | `false` | `Skill.needsConfirm` |

## Contract

- Input: trimmed question (1–4000 chars), optional validated coordinates and
  `FIXTURE | INSPIRATION` source type, and at most 20 safe history entries of
  at most 1000 chars each.
- Output: non-empty answer plus `MODEL | SAFE_REFUSAL`.
- Allowed scope: `chat:read`; no profile writes, shared planning, bookings, or
  irreversible tools.

The service resolves `FIXTURE` against the versioned server-owned Explore-chat
destination registry using source ID, canonical name and coordinates. Any
mismatch, and every `INSPIRATION`, is passed to the Skill as unverified user
context. Client provenance is never authoritative.

Before model invocation, the Skill deterministically rejects explicit requests
for live/current prices, inventory or availability, visa/entry conclusions,
booking status and other real-time provider facts. After a model response, the
same narrow fact boundary replaces unsupported operational claims with an
explicit deterministic `SAFE_REFUSAL`. General destination inspiration and qualitative
guidance remain allowed.

Provider unavailability, timeout, retry exhaustion, or malformed model output
is not a refusal. It becomes a controlled `UPSTREAM_FAILURE`/`TIMEOUT`; the
service persists no USER or ASSISTANT row for that failed turn.

## Privacy and observability

The current question is processed only for the active Personal Agent request.
Previous raw transcript is not supplied by `thread.recall`; only non-empty
server-safe summaries are eligible. Audit and Agent run records contain IDs,
version/status, timing, token counts, and output hashes—not question, answer,
or transcript text.

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
