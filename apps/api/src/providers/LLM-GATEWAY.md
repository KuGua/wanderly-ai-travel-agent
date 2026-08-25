---
name: llm-gateway
source-of-truth: ./llm-gateway.ts
applies-to: [plan-comparison-skill, gateway-factory.ts]
---

# LLM Gateway

`LLMGateway` is the only path through which a Skill calls a real language
model. It implements the `ModelGateway` interface, restricts itself to the
OpenAI Chat Completions `parse` API, and **falls back to `MockModelGateway`
on every failure path**.

## Source-of-truth

`./llm-gateway.ts`.

## Scope & invariants

- One LLM call per `plan.comparison` Skill invocation; retry budget is
  `OPENAI_MAX_RETRIES` (default 1) plus the original attempt.
- No PII is ever appended to the prompt beyond what the snapshot already
  carries. The Skill handler passes only `destination`, `flights`, `stays`,
  `ground`, `memberPreferences` — never raw profile rows, conversation, or
  passport numbers.
- Every LLM attempt is logged to `agent_runs` (`observability/agent-runs.ts`).
  Success increments `llm_request_latency_ms{provider, outcome="success"}`;
  fallback increments `provider_fallback_total{provider, outcome}`.

## Provider resolution (`gateway-factory.ts`)

| `MODEL_GATEWAY_PROVIDER` env | provider used | notes |
| --- | --- | --- |
| `"mock"` (explicit) | `MockModelGateway` | Always fixture, even with key set. |
| `"openai"` (explicit) | `LLMGateway` (OpenAI default base URL) | Requires `OPENAI_API_KEY`. |
| `"gemini"` (explicit) | `LLMGateway` with `GEMINI_BASE_URL` (defaults to Google's OpenAI-compatible endpoint) | Requires `GEMINI_API_KEY` or fallback to `OPENAI_API_KEY`. |
| `"openai-compatible"` (explicit) | `LLMGateway` with `MODEL_GATEWAY_BASE_URL` | Requires `MODEL_GATEWAY_BASE_URL` + `MODEL_GATEWAY_API_KEY` + `MODEL_GATEWAY_MODEL`. |
| unset | `gemini` if `GEMINI_API_KEY` set, else `openai` if `OPENAI_API_KEY` set, else `mock` | Default resolution. |

`MetricProvider` (`observability/metrics.ts`): `"openai" \| "gemini" \| "openai-compatible" \| "mock"`. This is the value passed to `LLMGatewayOptions.provider` and used as the `provider` label on `provider_fallback_total` and `llm_request_latency_ms`.

## `LLMGateway` constructor

```ts
interface LLMGatewayOptions {
  apiKey: string;
  provider: MetricProvider;
  baseUrl?: string;
  modelName: string;
  promptVersion: string;
  mock: ModelGateway;
  ctx: RequestContext;
  client?: unknown;          // injected for tests; bypasses dynamic import
  maxRetries?: number;       // default 1
}
```

In production, `client` is **not** supplied; the gateway dynamically
`import("openai")` and instantiates `new OpenAI({ apiKey, baseURL? })`.
Tests inject a fake `client` to avoid hitting the network.

## System prompt (verbatim)

From `llm-gateway.ts:137-141`:

> "You are the Shared Trip planning skill. Return one JSON object with exactly
>  one top-level plan field. The plan must contain destination, flights, stays,
>  ground, and generatedAt. Never include PII, passport numbers, or fields
>  outside the supplied snapshot."

The gateway does **not** include `constraintReferences` in the system prompt;
the validator at [../policy/VALIDATOR.md](../policy/VALIDATOR.md) handles
that, and the Skill handler is responsible for passing a model output
shape that includes it when desired.

## OpenAI call shape

```ts
client.beta.chat.completions.parse({
  model: this.options.modelName,
  messages: [
    { role: "system", content: <system prompt above> },
    { role: "user",   content: JSON.stringify({ destination, flights, stays, ground, memberPreferences }) },
  ],
  response_format: { type: "json_object" },
  signal,
});
```

> We use **`chat.completions.parse`** with `response_format: { type: "json_object" }`
> and a Zod `parsedCompletionSchema` re-validator in TS land. The OpenAI
> **Responses API** with `zodTextFormat` is intentionally NOT used.

The response is then parsed again through `parsedCompletionSchema` (Zod) to
verify `{ plan: { destination, flights, stays, ground, generatedAt, constraintReferences? } }`.

## Fallback-to-mock triggers

| # | Trigger | `errorCode` recorded | `provider_fallback_total{outcome}` |
| --- | --- | --- | --- |
| 1 | `loadClient()` throws (e.g. `import("openai")` fails). | `classifyError(err)` | `TIMEOUT` \| `SCHEMA_PARSE` \| `NETWORK` \| `UPSTREAM_5XX` \| `UPSTREAM_FAILURE` \| `UNKNOWN` |
| 2 | After `maxRetries + 1` attempts, `lastError` is non-timeout. | last error code | as above |
| 3 | Timeout (`AbortError` or message `/timeout/i`). | `TIMEOUT` | `TIMEOUT` |
| 4 | Schema parse failure (Zod rejection of `parsedCompletionSchema`). | `SCHEMA_PARSE` | `SCHEMA_PARSE` |

`classifyError` (`llm-gateway.ts:50-59`) maps `AbortError`/timeout → `TIMEOUT`,
`/parse|schema/i` → `SCHEMA_PARSE`, network → `NETWORK`, 5xx → `UPSTREAM_5XX`,
else `UPSTREAM_FAILURE`, null/undefined → `UNKNOWN`.

## `recordAgentRun` writes

Every planning or Personal conversation LLM attempt (success or fallback)
writes a row to `agent_runs`:

| Column | Source |
| --- | --- |
| `runId` | randomUUID per call |
| `skillName` | `"plan.comparison"` or `"travel.conversation"` |
| `agentName` | `"shared"` or `"personal"`, matching the Skill |
| `modelName` | `this.options.modelName` |
| `promptVersion` | `this.options.promptVersion` (env `OPENAI_PROMPT_VERSION`, default `1.0.0`) |
| `outputHash` | `sha256(canonicalize(plan))` |
| `latencyMs` | wall clock from handler start to result |
| `status` | `"SUCCESS"` or `"FALLBACK"` |
| `errorCode` | classification from above table, or null on success |
| `tokens` | `{ prompt, completion, total }` if `response.usage` is exposed; otherwise null |

After the `agent_runs` write, an `audit_events` row is appended with
`action: "AGENT_RUN"` and a `summary` containing `runId`, `skillName`,
`agentName`, `modelName`, `status`, `errorCode`, `latencyMs`.

## Consumers

- `apps/api/src/skills/shared/plan-comparison-skill.ts` — calls
  `modelGateway().generateStructuredPlan(...)`.
- `apps/api/src/skills/personal/travel-conversation-skill.ts` — calls
  `modelGateway().generateConversationReply(...)` with the current question,
  optional minimal place context, and bounded safe recall.
- `apps/api/src/providers/gateway-factory.ts` — builds the
  `LLMGateway` instance and exposes the `modelGateway()` singleton.

## Verification

- `npx vitest run tests/llm-gateway.test.ts` — exercises success,
  malformed output fallback, abort fallback, factory-without-key,
  Gemini / openai-compatible provider resolution.
- `npx vitest run tests/conversation-gateway.test.ts` — exercises deterministic
  place-aware mock output, structured live-model parsing, explicit fallback,
  and raw-content exclusion from Agent run metadata.
