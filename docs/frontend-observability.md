# Frontend observability

The browser contributes **content-free diagnostics** to the existing API logs
and Tempo traces. This makes a failed user action traceable without enabling
browser OpenTelemetry or collecting private travel data.

## What is recorded

Authenticated browser sessions send `POST /api/v1/diagnostics/ui-events` for
normal API requests and for deduplicated browser render/unhandled errors. The
strict contract contains only:

- a fixed action name, page category, outcome and error category;
- bounded HTTP status and elapsed milliseconds; and
- UUID request/correlation references for log and trace correlation.

The API rate-limits events (60 per source IP per minute), validates the body
with a strict schema, writes a `runtime_event.component="ui"` Pino record,
and creates the normal HTTP trace in Tempo. `ui_diagnostic_events_total` is a
low-cardinality counter with only action/outcome/error-category labels.

The diagnostic send is best-effort with a 500 ms timeout. A failure to record
diagnostics never blocks the underlying button action, navigation, retry or
Agent request.

## What is deliberately not recorded

The client and API reject or omit prompt/chat text, form values, URLs and
query strings, raw request/response bodies, error messages, stacks, profile
or travel-document fields, credentials, tokens and cookies. IDs are never
metric labels. The endpoint remains authenticated: sign-in failures from a
user who has no access token are not sent to the server.

Browser OpenTelemetry remains disabled pending a separate privacy review.

## Local debugging

Reproduce the issue, copy the correlation ID shown by the error UI (when the
business API returned one), then search the local API log:

```powershell
Get-Content apps/api/runtime/api-runtime.ndjson |
  Select-String '"component":"ui"'

Get-Content apps/api/runtime/api-runtime.ndjson |
  Select-String '<correlation-id>'
```

Open Grafana at `http://127.0.0.1:3001` and use Explore → Tempo to search the
same trace/correlation context. Local development does not run Loki, so
NDJSON is the local log query surface; Tempo is the request/Agent/Tool timing
surface.

## Scope and extension

The initial allow-list covers profile save, Trip activation/thread creation,
conversation submission, Agent cancellation, invitation choices, plan and
booking confirmation. Adding an action requires updating both the browser and
API allow-lists, metrics allow-list, and the privacy tests. Do not pass a
button label, route URL, user input or raw error to the reporter.
