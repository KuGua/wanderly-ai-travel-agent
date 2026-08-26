---
name: observability-deployment
source-of-truth: ./
applies-to: [apps/api, apps/web, ECS Worker, App Runner, Grafana Cloud Free]
---

# Observability — local + production runbook

This runbook covers the two ways traces, logs, and metrics land in the AI
Travel Agent MVP. Both environments reuse the same OpenTelemetry SDK
wiring installed by PR 1-4 (`apps/api/src/observability/tracing.ts:1-401`).
Only the destination differs.

## Architecture

```
   Local dev (精简 docker-compose)               Prod (Grafana Cloud Free)
   ────────────────────────────               ─────────────────────────────────
   app ──OTLP/HTTP──► tempo ──┐                App Runner ──OTLP/HTTPS──►
   worker ──OTLP/HTTP─┘      │                                        ┐
                              ▼                                        ▼
                            Grafana :3001                    Grafana Cloud Free
                              (Tempo + dashboard)          (Tempo + Loki + Mimir
                                                                + Grafana + alerts)

   log: docker logs <svc> 2>&1 | jq             log: pino stdout → App Runner
                                                 stdout stream → CloudWatch
                                                 Logs → Loki (via managed
                                                 pipeline or operator export)
```

## Local dev (5 containers, ~15s cold start)

### Bring up

```bash
cd apps/api
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

This starts `postgres`, `app`, `worker`, `tempo`, and `grafana`. Ports:

| Service | Host | Notes |
|---|---|---|
| `app` (API) | `127.0.0.1:3000` | Standard API |
| `tempo` (OTLP) | `127.0.0.1:4317` (gRPC), `127.0.0.1:4318` (HTTP) | Receives from `app` and `worker` |
| `grafana` (UI) | `127.0.0.1:3001` | `admin` / `wanderly-dev` |
| `postgres` | `127.0.0.1:5432` | Standard local DB |

### Tear down

```bash
cd apps/api
docker compose -f docker-compose.yml -f docker-compose.observability.yml down
# To wipe traces and metrics too:
docker compose -f docker-compose.yml -f docker-compose.observability.yml down -v
```

### Inspect traces

Open Grafana at `http://127.0.0.1:3001`, sign in with `admin` /
`wanderly-dev`, then go to "AI Travel Agent / Trace / Log / Metric
correlation". Use the `trace_id` template variable (textbox at the top) to
paste a trace id and the dashboard renders the matching Tempo trace.

### Inspect logs

Local dev does **not** run Loki. The pino stdout of the API and Worker
containers already includes the `trace_id` field. Use the shell snippet
documented in the dashboard's "Logs by trace_id" panel:

```bash
# One container:
docker logs app 2>&1 | jq 'select(.trace_id == "<id>")'

# All services in the project:
docker compose -f docker-compose.yml -f docker-compose.observability.yml \
  logs --no-color 2>&1 | jq 'select(.trace_id == "<id>")'
```

### Inspect metrics

Local dev does **not** run Mimir. The API exposes its registry on the
`/metrics` endpoint:

```bash
curl -s http://127.0.0.1:3000/metrics | head -20
curl -s http://127.0.0.1:3000/metrics | grep ^agent_skill_runs_total
curl -s http://127.0.0.1:3000/metrics | grep ^agent_task_duration_ms
```

The dashboard's "Counters" panel documents these snippets in markdown.

## Production (Grafana Cloud Free)

The OTel SDK in `apps/api/src/observability/tracing.ts:1-401` reads four
environment variables to switch destinations:

| Env var | Dev (compose) | Prod (Grafana Cloud Free) |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://tempo:4318/v1/traces` | `https://otlp-gateway-prod-<region>.grafana.net/otlp` |
| `OTEL_EXPORTER_OTLP_HEADERS` | _unset_ | `authorization=Bearer <GRAFANA_CLOUD_API_TOKEN>` |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | `0.05` |
| `OTEL_SERVICE_NAME` | `ai-travel-agent-api` (worker overrides) | same |

`apps/api/.env.production.example` shows the production values as a
commented template — **do not commit the bearer token**.

### One-time Grafana Cloud setup

1. Create a free Grafana Cloud stack at `https://grafana.com/products/cloud/`.
2. Open the stack, go to "My account / stacks / <stack> / OpenTelemetry",
   copy the OTLP endpoint and create an API token with `metrics:write` and
   `traces:write` scopes.
3. Store the token in AWS Secrets Manager under
   `travel-agent/otel/grafana-cloud-token`. Reference it from:
   - App Runner service: `Runtime configuration secrets` →
     `OTEL_EXPORTER_OTLP_HEADERS = authorization=Bearer <token>`.
   - ECS Fargate Worker task: `secrets` block → inject as an env var.
4. In Grafana Cloud, go to "Dashboards / New / Import" and upload
   `apps/api/observability/dashboards/api-correlations.json` (works in
   both dev and prod). For production-only SLO dashboards, see
   `docs/observability-slo.md`.
5. In Grafana Cloud "Alerting", import the alert rules listed in
   `docs/observability-slo.md#alert-rules`. Each rule references the
   same Prometheus metric names so the rules survive a Grafana Cloud tier
   upgrade.

### CI / deploy

The deploy workflow (`.github/workflows/apps-api-deploy.yml`, added in
PR-B-slim) only updates the four OTel env vars on App Runner and the
Fargate task definition; it does not provision any infrastructure.

### Verifying a trace end-to-end

The verification script
`apps/api/scripts/verify-trace-end-to-end.sh` (PR-B-slim) does the
following:

1. Sets `OTEL_TRACES_SAMPLER_ARG=1.0` for the duration of the request so
   the trace is **always** sampled (overrides the prod 5% sampling).
2. Generates a fresh `traceparent` header.
3. POSTs `GET /health` (no PII, no auth, traces a real server span).
4. Polls Grafana Cloud's Tempo API for the trace id (up to 30s).
5. Exits non-zero on any timeout.

## Privacy invariants (local + prod)

- **Span attributes** are gated by
  `apps/api/src/observability/tracing.ts:51-94`. `safeSetAttribute` is
  the only allowed write path; `tests/spans-forbidden-attributes.test.ts`
  statically asserts no production source file uses a forbidden key.
- **Pino logs** redact 39 paths via
  `apps/api/src/observability/telemetry.ts:6-46`; trace_id / span_id are
  added AFTER the redact pass, so the bindings are never redacted.
- **Metric labels** are bounded by
  `apps/api/src/observability/metrics.ts:30-37`; high-cardinality
  identifiers are forbidden.
- **Browser OTel** is deferred (per `apps/web/.env.example:22-25`); the
  trace starts on the API's inbound HTTP server span.
- **Grafana Cloud Free tier**: 50 GB traces + 50 GB logs + 10k metrics
  series / month. SLO dashboards and alert rules must not exceed this
  budget — see `docs/observability-slo.md` for the burn-rate guidance.

## Verifying after a change

```bash
cd apps/api
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
sleep 15

# 1. OTLP reachability
curl -fsS http://tempo:4318/v1/traces -X POST \
  -H 'content-type: application/json' \
  --data '{"resourceSpans":[]}'

# 2. API reachability
curl -fsS http://127.0.0.1:3000/health

# 3. Grafana reachability
curl -fsS http://127.0.0.1:3001/api/health

# 4. trace_id appears in pino stdout (proves correlation works)
docker logs app 2>&1 | head -1 | jq -r '.trace_id // "no active span"'

# 5. /metrics serves Prometheus text
curl -fsS http://127.0.0.1:3000/metrics | head -3

# 6. New unit tests pass
npx vitest run tests/observability-endpoint.test.ts \
              tests/pino-stdout-trace-id.test.ts \
              tests/docker-compose-env.example.test.ts
```