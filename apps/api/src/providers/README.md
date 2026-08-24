---
name: providers-overview
source-of-truth: ./
applies-to: [plan-comparison-skill, planning-service]
---

# `apps/api/src/providers/`

The `providers/` directory abstracts **all** outbound data sources — both the
LLM gateway and the deterministic travel-data fixtures — behind two
port-shaped interfaces. Skills never read providers directly; the Skill
registry hands them a `ModelGateway` and `services/planning-service` calls
typed flight/stay/ground providers.

## Files

| File | Purpose | See also |
| --- | --- | --- |
| `types.ts` | `FlightProvider`, `StayProvider`, `GroundProvider`, `VisaProvider`, `ProviderResult<T>` discriminated union (`LIVE \| FALLBACK_DEMO \| UNAVAILABLE`). | [README.md §ProviderResult](#providerresult-discriminated-union) |
| `fixture-provider.ts` | `FixtureFlightProvider`, `FixtureStayProvider`, `FixtureGroundProvider`, `FixtureVisaProvider`. Always returns `FALLBACK_DEMO`. |  |
| `model-gateway.ts` | `ModelGateway` interface + `MockModelGateway` (deterministic, signal-aware). | [LLM-GATEWAY.md](./LLM-GATEWAY.md) |
| `llm-gateway.ts` | `LLMGateway` — the only Skill that hits this is `plan.comparison`. | [LLM-GATEWAY.md](./LLM-GATEWAY.md) |
| `gateway-factory.ts` | `modelGateway()` singleton + `createModelGateway()` factory + `__setModelGatewayForTests`. Resolves `mock \| openai \| gemini \| openai-compatible` from env. | [LLM-GATEWAY.md §Provider resolution](./LLM-GATEWAY.md) |
| `fixtures.ts` | Hard-coded `FLIGHT_FIXTURES`, `STAY_FIXTURES`, `GROUND_FIXTURES`, `VISA_FIXTURES`, `SANDBOX_CALLBACK_FIXTURES`, plus `FIXTURE_VERSION` / `FIXTURE_CAPTURED_AT`. Version bump signals downstream that recorded demo data is stale. |  |

## `ProviderResult` discriminated union

`types.ts:40-58`:

```ts
type ProviderResult<T> =
  | { outcome: "LIVE";            data: T; source: string; capturedAt: string; }
  | { outcome: "FALLBACK_DEMO";   data: T; source: string; capturedAt: string;
                                   fixtureVersion: string;
                                   reason: "LIVE_PROVIDER_NOT_CONFIGURED" | "LIVE_PROVIDER_FAILED"; }
  | { outcome: "UNAVAILABLE";     reason: "FIXTURE_NOT_FOUND" | "PROVIDER_FAILED"; };
```

Callers must narrow on `outcome`:

- `LIVE` and `FALLBACK_DEMO` carry `data`; `UNAVAILABLE` does not.
- `FALLBACK_DEMO` carries `fixtureVersion` so the validator can match the
  recorded fixture epoch.
- `planning-service.ts:141-162` filters `UNAVAILABLE` out of the offer set
  before computing `validateProviderCoverage`.

## How to read this directory

1. Start with [LLM-GATEWAY.md](./LLM-GATEWAY.md) for the LLM constraint surface.
2. The fixture provider is what `planning-service.generatePlan` uses; the
   Skill registry uses the model gateway. Two different abstraction layers.

## Consumers

- `apps/api/src/services/planning-service.ts` — uses `FixtureFlightProvider`,
  `FixtureStayProvider`, `FixtureGroundProvider`.
- `apps/api/src/skills/shared/plan-comparison-skill.ts` — uses
  `modelGateway()` to dispatch to mock or real.

## Verification

- `npx vitest run tests/fixture-flight-provider.test.ts`
- `npx vitest run tests/fixture-planning.test.ts`
- `npx vitest run tests/llm-gateway.test.ts`