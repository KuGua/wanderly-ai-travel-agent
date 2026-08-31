# Hotel Provider Switching — Runbook

**Scope:** Nuitee Connect / LiteAPI Rates (default) ↔ SerpApi Google Hotels
(legacy) switchable via `HOTEL_PROVIDER`.

**Spec:** [docs/nuitee-serpapi-hotel-provider-switching-implementation.md](nuitee-serpapi-hotel-provider-switching-implementation.md)

## 1. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `HOTEL_PROVIDER` | `disabled` | `disabled` → no adapter; `nuitee` → Nuitee adapter; `serpapi` → SerpApi adapter. Affects **newly accepted** tasks only. |
| `NUITEE_API_KEY` | empty | Required when `HOTEL_PROVIDER=nuitee`. Boot logs `nuitee (NOT_CONFIGURED)` when missing. |
| `NUITEE_BASE_URL` | `https://api.liteapi.travel` | Override for sandbox or controlled compatible server. |
| `NUITEE_HOTEL_TIMEOUT_MS` | `12000` | Per-request deadline. |
| `NUITEE_HOTEL_MAX_RETRIES` | `1` | Retry budget for transient 5xx/network errors. |
| `NUITEE_NATIONALITY_KMS_KEY_ID` | empty | When set, server uses this key to encrypt provider-only fields. Empty falls back to a process-local XOR pad (dev only). |
| `SERPAPI_HOTEL_ENABLED` | `false` | Required when `HOTEL_PROVIDER=serpapi`. |
| `SERPAPI_API_KEY` | empty | Required when `SERPAPI_HOTEL_ENABLED=true`. |

Boot logs the resolved selection once at startup:

```
[hotel] provider selection: serpapi
[hotel] provider selection: nuitee
[hotel] provider selection: nuitee (NOT_CONFIGURED — NUITEE_API_KEY missing)
[hotel] provider selection: disabled (HOTEL_PROVIDER=disabled)
```

## 2. Three-phase rollout

### Phase A — `HOTEL_PROVIDER=serpapi`

1. Deploy with `HOTEL_PROVIDER=serpapi` and confirm boot log shows
   `[hotel] provider selection: serpapi`.
2. Monitor 24 h:
   - `hotel_provider_requests_total{provider="serpapi_google_hotels"}`
     keeps emitting on user activity.
   - `hotel_provider_errors_total{provider="serpapi_google_hotels"}`
     stays at baseline (no schema drift, no 401/403).
   - `provider_search_cache_total{category="hotel"}` hit ratio stays
     within historical band.
3. Spot-check at least one accepted task in the DB:
   `SELECT id, hotel_provider FROM agent_task_runs ORDER BY created_at DESC LIMIT 20;`
   → `hotel_provider = 'serpapi_google_hotels'` for every PLAN/REPLAN/RESEARCH
   row with a hotel capability.

### Phase B — Nuitee sandbox

1. Pre-flight: confirm `NUITEE_API_KEY` resolves against the Nuitee
   sandbox account. The adapter hits
   `${NUITEE_BASE_URL}/v3.0/hotels/rates`; a 401/403 indicates the key
   is rejected by the supplier and the run must stay `serpapi`.
2. Deploy with `HOTEL_PROVIDER=nuitee` to a single canary pool. Watch
   `hotel_provider_errors_total{provider="nuitee_connect"}` —
   401/403/429 counts above 0 mean stop the rollout and roll back.
3. Verify authorization flow:
   - `PUT /api/v1/trips/:tripId/stay-search-provider-authorizations`
     with `{"provider":"nuitee_connect","field":"guest_nationality","value":"US"}`
     returns 201 with an id/version.
   - Subsequent `hotel.search` calls succeed when the row is ACTIVE;
     fail closed (`UNAVAILABLE/SEARCH_CONSTRAINTS_INCOMPLETE`) when the
     row is revoked.
4. Confirm DB rows:
   - `SELECT trip_id, member_id, status, version FROM stay_search_provider_authorizations ORDER BY granted_at DESC LIMIT 50;`
   - `select id, hotel_provider from agent_task_runs where hotel_provider='nuitee_connect' order by created_at desc limit 20;`

### Phase C — Default to Nuitee

1. Promote Nuitee to all pools: `HOTEL_PROVIDER=nuitee`.
2. Monitor 1 h / 24 h / 72 h:
   - Nuitee error rate stays below the per-account acceptable threshold.
   - `hotel_provider_latency_ms{provider="nuitee_connect"}` p95 stays
     under the SLA negotiated with the Nuitee account team.
   - No `HOTEL_PROVIDER_SWITCH_BLOCKED` audit events climbing
     unexpectedly.
3. Confirm `itinerary_plans` attached to Nuitee rows show the
   comparison-card source as `"Nuitee LiteAPI Rates"`.

## 3. Rollback

Setting `HOTEL_PROVIDER=serpapi` (or `disabled`) and rolling the
deployment restarts:

- New accepted tasks use the new selection.
- Already-accepted tasks continue against the adapter they were bound
  to via `agent_task_runs.hotel_provider`. The bound value never
  changes — rolling the env does **not** rewrite old rows.

**Never** modify `agent_task_runs.hotel_provider` directly or copy
offers across providers as a "rollback" — that would corrupt the
provenance invariant.

## 4. Monitoring

| Signal | Where | Action |
|---|---|---|
| Boot log missing | API logs | API did not run `createTravelProviders()`; restart. |
| `hotel_provider_errors_total{error_code="provider_not_approved"}` climbing | Metric dashboard | Credentials revoked by supplier. Page on-call. |
| Nuitee p95 latency > SLA × 1.5 for 5 min | Alert | Inspect supplier status page; consider temporary rollback to serpapi. |
| `HOTEL_PROVIDER_SWITCH_BLOCKED` audit climbing | Audit log | Run-bound provider requires authorization; trip members missing Nuitee auth. |
| Authorization `value_encrypted` in any log line | Log search | Privacy incident — escalate. |

## 5. Privacy and observability invariants

- Nationality is encrypted at rest in `stay_search_provider_authorizations`.
- Nationality MUST NOT appear in any log, trace, metric label, audit
  summary, plan DTO, fixture, or browser-side persistent state.
- Boot logs and metric labels only carry `provider=nuitee_connect |
  serpapi_google_hotels | unconfigured` — never the key, hotel name,
  price, offerId, or nationality.
- Cache key includes the provider identity; two providers' caches
  never collide.

## 6. Common tasks

### Confirm what is selected at runtime

```bash
kubectl logs -l app=api --tail=200 | grep "hotel] provider selection"
```

### List active authorizations for a trip

```bash
psql -c "SELECT id, member_id, version, granted_at, expires_at FROM stay_search_provider_authorizations WHERE trip_id = '…' AND status = 'ACTIVE';"
```

### Revoke a stuck authorization

```sql
UPDATE stay_search_provider_authorizations
   SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
 WHERE id = '…';
```

This cascades to `itinerary_plans` (set to `STALE` with
`stale_reason = 'quote_nationality_changed'`) so dependent plans
replan on next acceptance.
