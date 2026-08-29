---
name: shared.activities.search
source-of-truth: ./activities-search-skill.ts
agent: shared
status: implemented
---

# `shared.activities.search` Skill

Provider-neutral, snapshot-bound activity discovery backed by Viator's official
Experiences MCP. The model may select only a destination already present in the
immutable planning snapshot plus a fixed theme and locale. Dates and execution
authority are injected by the server.

The adapter returns normalized, non-bookable evidence. Viator click-off links
and currency-less price numbers are validated for provider schema drift and then
discarded. A timeout, rate limit, upstream error, empty result or malformed
response returns a bounded `UNAVAILABLE` code; fixtures are never used at
runtime.

Configuration and verification are documented in
`docs/activities-tool-implementation.md`.

## 注册元数据

| Field | Value | Source |
| --- | --- | --- |
| `name` | `activities.search` | constant |
| `agent` | `shared` | constant |
| `version` | `1.0.0` | constant |
| `allowedTools` | `["snapshot:read", "activities:search"]` | `skill.allowedTools` |
| `timeoutMs` | `12000` | hard skill deadline |
| `needsConfirm` | `false` | read-only discovery |

## 失败模式

| Code | Trigger |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Non-shared policy attempted to invoke this skill |
| `SNAPSHOT_REQUIRED` | Shared invocation omitted the immutable snapshot |
| `INPUT_INVALID` | Model arguments fail the strict input schema |
| `POLICY_DENIED` | Snapshot/run authority or destination/date constraints do not match |
| `OUTPUT_INVALID` | Normalized handler output fails the strict output schema |
| `TIMEOUT` | The 12-second skill deadline expires |
| `UPSTREAM_FAILURE` | The configured MCP fails outside a bounded provider result |
