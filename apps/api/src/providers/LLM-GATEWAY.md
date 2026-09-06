# LLM gateway

Set `MODEL_GATEWAY_PROVIDER` to `openai`, `gemini`, or `openai-compatible`
and provide the corresponding server-side credentials. `gateway-factory.ts`
rejects missing or incomplete real-provider configuration. Production does not
select or fall back to a local/mock model.

## Runtime contract

`LLMGateway` is the only production path through which a Skill calls a real
language model. It uses the current OpenAI SDK `chat.completions.parse` path
for the OpenAI-compatible Chat Completions API,
validates every structured response with Zod, observes bounded retries, and
records safe Agent-run metadata. Prompt and response bodies are never written
to audit summaries, metric labels, or Agent-run metadata.

Gemini's OpenAI-compatible `json_object` response may put the JSON string in
`message.content` while leaving `message.parsed` null. The gateway parses that
content only at this adapter boundary and still requires the same operation-
specific Zod schema before returning any model output.

Daily-itinerary composition uses `zodResponseFormat` structured output rather
than `json_object`. Its provider wire contract contains only structural types,
day keys, prose/times and short evidence aliases; it deliberately omits
provider-fragile semantic JSON Schema keywords such as the outer nested-array
`maxItems`. The response must then pass the independent canonical Zod schema
before the planning service owns dates, timezone labels, verification labels
and provider ids or accepts aliases. This preserves every business constraint
without coupling it to a provider's JSON Schema dialect.

Run `pnpm contract:daily-itinerary-provider` in staging or as a release gate to
exercise the exact configured model and wire schema with synthetic aliases.
The probe is intentionally not an API startup dependency because daily
composition is optional; it emits only a bounded outcome, HTTP status and
schema fingerprint.

The invocation `AbortSignal` is passed as an OpenAI SDK request option, never
serialized into the provider JSON body. This keeps cancellation bounded while
remaining compatible with Gemini's strict request schema.

The gateway supports two operations:

- `generateStructuredPlan` for Shared `plan.comparison`;
- `generateConversationReply` for Personal `travel.conversation`.

Planning output remains an untrusted candidate until the plan validator checks
provider evidence, source provenance, snapshot authorization, and structure.
Conversation output remains untrusted until the deterministic conversation
safety policy rejects unsupported operational claims.

### User-visible language contract

The language rule applies only to natural-language content displayed to a
traveller. Its order is: an explicit language or translation request in the
current turn; otherwise, the dominant language of that current question.
Thread context, long-term memory, destination country, and provider evidence
are context only and cannot change that choice. Proper nouns may retain their
usual local spelling. The shared rule is injected once into both structured
and streamed `travel.conversation` prompts.

This is not a rule for every model operation: plan candidates, extraction
results, evidence, tool arguments, IDs, enums, and other machine-consumed
fields retain their typed contracts. Public cached location introductions have
no user question; they use the server-validated request `locale` (`en` or
`zh`) as their language authority and cache key.

### Shared planning prompt boundary

The Shared planning prompt is maintained in
`shared-planning-prompts.ts`, separately from Personal conversation prompts.
It defines a non-conversational Worker, not a chat endpoint: it may consume
only the server-built snapshot projection and normalized, run-bound provider
evidence. It cannot receive private thread text, unconfirmed Personal Agent
proposals, or Personal Research evidence; it cannot ask or contact a member,
confirm a plan, mutate state, book, pay, or apply for a visa. Missing or
unavailable facts are handled by the deterministic planning/readiness flow,
not by model defaults or estimates. Both the standard structured call and the
tool-loop call use this boundary, with the latter adding only tool-specific
instructions.

## Conversation behavior

The conversation call receives only the current private question, optional
minimal place context, and bounded safe/redacted recall. A valid structured
reply is returned with `responseMode: "MODEL"`.

The private conversation assistant clarifies, summarizes, and obtains confirmation for the
owner's private trip brief and constraints. It must not create a daily
itinerary, route, base-city/stay plan, transport plan, or supplier comparison:
those are planning-workflow outputs after the confirmed snapshot enters the durable
planning workflow. Flight and accommodation research are introduced only when
the traveller explicitly asks to search, compare, filter, or quote those
services. Each tool-backed request explains that confirmed conditions can be
included in the complete trip plan; it must not instead
promote a separate search flow. Destination introductions and general travel
questions remain optional exploration support; the prompt must never claim a
completed booking, payment, live query, or external action.

`SAFE_REFUSAL` is not produced by the gateway. It is a deterministic policy
response produced by `travel.conversation` before model invocation for
unsupported live/operational questions, or after invocation when model output
contains an unsupported operational claim.

Client loading failure, provider failure, timeout, retry exhaustion, or an
invalid response envelope records an `ERROR`/`TIMEOUT` Agent run and throws a
controlled `ModelGatewayError`. The Personal Skill maps that to
`SkillError("UPSTREAM_FAILURE")`; no synthetic answer is returned and the chat
service therefore persists neither USER nor ASSISTANT message for that turn.

## Provider and telemetry behavior

`gateway-factory.ts` supports configured OpenAI, Gemini through its
OpenAI-compatible endpoint, and explicitly configured OpenAI-compatible
providers. Every provider reads the same server-side `MODEL_GATEWAY_API_KEY`.
The local example explicitly selects `gemini-3.1-flash-lite`; the runtime
requires an explicit provider and model rather than selecting either default.
Other compatible providers additionally require an explicit URL. Tests may inject
a fake `ModelGateway` or fake SDK client; those fakes are not selectable by the
production factory.

Every success or terminal failure records:

- `skillName`: `plan.comparison` or `travel.conversation`;
- `agentName`: `shared` or `personal`;
- configured model and prompt versions;
- output/error hash, latency, status, error code, and available token counts.

The gateway reports low-cardinality provider/outcome metrics. Private question,
conversation history, model reply, user ID, thread ID, and correlation ID are
not metric labels.

## Verification

- `tests/llm-gateway.test.ts`: planning success/failure and provider factory.
- `tests/conversation-gateway.test.ts`: structured conversation success and
  controlled provider/schema failure without fallback content.
- `tests/conversation-safety.test.ts`: deterministic `SAFE_REFUSAL` boundaries.
- `tests/chat-conversation-e2e.test.ts`: owner-only persistence and no message
  persistence on provider failure.
