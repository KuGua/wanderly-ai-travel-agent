
### TS-LLM-RETRY-1 — Transient UPSTREAM_5XX is retried with exponential backoff

**Stories:** H1, H3
**Objective:** Verify that the LLM gateway retries transient upstream failures (5xx, network, timeout) with exponential backoff, and surfaces a `ModelGatewayError` only when the budget is exhausted.

**Steps:**

1. Set `MODEL_GATEWAY_MAX_RETRIES=3`, `MODEL_GATEWAY_BASE_BACKOFF_MS=250`, `MODEL_GATEWAY_MAX_BACKOFF_MS=2000`.
2. Trigger a Shared `plan.comparison` skill with a mock provider that returns 502 on the first attempt and succeeds on the second.
3. Repeat with a mock provider that always returns 502.

**Expected outcomes:**

- Step 2 succeeds after 2 attempts. Total wall-clock ≥ 250ms (one backoff cycle). `llm_request_errors_total{retryable="true"}` increments once; `llm_request_errors_total{retryable="false"}` does not increment.
- Step 3 throws `ModelGatewayError{code: "UPSTREAM_5XX"}` after 4 attempts. `llm_request_errors_total{retryable="true"}` increments 3 times; `retryable="false"` increments once on final failure.
- `SCHEMA_PARSE` failures skip retry: 1 attempt only, then `ModelGatewayError{SCHEMA_PARSE}`. `retryable="false"` increments once.

### TS-LLM-RETRY-2 — conversation path returns FALLBACK on retry-exhausted upstream failure

**Stories:** H1
**Objective:** Verify that the Personal `travel.conversation` skill returns a `FALLBACK` reply instead of throwing when the LLM gateway exhausts its retry budget, so the SSE channel closes cleanly and the UI keeps rendering.

**Steps:**

1. Trigger a `travel.conversation` skill with a mock provider that always returns 503.
2. Capture the `recordAgentRun` audit row.

**Expected outcomes:**

- Step 1 returns `{ responseMode: "FALLBACK", content: <non-empty> }`. No `ModelGatewayError` propagates to the worker.
- `recordAgentRun` writes a row with `status: "ERROR"`, `errorCode: "UPSTREAM_5XX"`, `tokens: null`. The audit trail is preserved.
- Worker task ends successfully (not retried). SSE channel closes with the FALLBACK content as the last delta.

### TS-LLM-RETRY-3 — streaming conversation does not retry after a delta is delivered

**Stories:** H1
**Objective:** Verify that once a streaming chunk is delivered to the UI, a mid-stream upstream failure rethrows (so the worker restarts the task) rather than silently concatenating attempt-2 chunks behind attempt-1 chunks.

**Steps:**

1. Trigger a streaming `travel.conversation` with a mock that yields one chunk then errors with 503.
2. Set `MODEL_GATEWAY_MAX_RETRIES=5`.

**Expected outcomes:**

- Step 1: the user receives exactly one chunk (`"partial "`). The gateway throws `ModelGatewayError{code: "UPSTREAM_5XX"}`.
- `client.createCalls === 1` (no retry attempted after the delta was sent).
- The worker restarts the task; the SSE channel closes; the next attempt produces a fresh stream.
