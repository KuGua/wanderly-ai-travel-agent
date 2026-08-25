---
name: agents-overview
source-of-truth: ./
applies-to: [registry, gateway, error-handler, planning-service]
---

# `apps/api/src/agents/`

The `agents/` directory holds the Skill contract layer: the canonical Skill
interface, the registry that enforces versions/timeouts/auditing, the policy gate
that scopes tools per agent kind, and the `SkillError` taxonomy. Skills
themselves live one level down in `../skills/`; this directory only defines
how they are shaped, registered, invoked, and failed.

## Files

| File | Purpose | See also |
| --- | --- | --- |
| `contracts.ts` | `Skill<I,O>`, `SkillContext`, `PolicyGate`, `AgentKind`, `SkillScope` types. | [CONTRACT.md](./CONTRACT.md) |
| `policy-gate.ts` | `DefaultPolicyGate(agentKind)` — fixed scope allow-list per `AgentKind`. | [CONTRACT.md §Allowed tools](./CONTRACT.md) |
| `errors.ts` | `SkillError` + `SkillErrorCode` union + `SKILL_ERROR_STATUS` HTTP map. | [ERROR-CODES.md](./ERROR-CODES.md) |
| `skill-registry.ts` | `registerSkill`, `getSkill`, `invokeSkill`, `__resetRegistryForTests`. | [REGISTRY.md](./REGISTRY.md) |
| `personal-travel-agent.ts` | Wires the bounded Personal Skills, including safe recall and travel conversation, on startup. | [../../skills/personal/profile-memory.md](../../skills/personal/profile-memory.md) |
| `shared-trip-agent.ts` | Wires 2 Shared Skills on startup. | [../../skills/shared/plan-comparison.md](../../skills/shared/plan-comparison.md) |

## Cross-references

- All Skill implementation docs live in [../../skills/](../../skills/).
- Plan-output validator that runs after `plan.comparison` returns: [../../policy/VALIDATOR.md](../../policy/VALIDATOR.md).
- LLM gateway the registry implicitly depends on: [../../providers/LLM-GATEWAY.md](../../providers/LLM-GATEWAY.md).

## How to read this directory

1. Start with [CONTRACT.md](./CONTRACT.md) for the type shapes every Skill
   must satisfy.
2. Read [REGISTRY.md](./REGISTRY.md) for the runtime rules
   (optional expected-version compatibility, `Promise.race` timeout, `SKILL_INVOKE`
   audit emission).
3. Use [ERROR-CODES.md](./ERROR-CODES.md) when triaging a 4xx/5xx response
   from any Skill invocation.
