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

## Conversation behavior

The conversation call receives only the current private question, optional
minimal place context, and bounded safe/redacted recall. A valid structured
reply is returned with `responseMode: "MODEL"`.

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
