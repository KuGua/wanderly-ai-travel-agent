# Constraint Documentation

This index is the single entry point into the **constraint** documentation for
`apps/api/`. It sits next to the **product** documentation
(`PRD.md`, `backlog.md`, `frontend-ui-plan.md`) — same `docs/` directory,
different audience.

## Product vs. Constraint

| Folder | Purpose | Audience |
| --- | --- | --- |
| `docs/PRD.md`, `docs/backlog.md`, … | What we are building and why. | Product, hackathon judges, new team members. |
| `docs/CONSTRAINTS.md` (this file) | Where the LLM constraint surface lives and how to read it. | Engineers + AI agents who touch `apps/api/src/`. |

The actual constraint documents are **collocated** with the `.ts` files
they describe — see the table below. This index just lists them.

## Index

| Document | Source-of-truth `.ts` |
| --- | --- |
| [`apps/api/migrations/0005_hardening_constraints.sql`](../migrations/0005_hardening_constraints.sql) | unique indexes + audit correlation lookup + `audit_action` enum gap fix (`VISA_CHECK`, `PLAN_RESTART`); idempotent via `CREATE … IF NOT EXISTS` and `ALTER TYPE … ADD VALUE IF NOT EXISTS` |
| [`apps/api/src/agents/README.md`](../src/agents/README.md) | directory overview |
| [`apps/api/src/agents/CONTRACT.md`](../src/agents/CONTRACT.md) | `src/agents/contracts.ts` |
| [`apps/api/src/agents/REGISTRY.md`](../src/agents/REGISTRY.md) | `src/agents/skill-registry.ts` |
| [`apps/api/src/agents/ERROR-CODES.md`](../src/agents/ERROR-CODES.md) | `src/agents/errors.ts` |
| [`apps/api/src/policy/README.md`](../src/policy/README.md) | directory overview |
| [`apps/api/src/policy/VALIDATOR.md`](../src/policy/VALIDATOR.md) | `src/policy/plan-output-validator.ts`, `src/policy/snapshot-policy.ts` |
| [`apps/api/src/providers/README.md`](../src/providers/README.md) | directory overview |
| [`apps/api/src/providers/LLM-GATEWAY.md`](../src/providers/LLM-GATEWAY.md) | `src/providers/llm-gateway.ts`, `src/providers/gateway-factory.ts`, `src/providers/types.ts` |
| [`apps/api/src/observability/README.md`](../src/observability/README.md) | `src/observability/{metrics,telemetry,redaction,agent-runs}.ts` |
| [`apps/api/src/services/AUDIT.md`](../src/services/AUDIT.md) | `src/services/audit-service.ts` |
| [`apps/api/src/middleware/README.md`](../src/middleware/README.md) | `src/middleware/{error-handler,sandbox-signature,auth}.ts` |
| [`apps/api/src/skills/personal/profile-memory.md`](../src/skills/personal/profile-memory.md) | `src/skills/personal/profile-memory-skill.ts` |
| [`apps/api/src/skills/personal/profile-change-proposal.md`](../src/skills/personal/profile-change-proposal.md) | `src/skills/personal/profile-change-proposal-skill.ts` |
| [`apps/api/src/skills/personal/consent-explanation.md`](../src/skills/personal/consent-explanation.md) | `src/skills/personal/consent-explanation-skill.ts` |
| [`apps/api/src/skills/shared/plan-comparison.md`](../src/skills/shared/plan-comparison.md) | `src/skills/shared/plan-comparison-skill.ts` (only LLM-calling Skill) |
| [`apps/api/src/skills/shared/readiness-check.md`](../src/skills/shared/readiness-check.md) | `src/skills/shared/readiness-skill.ts` |
| [`apps/api/src/skills/REVIEW.md`](../src/skills/REVIEW.md) | `AgentKind="review"` (no Skills registered) |

## How to keep docs in sync

```bash
cd apps/api
npm run docs:verify     # runs scripts/verify-docs.ts
```

This independent script:

1. Parses each markdown's front-matter `source-of-truth:` field and asserts
   the referenced `.ts` file exists.
2. For every Skill doc, dynamically imports the Skill module and asserts
   `name`, `allowedTools.length`, `timeoutMs`, `needsConfirm`, `version`
   match the doc's "注册元数据" table.
3. For every framework doc, greps the source file for symbols the doc
   claims to enumerate (e.g. `PlanViolationCode`, `SkillScope`,
   `LOGGER_REDACT_PATHS`) and asserts all values are covered.
4. For every Skill doc, asserts the "失败模式" table covers every error
   code the Skill can throw.
5. Asserts `src/skills/REVIEW.md` exists and that no Skill file declares
   `agent: "review"`.

The script must be added to `.github/workflows/*.yml` between lint and test
to block drift in CI.
