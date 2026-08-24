---
name: review-agent-placeholder
source-of-truth: ./../agents/personal-travel-agent.ts + ./../agents/shared-trip-agent.ts
agent: review
status: no-skills
---

# `review` Agent

The `AgentKind` literal `"review"` exists in the type system
(`apps/api/src/agents/contracts.ts:5`), and `DefaultPolicyGate` declares a
scope allow-list for it:

```ts
review: ["snapshot:read", "plan:write:propose"]
```

See [`../agents/policy-gate.ts`](../agents/policy-gate.ts) and
[`../agents/CONTRACT.md` §Allowed tools](../agents/CONTRACT.md).

**However, no Skill is currently registered under the `review` agent.**

This document exists so the agent_kind stays visible in the registry, the
policy gate, and any future code that reads `AgentKind`. `verify-docs.ts`
asserts (1) `grep -r 'agent: "review"' src/skills/ -l` returns zero results,
and (2) this file's `status: no-skills` front-matter is present.

## What `review` is intended for

When implemented, `review`-agent Skills will read the snapshot and
existing plan output without producing new authoritative state (similar to
`plan.comparison` but read-only or review-only). Plausible first Skills:

- A `plan.diff_explainer` that produces a human-readable summary of why the
  current plan diverges from the previous plan after a change event.
- A `consistency.check` that re-walks the snapshot against the latest
  `itinerary_plan` and reports any drift.

Neither of these is wired up today. When added, each must:
- declare `agent: "review"`;
- declare `allowedTools: ["snapshot:read", "plan:write:propose"]` (or a
  subset);
- export a Skill object that the appropriate agent file registers.

## Verification

- `cd apps/api && npx tsx scripts/verify-docs.ts` asserts
  `src/skills/REVIEW.md` exists and that no Skill file under `src/skills/`
  declares `agent: "review"`.
- `npx vitest run tests/skill-registry.test.ts` exercises registration of
  the `personal` and `shared` agents only.