/**
 * DRAFT Personal Research capability allow-list.
 *
 * Source of truth for which `personal_research_capability` values the owner
 * may confirm during DRAFT. The runtime check is `isPersonalResearchCapabilityAllowed`
 * invoked from:
 *   - `apps/api/src/routes/personal-research.ts` (confirm route, 422 on rejection)
 *   - `apps/api/src/agents/policy-gate.ts` (requirePersonalResearchAuthority)
 *   - `apps/api/src/tasks/handlers/personal-research-task-handler.ts` (dispatch)
 *
 * Rollout order matches `docs/draft-personal-research-implementation.md` §3.5:
 *   1. flight.search          — open
 *   2. hotel.search,
 *      accommodation.discovery,
 *      activities.search       — gated by §3.5 stage 2; open when contract tests land
 *   3. places.search,
 *      navigation.route,
 *      mobility.search         — gated by §3.5 stage 3
 *   4. visa.*                  — gated by §3.5 stage 4 (real VisaProvider contract
 *                                + DPA + credentials + audit + sandbox). The
 *                                capability enum does NOT include `visa.*`; adding
 *                                it requires its own enum-migration + PR.
 *
 * Each capability unlock requires, in one PR:
 *   1. Remove the matching `// ` comment in PERSONAL_RESEARCH_ALLOWED_CAPABILITIES.
 *   2. Add the corresponding typed input schema in apps/api/src/types/{schemas,domain}.ts.
 *   3. Add the corresponding executor in apps/api/src/services/personal-research-executors/.
 *   4. Add provider contract tests under apps/api/tests/personal-research/.
 *   5. Add the corresponding input/result card under apps/web/src/components/trips/personal-research/.
 */

export const PERSONAL_RESEARCH_OPERATION_CAPABILITIES = [
  "flight.search",
  "hotel.search",
  "accommodation.discovery",
  "activities.search",
  "places.search",
  "navigation.route",
  "mobility.search",
] as const;

export type PersonalResearchOperationCapability = (typeof PERSONAL_RESEARCH_OPERATION_CAPABILITIES)[number];

/**
 * Capabilities whose typed draft, executor, provider contract, authorization
 * tests, and UI cards have all landed in this milestone. Stage 1 only opens
 * `flight.search`; the rest stay commented until each is independently
 * unblocked by its prerequisite per spec §3.5.
 */
export const PERSONAL_RESEARCH_ALLOWED_CAPABILITIES = [
  "flight.search",
  // Stage 2 (partial) / Stage 3 (partial): unlocked once each capability had a
  // typed draft branch, an executor, provider contract tests covering both the
  // AVAILABLE and NOT_CONFIGURED paths, and its input/result cards. The rest of
  // stage 2 and 3 stay closed until their cards land — see the checklist above.
  "hotel.search",
  "accommodation.discovery",
  "activities.search",
  "places.search",
  "navigation.route",
  // `mobility.search` stays closed: it has no Amadeus credentials, so
  // opening it would only ever answer NOT_CONFIGURED.
  // `visa.*` remains stage 4 and is not in the capability enum at all.
] as const satisfies readonly PersonalResearchOperationCapability[];

export function isPersonalResearchCapabilityAllowed(
  capability: PersonalResearchOperationCapability,
): boolean {
  return (PERSONAL_RESEARCH_ALLOWED_CAPABILITIES as readonly string[]).includes(capability);
}
