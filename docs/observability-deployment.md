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

### Local diagnostic fallback

Set `LOCAL_DEBUG_LOG_FILE=auto` for a locally started process to write daily
copies such as `apps/api/runtime/api-2026-09-01.ndjson` and
`worker-2026-09-01.ndjson`. The process identifies its own role, rotates when
the configured calendar day changes, and removes only its own dated files
older than the most recent seven calendar days at startup. Set
`LOCAL_LOG_TIMEZONE` to the same IANA zone for host-run and Docker processes
(for example `Asia/Singapore`); `UTC` is the portable default.

Docker Compose may continue to use `API_LOCAL_DEBUG_LOG_FILE=api-runtime.ndjson`
and `WORKER_LOCAL_DEBUG_LOG_FILE=worker-runtime.ndjson`: the `-runtime` suffix
is converted to the same `api-YYYY-MM-DD.ndjson` / `worker-YYYY-MM-DD.ndjson`
series. The runtime directory is mounted into both containers. It is written by
Pino and does not depend on Tempo or an OTLP endpoint, so it remains available
while trace export is disabled or the collector is down. The directory is
Git-ignored and must be treated as local diagnostic data.

Each `runtime_event` is a deliberately content-free lifecycle record for LLM
calls, tool dispatches, planner research and Worker tasks. It includes outcome,
duration, controlled operation/tool names, retry attempt, token total and a
SHA-256 output fingerprint where relevant. It never includes prompts,
completions, tool arguments/results, raw provider payloads, credentials,
private conversation text, profile fields, nationality or document data.

To inspect it in PowerShell:

```powershell
Get-Content .\runtime\api-$(Get-Date -Format yyyy-MM-dd).ndjson -Wait |
  Select-String '"runtime_event"'
```

### Bring up

```bash
cd apps/api
docker compose --profile full -f docker-compose.yml -f docker-compose.observability.yml up -d --build
```

The local `app` and `worker` services load their non-versioned runtime values
from `apps/api/.env`. Configure provider keys and local auth there; Compose
overrides only its Docker-networking and observability values. The Compose
stack explicitly uses `NODE_ENV=development` so the documented loopback-only
`custom-local` auth mode can run. A configured OTLP endpoint automatically
selects the OTLP exporter in non-test environments, so traces still go to
Tempo in that mode. The API port is published only to `127.0.0.1`; the
container-only `LOCAL_DEV_CONTAINER=true` exception permits its internal
`0.0.0.0` listener without widening local-auth access beyond the host.

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://tempo:4318` | `https://otlp-gateway-prod-<region>.grafana.net/otlp` |
| `OTEL_EXPORTER_OTLP_HEADERS` | _unset_ | `authorization=Bearer <GRAFANA_CLOUD_API_TOKEN>` |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | `0.05` |
| `OTEL_SERVICE_NAME` | `ai-travel-agent-api` (worker overrides) | same |

`apps/api/.env.production.example` shows the production values as a
template — **do not commit the bearer token**.

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

`.github/workflows/apps-api-deploy.yml` is the **manual** deploy workflow
(`workflow_dispatch` only; no automatic deploys). It:

1. Validates the supplied Grafana Cloud OTLP endpoint.
2. Updates the App Runner service runtime configuration: injects the four
   OTel env vars and the bearer-token secret reference via AWS Secrets
   Manager.
3. Reads the current Fargate Worker task definition, patches the
   container env with the same four OTel vars, registers a new task
   definition revision, and forces an ECS rolling deploy.
4. Skips the automated `verify-trace-end-to-end.sh` step (operators run
   it from a workstation with AWS access for a thorough check).

The deploy workflow never provisions AWS infrastructure; it only mutates
existing App Runner service / ECS task definition configurations.

### Verifying a trace end-to-end

`apps/api/scripts/verify-trace-end-to-end.sh` does the following:

1. Forces `OTEL_TRACES_SAMPLER_ARG=1.0` for the duration of the probe
   request so the trace is always sampled. This override does NOT affect
   the application's running sampling ratio — it applies only to the
   `curl` request this script generates. (The production default
   sampling ratio of 5% is documented in `apps/api/.env.production.example`.)
2. Generates a fresh W3C `traceparent` (`00-<32-hex>-<16-hex>-01`).
3. Calls `GET /health` with that header (no auth required, no PII).
4. Polls the OTLP backend's Tempo search API for the trace id (up to
   `TRACE_TIMEOUT_SECONDS`, default 30).
5. Exits non-zero on any timeout or HTTP error.

Production invocation:

```bash
cd apps/api
GRAFANA_CLOUD_API_TOKEN="<token-from-secrets-manager>" \
API_BASE_URL="https://<app-runner-dns>" \
GRAFANA_BASE_URL="https://<stack>.grafana.net" \
OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-prod-<region>.grafana.net/otlp" \
./scripts/verify-trace-end-to-end.sh
```

Local invocation:

```bash
cd apps/api
docker compose --profile full -f docker-compose.yml -f docker-compose.observability.yml up -d --build
API_BASE_URL=http://127.0.0.1:3000 \
GRAFANA_BASE_URL=http://127.0.0.1:3001 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 \
./scripts/verify-trace-end-to-end.sh
```

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
docker compose --profile full -f docker-compose.yml -f docker-compose.observability.yml up -d --build
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
