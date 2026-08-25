---
name: middleware-overview
source-of-truth: ./
applies-to: [error-handler.ts, sandbox-signature.ts, auth.ts]
---

# `apps/api/src/middleware/`

This directory owns the HTTP boundary: who you are (`auth.ts`), how errors
turn into JSON (`error-handler.ts`), and how the booking sandbox authenticates
its callbacks (`sandbox-signature.ts`).

## Files

| File | Purpose | See |
| --- | --- | --- |
| `auth.ts` | Cognito bearer-token verification and server-side user provisioning. Only health, metrics, documentation and the signed sandbox callback are exempt. |  |
| `error-handler.ts` | `errorHandler` — converts `SkillError`, `PlanValidationError`, `ZodError`, `ApiError`, generic into a JSON envelope. | [§Error handler](#error-handler) |
| `sandbox-signature.ts` | `verifySandboxSignature(headers, rawBody, secret)` — HMAC-SHA256 + 5-minute window + `configuration_error` placeholder detection. | [§Sandbox signature](#sandbox-signature) |

## Error handler

`errorHandler` (`error-handler.ts`) is set on `app.setErrorHandler(errorHandler)`
in `app.ts`. Branch order:

1. **`error instanceof SkillError`** — returns `{ statusCode: error.statusCode, error: error.code, message, code: error.code, violations: error.violations ?? [], correlationId }`. See
   [../../agents/ERROR-CODES.md](../../agents/ERROR-CODES.md).
2. **`error instanceof PlanValidationError`** — the body keeps the generic
   envelope plus spreads `error.violations` (an array of
   `{ code, fieldPath, reason }`). Status is always 422. See
   [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md).
3. **`ZodError`** — 400 `Bad Request`, message `"Request validation failed"`.
4. **`ApiError`** — uses `error.statusCode` and `error.error` (a short
   label like `"Forbidden"`). `error.logCategory` is propagated to the
   structured log line as `errorCategory` (default `"API_REJECTED"`).
5. **Generic `Error`** — 500 `Internal server error` for 5xx, otherwise
   the HTTP status-text name. Generic errors log at `error` level;
   non-5xx reject log at `warn` level with category
   `"REQUEST_REJECTED"` (or `"VALIDATION_REJECTED"` for `ZodError`).

Every response body includes `correlationId` from `request.correlationId`.

## Sandbox signature

`verifySandboxSignature(headers, rawBody, secret, { windowMs?, now? })`:

- Default `windowMs` = `5 * 60_000` (5 minutes).
- Signed payload: `${timestamp}.${rawBody}`. The timestamp is taken from
  `X-Sandbox-Timestamp`; the signature from `X-Sandbox-Signature`.
- HMAC algorithm: `createHmac("sha256", secret)`.
- Constant-time comparison via `timingSafeEqual`.
- The `rawBody` is supplied by the Fastify content-type parser registered
  in `../routes/bookings.ts`:
  `parseAs: "buffer"` with a custom parser that stashes the body string on
  `request.rawBody`.

### Reason codes

| reason | Trigger | HTTP (in `routes/bookings.ts`) |
| --- | --- | --- |
| `missing_header` | Either `X-Sandbox-Signature` or `X-Sandbox-Timestamp` is absent. | 401 |
| `configuration_error` | `secret` is `undefined` OR is the placeholder string `"replace-with-a-local-random-secret-at-least-32-bytes"`. The placeholder comparison lives in `../routes/bookings.ts:12-13`; the `undefined` check lives in this file (`!secret`). | 401 |
| `malformed_timestamp` | Timestamp is not all-digits, or `Number(timestamp)` is not a positive safe integer. | 401 |
| `expired` | `|now - ts| > windowMs`. | 401 |
| `bad_signature` | Signature is not 64 hex chars, or HMAC comparison fails. | 401 |

### Configuration detection (two places)

The placeholder detection lives **only** in `routes/bookings.ts`:

```ts
const configuredSecret = process.env.SANDBOX_HMAC_SECRET?.trim();
const secret =
  configuredSecret &&
  configuredSecret !== "replace-with-a-local-random-secret-at-least-32-bytes"
    ? configuredSecret
    : undefined;
```

So in dev, leaving the `.env.example` value unchanged causes every callback
to fail with `configuration_error` (401). Production deployments must set
a real `SANDBOX_HMAC_SECRET`.

### Metric increment on rejection

`routes/bookings.ts` increments two metric series on `configuration_error` /
`bad_signature` / `expired` / `missing_header` / `malformed_timestamp`:

- `callback_verifications_total{callbackResult=<reason>}` — counter.
- `booking_gate_denials_total{errorCategory="callback_auth"}` — counter.

## Consumers

- `error-handler.ts` is consumed by `app.ts` via `setErrorHandler`.
- `sandbox-signature.ts` is consumed only by `routes/bookings.ts`.
- `auth.ts` is consumed only by `app.ts` (`onRequest` hook).

## Verification

- `npx vitest run tests/sandbox-signature.test.ts` — covers all 5 reason
  codes plus boundary cases.
- `npx vitest run tests/observability-hardening.test.ts` — exercises
  logger + metric integration under realistic inputs.
