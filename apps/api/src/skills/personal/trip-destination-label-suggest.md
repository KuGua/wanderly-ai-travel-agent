---
name: trip.destination.label.suggest
source-of-truth: ./trip-destination-label-suggest-skill.ts
agent: personal
status: implemented
---

# trip.destination.label.suggest

Owner-triggered suggestion for the display-only `shared_trips.title_destination_label`.
The model sees at most three of the owner's own USER messages, server-truncated to
≤512 characters each, and returns a single `{ kind, value }` slot where `kind`
is `COUNTRY` or `CITY` and `value` is the canonical reference name. The route
runs every result through `services/trip-destination-label-postprocess.ts`,
which re-resolves `value` against the location reference data and refuses
free-text or unverifiable strings — so this skill never writes a free-text
label into the trip row.

Language authority is the server-validated `locale`; this skill has no
"current question" so the message language cannot be inferred.

## Registration metadata

| Attribute | Value |
| --- | --- |
| `name` | `trip.destination.label.suggest` |
| `agent` | `personal` |
| `version` | `1.0.0` |
| `allowedTools` | `[]` |
| `timeoutMs` | `4000` |
| `needsConfirm` | `false` |

## Input

```ts
{
  tripId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  messages: z.array(z.object({ text: z.string().min(1).max(512) })).min(1).max(3),
}
```

## Output

```ts
{ kind: z.enum(["COUNTRY", "CITY"]), value: z.string().min(1).max(64) }
```

## Privacy contract

The skill never receives the owner's profile, long-term memory, other
threads, assistant messages, consent state, member information, or the
trip's brief columns. The closed vocabulary plus the postprocess reparse
make a free-text label structurally unreachable: any output that does not
round-trip through `resolveDestinationReference` (CITY) or
`resolveCountryLabel` (COUNTRY) is rejected with `REJECTED`, leaving the
trip title unchanged.

## 失败模式

| Error code | 触发条件 |
| --- | --- |
| `TIMEOUT` | `invokeSkill` 的 `AbortController.timeout(4000)` 触发（registry 自管） |
| `INPUT_INVALID` | `input.parse` 失败（registry 自管） |
| `OUTPUT_INVALID` | gateway 返回值无法通过 `tripDestinationLabelSuggestOutputSchema.safeParse` |
| `UPSTREAM_FAILURE` | gateway 未实现 `generateTripDestinationLabel` 或调用抛错 |
| `TOOL_NOT_ALLOWED` | `allowedTools` 含被 personal 策略拒绝的 scope（registry 自管） |
| `SKILL_VERSION_MISMATCH` | 调用方传 `expectedVersion` 与注册版本不一致（registry 自管） |
| `NETWORK` / `RATE_LIMITED` / `UPSTREAM_5XX` | 框架通用错误（registry 自管） |

The route maps every `UPSTREAM_FAILURE` and `OUTPUT_INVALID` to the
user-visible reason `UNAVAILABLE`. Postprocess rejects are mapped to
`REJECTED`. The route never throws to the framework on business failure.
