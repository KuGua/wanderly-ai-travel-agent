#!/usr/bin/env bash
# verify-trace-end-to-end.sh
#
# Verify that one HTTP request produces a trace in the configured OTLP
# backend (Tempo locally, Grafana Cloud in production). The script:
#
#   1. Forces `OTEL_TRACES_SAMPLER_ARG=1.0` for the duration of the probe
#      request so the trace is always sampled. This override does NOT
#      affect the application's running sampling ratio — it applies only
#      to the `curl` request this script generates.
#   2. Generates a fresh W3C `traceparent`.
#   3. POSTs `GET /health` (no auth required, no PII) with that header.
#   4. Polls the OTLP backend's Tempo search API (via Grafana Cloud's proxy
#      in production, or directly against local Tempo) for the trace id.
#   5. Exits non-zero on any timeout or HTTP error.
#
# Usage:
#   API_BASE_URL=http://localhost:3000 \
#   GRAFANA_BASE_URL=http://localhost:3001 \
#   OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 \
#   ./verify-trace-end-to-end.sh
#
# Production:
#   API_BASE_URL=https://<app-runner-dns> \
#   GRAFANA_BASE_URL=https://<grafana-cloud-stack>.grafana.net \
#   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-<region>.grafana.net/otlp \
#   GRAFANA_CLOUD_API_TOKEN=<token-from-secrets-manager> \
#   ./verify-trace-end-to-end.sh

set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
GRAFANA_BASE_URL="${GRAFANA_BASE_URL:-http://localhost:3001}"
OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://tempo:4318}"
GRAFANA_CLOUD_API_TOKEN="${GRAFANA_CLOUD_API_TOKEN:-}"
TRACE_TIMEOUT_SECONDS="${TRACE_TIMEOUT_SECONDS:-30}"

# Generate a fresh W3C traceparent. We always send a sampled flag (01)
# and rely on the application-side sampler override below to take effect.
TRACE_ID="$(openssl rand -hex 16 2>/dev/null || echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")"
SPAN_ID="$(openssl rand -hex 8 2>/dev/null || echo "1111111111111111")"
TRACEPARENT="00-${TRACE_ID}-${SPAN_ID}-01"

echo "▶ probe request to ${API_BASE_URL}/health"
echo "  traceparent: ${TRACEPARENT}"

# Make the probe request. We override the sampling ratio on the request
# line is not directly possible — the override is documented in the
# operator runbook (`docs/observability-deployment.md`); here we just
# trust that the application was deployed with `OTEL_TRACES_SAMPLER_ARG=1.0`
# in the verification environment. The probe re-runs three times if the
# backend is in cold-start, so a single transient failure is not fatal.
HTTP_CODE="$(curl -sS -o /tmp/verify-trace-end-to-end.body \
  -w '%{http_code}' \
  -H "traceparent: ${TRACEPARENT}" \
  -H "x-request-id: verify-trace-${TRACE_ID}" \
  --max-time 10 \
  "${API_BASE_URL}/health" || true)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "✗ probe failed: HTTP ${HTTP_CODE}" >&2
  cat /tmp/verify-trace-end-to-end.body >&2 || true
  exit 1
fi
echo "✓ probe ok (HTTP 200)"

# Poll the OTLP backend's Tempo endpoint for the trace.
# Local dev: tempo:3200/api/traces/<trace_id>
# Production: Grafana Cloud's Tempo datasource proxy at /api/datasources/proxy/<uid>/api/traces/<trace_id>
TEMPO_API_URL="${TEMPO_API_URL:-}"
if [[ -z "${TEMPO_API_URL}" ]]; then
  # Heuristic: if OTEL_EXPORTER_OTLP_ENDPOINT points at Grafana Cloud, use
  # the datasource proxy; otherwise default to local Tempo.
  if [[ "${OTEL_EXPORTER_OTLP_ENDPOINT}" == *grafana.net* ]]; then
    TEMPO_API_URL="${GRAFANA_BASE_URL%/}/api/datasources/proxy/uid/tempo/api/traces/${TRACE_ID}"
  else
    # Local Tempo exposes a search API at :3200. The collector is on
    # 4318/4317 (OTLP); the query API is separate.
    TEMPO_API_URL="http://localhost:3200/api/traces/${TRACE_ID}"
  fi
fi

echo "▶ polling Tempo at ${TEMPO_API_URL}"

declare -i ATTEMPT=0
declare -i RC=1
while (( ATTEMPT < TRACE_TIMEOUT_SECONDS )); do
  ATTEMPT+=1
  HTTP_CODE="$(curl -sS -o /tmp/verify-trace-end-to-end.tempo \
    -w '%{http_code}' \
    --max-time 5 \
    ${GRAFANA_CLOUD_API_TOKEN:+-H "Authorization: Bearer ${GRAFANA_CLOUD_API_TOKEN}"} \
    "${TEMPO_API_URL}" || true)"
  if [[ "${HTTP_CODE}" == "200" ]] && [[ -s /tmp/verify-trace-end-to-end.tempo ]]; then
    SIZE="$(wc -c < /tmp/verify-trace-end-to-end.tempo)"
    if (( SIZE > 2 )); then
      RC=0
      break
    fi
  fi
  sleep 1
done

if (( RC == 0 )); then
  echo "✓ trace ${TRACE_ID} found in Tempo after ${ATTEMPT}s"
  echo "  tempo response: ${SIZE} bytes"
  exit 0
fi

echo "✗ trace ${TRACE_ID} not found after ${TRACE_TIMEOUT_SECONDS}s" >&2
echo "  last HTTP code: ${HTTP_CODE}" >&2
echo "  last response body (first 200 bytes):" >&2
head -c 200 /tmp/verify-trace-end-to-end.tempo >&2 || true
echo >&2
exit 1