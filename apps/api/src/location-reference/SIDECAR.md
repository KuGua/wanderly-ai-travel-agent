---
source-of-truth: ./location-reference-source.ts
status: framework-doc
---

# Location-Reference Source Abstraction

The public `POST /api/v1/explore/location-reference` endpoint and the internal
`resolveConversationPlace()` helper in `policy/conversation-safety.ts` both need
to resolve a `(latitude, longitude)` pair to a `LocationReference`. They go
through a single source-of-truth abstraction so the same contract is enforced
regardless of where the GeoJSON data physically lives.

## Modes

The source is selected once at process startup by the `LOCATION_REFERENCE_MODE`
environment variable. The three modes are:

| Mode          | Behavior                                                                                                                                   | Where data lives               |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------|
| `in-process`  | Direct call to `getLocationReferenceResolver()`. Current default; identical behavior to pre-sidecar builds.                                | API process memory (~300 MB)  |
| `sidecar`     | HTTP `POST /resolve` to `${LOCATION_REFERENCE_SIDECAR_URL}` with `LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS` (default 2000) timeout.           | Sidecar container             |
| `disabled`    | Returns `{ outcome: "NO_REFERENCE", ... }` synchronously without reading any data file.                                                   | n/a (no allocation)           |

If `LOCATION_REFERENCE_MODE` is unset the source defaults to `in-process`,
which preserves every test, every CI run, and every production deploy with
zero configuration change.

## Contract

The source returns a `LocationReference` (the discriminated union on
`outcome` exported by `location-reference-resolver.ts`) and must validate the
result with `locationReferenceResponseSchema` before returning. A sidecar
that ever returns a malformed body fails closed exactly as an in-process
dataset read failure does — the public route emits `503
LOCATION_REFERENCE_UNAVAILABLE` and the internal caller falls back to
`sourceType: "INSPIRATION"`.

## Failure modes

| Scenario                                    | Public route behavior                       | Internal caller behavior                          |
|---------------------------------------------|---------------------------------------------|---------------------------------------------------|
| `in-process` and dataset file missing       | `503 LOCATION_REFERENCE_UNAVAILABLE`        | throws → propagates as 500 (existing)             |
| `sidecar` HTTP 5xx                          | `503 LOCATION_REFERENCE_UNAVAILABLE`        | catches → `sourceType: "INSPIRATION"` (soft fail) |
| `sidecar` timeout (>2s)                     | `503 LOCATION_REFERENCE_UNAVAILABLE`        | catches → `sourceType: "INSPIRATION"`             |
| `sidecar` HTTP 4xx (schema drift)           | `503 LOCATION_REFERENCE_UNAVAILABLE`        | catches → `sourceType: "INSPIRATION"`             |
| `sidecar` connection refused                | `503 LOCATION_REFERENCE_UNAVAILABLE`        | catches → `sourceType: "INSPIRATION"`             |
| `disabled`                                  | `200 NO_REFERENCE`                          | returns `{ ...place, sourceType: "INSPIRATION" }` |

The sidecar never silently degrades to `in-process` at runtime — that would
silently load ~300 MB into the API process the operator was trying to keep
small. Operators flip the flag explicitly.

## Observability gap

The sidecar is intentionally dev-only and **does NOT** emit OpenTelemetry
spans. The Tempo dashboard will show the API→sidecar hop as a trace gap.
This is acceptable because:

- Production deploys use `in-process` (the default) and never touch the sidecar.
- The sidecar itself is a deterministic resolver with no external calls —
  its 200 / 503 outcomes are sufficient telemetry on the API side via the
  existing `location_reference_requests_total` counter.

## Threat model

- The sidecar **is not** internet-facing. It binds to `127.0.0.1` in the
  docker-compose profile and is never placed behind the public ingress.
- The sidecar **does not** authenticate callers. It assumes the network is
  trusted (loopback / internal docker network). Production must not deploy
  the sidecar.
- The sidecar **does not** rate-limit. Rate limiting stays at the API
  route (`LocationReferenceRateLimiter`); duplicating it at the sidecar
  would double-count.
- The sidecar **never** persists coordinates, audit, or logs. The same
  PII rules from `docs/location-reference-data.md` apply.