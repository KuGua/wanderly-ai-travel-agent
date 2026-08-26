---
name: observability-slo
source-of-truth: ./
applies-to: [apps/api, apps/web, ECS Worker, App Runner, Grafana Cloud Free]
---

# Observability SLO & SLI Definitions

This document defines the Service Level Indicators (SLIs) and Service Level
Objectives (SLOs) for the AI Travel Agent MVP. These are the targets that
the Grafana Cloud Free alert rules and dashboards must enforce. They are
grounded in the metrics already exported by `apps/api/src/observability/metrics.ts`
and the latency surfaces documented in
`apps/api/src/observability/README.md`.

## Scope

- **API surface** — every authenticated endpoint under `/api/v1` plus the
  anonymous `POST /api/v1/explore/location-reference` and the
  HMAC-verified `POST /api/v1/bookings/callback`.
- **Worker surface** — `agent_task_worker.run` execution path
  (`apps/api/src/workers/agent-task-worker.ts`).
- **Persistence layer** — Postgres writes via Drizzle
  (`apps/api/src/db/schema.ts`).

## SLI catalogue

| ID | SLI | Source series | Computed by |
|---|---|---|---|
| `sli.api.latency` | HTTP request p95 latency | `http.request.duration_ms` (Tempo histogram derived from `http.*` spans) | Grafana Cloud |
| `sli.api.errors` | Fraction of HTTP responses with status ≥ 500 | `http.response.status_class=5xx / total` | Tempo query |
| `sli.api.success` | Fraction of HTTP responses with status < 500 | `1 - sli.api.errors` | Tempo query |
| `sli.worker.success` | `agent_task_outcomes_total{outcome="completed"} / sum by(operation)` | `apps/api/src/observability/metrics.ts:218-225` | Prometheus query on `/metrics` |
| `sli.worker.recovery` | `agent_task_recoveries_total / sum` bounded to 5% | `apps/api/src/observability/metrics.ts:222-225` | Prometheus query |
| `sli.llm.errors` | `provider_fallback_total / (provider_fallback_total + llm_request_latency_ms_count)` | `apps/api/src/observability/metrics.ts:194-209` | Prometheus query |
| `sli.plan.validation` | `plan_validation_failures_total / plan generated count` ≤ 1% | `apps/api/src/observability/metrics.ts:188-193` | Prometheus query |
| `sli.booking.gate.denied` | `booking_gate_denials_total` alerted on rate > 5/min | `apps/api/src/observability/metrics.ts:202-205` | Prometheus query |

## SLO targets (30-day rolling windows)

| SLO | Target | Burn-rate alert | Window |
|---|---|---|---|
| API availability | 99.0% over 30 days | 1% (1-hour) and 5% (6-hour) burn | 30d |
| API p95 request latency | ≤ 500 ms over 30 days | 2× p95 for 10 min | 30d |
| Worker task success rate | ≥ 99.0% over 30 days | 2% burn for 30 min | 30d |
| Plan validation failure rate | ≤ 1% over 30 days | 5× for 30 min | 30d |
| Booking callback auth failure | ≤ 0.5% over 30 days | 5× for 15 min | 30d |

Burn rate = (1 − observed SLI) / (1 − SLO target). At SLO target the burn
rate is 1.0; at 5× the error budget is being consumed 5× faster than
sustainable.

## Trace-sampling caveat

`OTEL_TRACES_SAMPLER_ARG=0.05` in production samples 5% of traces. SLO
calculations on the Loki log side and the Prometheus metric side are
**unaffected** — they aggregate from the full stream. Trace-level SLIs
(p95 latency derived from Tempo) are subject to 5% sampling and carry an
order-of-magnitude higher variance; treat them as diagnostic, not as
authoritative targets.

## Grafana Cloud dashboards

Three dashboards are required (the bundled `api-correlations.json` covers
the dev experience; the production dashboards live in Grafana Cloud):

1. **API overview** — request rate, error rate, p50/p95/p99 latency from
   the `http.*` spans.
2. **Worker outcomes** — `agent_task_outcomes_total` by outcome, plus the
   recovered/expired split; co-located with the
   `agent_task_duration_ms` histogram.
3. **LLM gateway** — `llm_request_latency_ms` by provider and outcome,
   plus `provider_fallback_total` by error_code.

## Alert rules

| Alert | Condition | Severity | Notification channel |
|---|---|---|---|
| API p95 latency degraded | `sli.api.latency > 1000 ms for 10 min` | warning | Slack `#travel-agent-ops` |
| API error rate spike | `sum(rate(http.response.status_class="5xx", 5m)) > 1` | critical | Slack + PagerDuty |
| Worker task success collapsed | `sli.worker.success < 90% over 30m` | critical | Slack + PagerDuty |
| Plan validation regression | `sli.plan.validation > 5% for 30 min` | critical | Slack |
| Booking callback HMAC flood | `rate(callback_verifications_total{result="bad_signature", 1m) > 10` | critical | Slack + PagerDuty |

The rules live in Grafana Cloud "Alerting" — they reference the Prometheus
metric names so the same rule survives a Grafana Cloud tier upgrade.

## Privacy invariants

SLO dashboards do **not** include:

- `userId`, `tripId`, `planId`, `bookingId`, `conversationId`,
  `threadId` — high-cardinality labels forbidden by
  `apps/api/src/observability/metrics.ts:30-37`;
- PII paths — `passportNumber`, `nationality`, `dateOfBirth`,
  `memberPreferences`, `prompt`, `question`, `body,
  `message` — see
  `apps/api/src/observability/tracing.ts:51-94`.

When defining an alert, the rule expression uses
low-cardinality bounded labels only. Free-form search across traces is
performed by `trace_id` exclusively — never by user/trip/plan id.

## Iteration cadence

- Review SLOs at the end of every release cycle (currently manual, no
  automation in MVP).
- Adjust targets only with a written justification in the release
  notes — never silently.
- Burn-rate alerts are tuned quarterly based on observed traffic patterns.