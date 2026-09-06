import { randomUUID } from "node:crypto";
import type { ModelGateway, ModelToolDefinition, PlanningEvidenceCatalog } from "../providers/model-gateway.js";
import type { ProviderUnavailableCode, ResearchSummaryReason } from "../types/domain.js";
import { db } from "../db/database.js";
import {
  constraintSnapshots,
  itineraryPlans,
  sourceEvidence,
  providerOffers,
  providerSearchRuns,
  agentTaskRuns,
  tripSearchPreferences,
  tripConstraintFacts,
  tripMembers,
  preferenceFacts,
  planningResearchResults,
  tripStaySearchPreferences,
} from "../db/schema.js";
import { eq, and, desc, gt, inArray, ne } from "drizzle-orm";
import { buildAuthorizedData, getActiveConsents } from "./consent-service.js";
import {
  MemorySourceChangedError,
  computeMemorySourceFingerprint,
  fingerprintFromSnapshot,
} from "./memory-source-fingerprint.js";
import {
  buildMemoryNamespace,
  buildMemoryProjection,
  type MemoryProjectionInput,
} from "./memory-projection-builder.js";
import { buildSharedPlanningMemoryInput } from "../skills/shared/memory-projection-input.js";
import { safePublicExplanationTokensFor } from "../policy/constraint-field-catalog.js";
import { withMemorySpan } from "../memory/memory-spans.js";
import { metrics } from "../observability/metrics.js";
import { createTravelProviders, resolveBoundHotelProvider } from "../providers/live-provider-factory.js";
import { modelGateway, __setModelGatewayForTests } from "../providers/gateway-factory.js";
import type {
  AccommodationDiscoveryProvider,
  ActivitiesProvider,
  HotelProvider,
  FlightProvider,
  MobilityOfferProvider,
  NavigationProvider,
  PlaceSearchProvider,
  TransitJourneyProvider,
} from "../providers/types.js";
import { PlanValidationError, validatePlanOutput } from "../policy/plan-output-validator.js";
import { DefaultPolicyGate } from "../agents/policy-gate.js";
import { SkillError } from "../agents/errors.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { airportServesCity, resolveAirportReference, resolveFlightRouteMatrix } from "../location-reference/airport-reference.js";
import { logSafeRuntimeEvent, pinoInstance } from "../observability/telemetry.js";
import { resolveTripDestinationReference } from "./destination-reference-service.js";
import { flightSearchModelArgumentsSchema, normalizeFlightProviderResult } from "./flight-search-service.js";
import { activitiesSearchModelArgumentsSchema } from "./activities-search-service.js";
import { placeSearchModelArgumentsSchema } from "./place-search-service.js";
import { navigationRouteModelArgumentsSchema } from "./navigation-route-service.js";
import { tripPlaceModelArgumentsSchema } from "../skills/shared/trip-place-skill.js";
import { hotelSearchModelArgumentsSchema } from "./hotel-search-service.js";
import { accommodationDiscoveryModelArgumentsSchema } from "./accommodation-discovery-service.js";
import { loadCurrentConfirmedSearchPreferences } from "./flight-search-preferences-service.js";
import { loadCurrentStaySearchPreferences } from "./stay-search-preferences-service.js";
import { evaluateFlightResearchCompleteness, flightMatrixToGaps, FlightResearchIncompleteError } from "./flight-research-matrix-service.js";
import {
  activitiesMatrixToGaps,
  evaluateActivitiesResearchCompleteness,
  ActivitiesResearchIncompleteError,
} from "./activities-research-matrix-service.js";
import { evaluateHotelResearchCompleteness, hotelMatrixToGaps, HotelResearchIncompleteError } from "./hotel-research-matrix-service.js";
import {
  accommodationMatrixToGaps,
  evaluateAccommodationResearchCompleteness,
  AccommodationResearchIncompleteError,
} from "./accommodation-research-matrix-service.js";
import { recordAudit } from "./audit-service.js";
import { classifyError, serviceGapSchema, RECORD_RESEARCH_RESULT_MAX_GAPS } from "./planning-research-result-service.js";
import { toCritiques } from "./plan-critique.js";
import type { RequestContext } from "../utils/context.js";
import type { AccommodationEvidence, ActivityEvidence, FlightOffer, StayOffer, HotelOffer, PlaceCandidate, ServiceGap } from "../types/domain.js";
import { bindPlanSelectionsToEvidence, preflightCategorySlots } from "./plan-evidence-binding.js";

export interface PlanningDependencies {
  flightProvider: FlightProvider;
  placeProvider: PlaceSearchProvider;
  navigationProvider: NavigationProvider;
  mobilityOfferProvider: MobilityOfferProvider;
  transitJourneyProvider: TransitJourneyProvider;
  activitiesProvider?: ActivitiesProvider;
  hotelProvider?: HotelProvider;
  accommodationDiscoveryProvider?: AccommodationDiscoveryProvider;
  modelGateway: ModelGateway;
}

const configuredProviders = createTravelProviders();
let planningDependenciesOverride: PlanningDependencies | null = null;

export function __setModelGateway(gateway: ModelGateway): void {
  __setModelGatewayForTests(gateway);
}

export function __setPlanningDependenciesForTests(
  dependencies: PlanningDependencies | null,
): void {
  planningDependenciesOverride = dependencies;
}

function resolvePlanningDependencies(): PlanningDependencies {
  if (planningDependenciesOverride) return planningDependenciesOverride;

  return {
    flightProvider: configuredProviders.flightProvider,
    placeProvider: configuredProviders.placeProvider,
    navigationProvider: configuredProviders.navigationProvider,
    mobilityOfferProvider: configuredProviders.mobilityOfferProvider,
    transitJourneyProvider: configuredProviders.transitJourneyProvider,
    activitiesProvider: configuredProviders.activitiesProvider,
    hotelProvider: configuredProviders.hotelProvider,
    accommodationDiscoveryProvider: configuredProviders.accommodationDiscoveryProvider,
    modelGateway: modelGateway(),
  };
}

export class PlanningDataUnavailableError extends Error {
  readonly statusCode = 422;
  readonly code = "PLANNING_DATA_UNAVAILABLE";

  constructor(readonly missing: string[]) {
    super(`Planning data unavailable: ${missing.join(", ")}`);
    this.name = "PlanningDataUnavailableError";
  }
}

/**
 * Outcome of `generatePlan`. Per §1.3 of the planner-resilience design, a
 * destination with no commercial flight authority does NOT produce a plan —
 * it produces a research summary instead. The discriminator lets callers
 * branch on the two cases without inspecting a nullable `resultPlanId`.
 */
/**
 * Why a run produced a research summary instead of a plan.
 *
 * `NO_CITABLE_EVIDENCE` — every capability came up empty, so there is nothing
 * to build a plan on. This one is a real refusal and must stay one: a card
 * naming a destination and citing no verifiable fact is the "Demo data" shape
 * `AGENTS.md` forbids, wearing a plan's clothes.
 *
 * The rest share one shape: the run did real work, that work is already
 * persisted, and the only thing missing is the model's plan. Failing the run
 * throws the evidence away and tells the traveller nothing about what their
 * suppliers actually answered.
 *
 * `TOOL_BUDGET_EXHAUSTED` — the model spent its turn budget without returning
 * a plan.
 * `PLAN_SCHEMA_UNMET` — it returned one, repeatedly, in a shape the plan
 * contract does not accept, and the repair budget ran out. Identical in
 * substance to the budget case; it used to fail the whole run instead.
 * `RESEARCH_MATRIX_INCOMPLETE` — a capability matrix still held a `MISSING`
 * cell, meaning the planner never attempted it. That is our own scheduling
 * defect, and the traveller should not be the one who pays for it with an
 * empty run.
 */
export type { ResearchSummaryReason };

export type PlanSynthesisOutcome =
  | { readonly outcome: "PLAN"; readonly planId: string; readonly gaps: ReadonlyArray<ServiceGap> }
  | { readonly outcome: "RESEARCH_SUMMARY"; readonly researchResultId: string; readonly gaps: ReadonlyArray<ServiceGap>; readonly reason: ResearchSummaryReason };

/**
 * Re-evaluate every research matrix on the supplied transaction and merge
 * the per-capability gaps with tool-failure gaps + provider-coverage gaps.
 * Every gap is run through `serviceGapSchema.strict()`; invalid entries are
 * dropped with a `gaps_dropped` runtime event, and the row is capped at
 * `RECORD_RESEARCH_RESULT_MAX_GAPS` (32) with a `gaps_truncated` event.
 *
 * Shared between the plan branch and the research-summary branch so that
 * gap accounting is identical regardless of which way Gate B tips the run.
 */
async function evaluateAndValidateServiceGaps(params: {
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
  ctx: RequestContext;
  snapshotId: string;
  agentTaskRunId: string;
  snapshot: { departureCities: string[]; destinationCandidates: string[] };
  allFlights: FlightOffer[];
  /**
   * How many pieces of accommodation evidence this round actually holds —
   * hotel quotes plus discovered stays. It used to be the legacy `StayOffer[]`
   * whose only producer was a permanently stubbed provider, so every run
   * reported `stay: NO_RESULTS` regardless of what it had found.
   */
  stayEvidenceCount: number;
  toolFailureGaps: Array<{ capability: string; code: string }>;
  activitiesEnabled: boolean;
  hotelEnabled: boolean;
  accommodationDiscoveryEnabled: boolean;
}): Promise<{ gaps: ServiceGap[]; status: "COMPLETED_WITH_GAPS" | "COMPLETE" }> {
  let flightMatrixGaps: ReturnType<typeof flightMatrixToGaps> = [];
  let activityMatrixGaps: ReturnType<typeof activitiesMatrixToGaps> = [];
  let hotelMatrixGaps: ReturnType<typeof hotelMatrixToGaps> = [];
  let accommodationMatrixGaps: ReturnType<typeof accommodationMatrixToGaps> = [];
  const finalMatrix = await evaluateFlightResearchCompleteness({
    snapshotId: params.snapshotId,
    agentTaskRunId: params.agentTaskRunId,
    routes: resolveFlightRouteMatrix({
      departureCities: params.snapshot.departureCities,
      destinationCandidates: params.snapshot.destinationCandidates,
    }),
    client: params.tx,
  });
  flightMatrixGaps = flightMatrixToGaps(finalMatrix.cells);
  if (params.activitiesEnabled) {
    const finalActivitiesMatrix = await evaluateActivitiesResearchCompleteness({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId,
      destinationCandidates: params.snapshot.destinationCandidates,
      client: params.tx,
    });
    activityMatrixGaps = activitiesMatrixToGaps(finalActivitiesMatrix.cells);
  }
  if (params.hotelEnabled) {
    const finalHotelMatrix = await evaluateHotelResearchCompleteness({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId,
      destinationCandidates: params.snapshot.destinationCandidates,
      client: params.tx,
    });
    hotelMatrixGaps = hotelMatrixToGaps(finalHotelMatrix.cells);
  }
  if (params.accommodationDiscoveryEnabled) {
    const finalAccommodationMatrix = await evaluateAccommodationResearchCompleteness({
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId,
      destinationCandidates: params.snapshot.destinationCandidates,
      client: params.tx,
    });
    accommodationMatrixGaps = accommodationMatrixToGaps(finalAccommodationMatrix.cells);
  }
  const { gaps: capabilityGaps } = summarizeProviderGaps({
    requiredOrigins: params.snapshot.departureCities,
    flights: params.allFlights,
    stayEvidenceCount: params.stayEvidenceCount,
    // When no flight came back at all, report what the matrix says went wrong
    // rather than the blanket "no results".
    ...(flightMatrixGaps[0] ? { flightFailureCode: flightMatrixGaps[0].code } : {}),
  });
  const allServiceGaps: ServiceGap[] = [
    ...params.toolFailureGaps.map((g) => ({
      capability: g.capability as ServiceGap["capability"],
      code: g.code as ServiceGap["code"],
    })),
    ...flightMatrixGaps.map((g) => ({
      capability: g.capability,
      code: g.code,
      destinationId: g.destinationId,
    })),
    ...activityMatrixGaps,
    ...hotelMatrixGaps,
    ...accommodationMatrixGaps,
    ...capabilityGaps.map((g) => ({ capability: g.capability, code: g.code })),
  ];
  const validatedGaps: ServiceGap[] = [];
  let droppedInvalidCount = 0;
  for (const gap of allServiceGaps) {
    const parsed = serviceGapSchema.safeParse(gap);
    if (parsed.success) {
      validatedGaps.push(parsed.data);
    } else {
      droppedInvalidCount += 1;
    }
  }
  if (droppedInvalidCount > 0) {
    logSafeRuntimeEvent(params.ctx, {
      component: "planner",
      event: "gaps_dropped",
      operation: "validate_service_gaps",
      outcome: "failure",
      errorCode: "INVALID_SERVICE_GAP",
    });
  }
  let serviceGapsJson: ServiceGap[];
  if (validatedGaps.length > RECORD_RESEARCH_RESULT_MAX_GAPS) {
    serviceGapsJson = validatedGaps.slice(0, RECORD_RESEARCH_RESULT_MAX_GAPS);
    logSafeRuntimeEvent(params.ctx, {
      component: "planner",
      event: "gaps_truncated",
      operation: "cap_service_gaps",
      itemCount: validatedGaps.length,
    });
  } else {
    serviceGapsJson = validatedGaps;
  }
  return {
    gaps: serviceGapsJson,
    status: serviceGapsJson.length > 0 ? "COMPLETED_WITH_GAPS" : "COMPLETE",
  };
}

/**
 * Persist a research summary for a destination that failed Gate B. Runs in
 * a single transaction: re-evaluate every research matrix to capture the
 * actual evidence state, write the bounded gap set into
 * `planning_research_results` (`status = COMPLETED_WITH_GAPS`,
 * `result_plan_id = NULL`), emit the `RESEARCH_RESULT_RECORDED` audit, and
 * lease-guard-update `agent_task_runs` to `COMPLETED_WITH_GAPS`. Does NOT
 * write `itinerary_plans` — a research summary carries no plan authority.
 *
 * The lease-guard update matches the plan-branch terminal write so the
 * worker treats this as a successful run, not a failure.
 */
async function persistResearchSummary(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId: string;
  leaseToken: string;
  reason: ResearchSummaryReason;
  toolFailureGaps: Array<{ capability: string; code: string }>;
  snapshotFields: { departureCities: string[]; destinationCandidates: string[] };
  allFlights: FlightOffer[];
  stayEvidenceCount: number;
  activitiesEnabled: boolean;
  hotelEnabled: boolean;
  accommodationDiscoveryEnabled: boolean;
}): Promise<PlanSynthesisOutcome> {
  const result = await db.transaction(async (tx) => {
    const { gaps, status } = await evaluateAndValidateServiceGaps({
      tx,
      ctx: params.ctx,
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId,
      snapshot: params.snapshotFields,
      allFlights: params.allFlights,
      stayEvidenceCount: params.stayEvidenceCount,
      toolFailureGaps: params.toolFailureGaps,
      activitiesEnabled: params.activitiesEnabled,
      hotelEnabled: params.hotelEnabled,
      accommodationDiscoveryEnabled: params.accommodationDiscoveryEnabled,
    });
    const serviceGapsForDb = gaps as unknown as Record<string, unknown>[];
    const [inserted] = await tx.insert(planningResearchResults).values({
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId,
      status,
      serviceGaps: serviceGapsForDb,
      resultPlanId: null,
      summaryReason: params.reason,
    }).onConflictDoUpdate({
      target: planningResearchResults.agentTaskRunId,
      set: {
        status,
        serviceGaps: serviceGapsForDb,
        resultPlanId: null,
        summaryReason: params.reason,
      },
    }).returning({ id: planningResearchResults.id });
    await recordAudit({
      ctx: params.ctx,
      action: "RESEARCH_RESULT_RECORDED",
      tripId: params.tripId,
      summary: {
        status,
        gapCount: gaps.length,
        capabilities: [...new Set(gaps.map((g) => g.capability))].sort(),
      },
      tx,
    });
    // `agent_task_runs.status` uses a different enum than
    // `planning_research_results.status` — COMPLETE maps to COMPLETED.
    // A row whose `resultPlanId` is NULL is by definition a research
    // summary (a research summary is the only path that persists a row
    // without a plan). A research summary is always a gap-bearing
    // terminal state for the run, even when `serviceGaps` came back
    // empty (a model that exhausts repair without producing a plan still
    // surfaced something the traveller needs to know about). Collapsing
    // this to `COMPLETED` would make the Shared Plan view render "plan
    // ready" over an empty surface.
    const taskTerminalStatus = "COMPLETED_WITH_GAPS" as const;
    const [completed] = await tx.update(agentTaskRuns).set({
      status: taskTerminalStatus,
      resultPlanId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
      errorCode: null,
    }).where(and(
      eq(agentTaskRuns.id, params.agentTaskRunId),
      eq(agentTaskRuns.leaseToken, params.leaseToken),
      eq(agentTaskRuns.status, "RUNNING"),
      gt(agentTaskRuns.leaseExpiresAt, new Date()),
    )).returning();
    if (!completed) throw new Error("Planning task lost finalization lease");
    return { researchResultId: inserted.id, gaps, status };
  });
  logSafeRuntimeEvent(params.ctx, {
    component: "planner",
    event: "gate",
    operation: "research_summary",
    outcome: "failure",
    errorCode: params.reason,
  });
  return {
    outcome: "RESEARCH_SUMMARY",
    researchResultId: result.researchResultId,
    gaps: result.gaps,
    reason: params.reason,
  };
}

/**
 * Should this failure become a research summary rather than a failed run?
 *
 * Both cases share the same shape: the run did real work, that work is already
 * persisted, and the only thing missing is the model's plan. Failing the run
 * throws the work away — on 2026-09-05 a run that had collected 28 flight
 * offers, 10 hotel quotes, 16 stays and 4 activities reported nothing but
 * "the provider time ran out", because the model spent its last five turns
 * re-asking for a flight search it had already completed.
 */
function researchSummaryReasonFor(error: unknown): ResearchSummaryReason | null {
  if (error instanceof PlanEvidenceUnavailableError) return "NO_CITABLE_EVIDENCE";
  if (error instanceof FlightResearchIncompleteError
    || error instanceof HotelResearchIncompleteError
    || error instanceof ActivitiesResearchIncompleteError
    || error instanceof AccommodationResearchIncompleteError) {
    return "RESEARCH_MATRIX_INCOMPLETE";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "TOOL_CALL_MAX_TURNS") return "TOOL_BUDGET_EXHAUSTED";
  // The model's final output never satisfied the plan contract. The evidence
  // behind it is already durable, so this reports what was gathered instead of
  // discarding the round — the same reasoning the budget case already had.
  if (error instanceof PlanValidationError || code === "PLAN_VALIDATION_FAILED" || code === "SCHEMA_PARSE") {
    return "PLAN_SCHEMA_UNMET";
  }
  return null;
}

/** Control-flow signal: zero citable provider evidence yields a summary, never a plan. */
export class PlanEvidenceUnavailableError extends Error {
  readonly code = "PLANNING_DATA_UNAVAILABLE";

  constructor(readonly destinationId: string) {
    super(`No citable provider evidence for destination "${destinationId}"`);
    this.name = "PlanEvidenceUnavailableError";
  }
}

/**
 * Per-destination coverage bundle returned by `researchCoverageForSnapshot`.
 * `missingDestinations` is the canonical allow-list surface to detect gaps
 * (spec §6.1, §10.6); an empty array means full coverage.
 */
export interface CoverageResearchResult {
  allFlights: FlightOffer[];
  allStays: StayOffer[];
  allActivities: ActivityEvidence[];
  evaluatedDestinations: string[];
  missingDestinations: string[];
}

/**
 * Whether anything is known about where a traveller could stay at this
 * destination, with a `provider_search_runs` row recording who was asked.
 *
 * This used to ask `stayProvider`, which is `UnavailableStayProvider` — the
 * only implementation of that interface in the codebase, returning
 * NOT_CONFIGURED unconditionally. Every destination was therefore recorded as
 * uncovered on every run, and the caller refuses to synthesize when anything
 * is uncovered, so no plan could ever be written. The database agreed: not one
 * `itinerary_plans` row had ever existed.
 *
 * Coverage asks discovery, not quotes. The question here is "is this
 * destination a blank?", and a list of real places to stay answers it; what a
 * room costs is a different question, asked later by `hotel.search`, which has
 * the occupancy, currency and decrypted quote nationality a price request
 * needs. §10.6 still holds — a destination with no accommodation signal at all
 * is still uncovered — but "no live room price" is not "nothing is known".
 *
 * Never throws. A provider that fails leaves the destination uncovered, which
 * the caller records as a gap; it is not a reason to lose the run.
 */
async function hasAccommodationCoverage(params: {
  deps: PlanningDependencies;
  tripId: string;
  destination: string;
  snapshotId: string;
  agentTaskRunId?: string;
}): Promise<boolean> {
  const recordRun = async (outcome: "LIVE" | "UNAVAILABLE") => {
    if (!params.agentTaskRunId) return;
    try {
      await db.insert(providerSearchRuns).values({
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        category: "stay",
        providerName: "accommodation_discovery",
        destinationId: params.destination.slice(0, 128),
        requestFingerprint: randomUUID(),
        outcome,
        errorCode: null,
      });
    } catch {
      // Evidence bookkeeping must not decide whether a trip can be planned.
    }
  };

  try {
    // Adapters take a resolved `DestinationReference` with coordinates and
    // deliberately have no overload that accepts a city name. Passing the
    // string through a cast is how this first came back UNAVAILABLE for a city
    // the same provider had just answered LIVE for through the tool loop.
    const destination = await resolveTripDestinationReference({
      tripId: params.tripId,
      destinationId: params.destination,
    });
    if (destination) {
      const found = await params.deps.accommodationDiscoveryProvider?.discoverAccommodations({
        destination,
        limit: 10,
      });
      if (found?.outcome === "LIVE" && found.data.length > 0) {
        await recordRun("LIVE");
        return true;
      }
    }
  } catch {
    // Falls through to the UNAVAILABLE record below.
  }
  await recordRun("UNAVAILABLE");
  return false;
}

/**
 * Spec §6.1 / §10.6 — research coverage matrix.
 *
 * Iterates the full cartesian of `{origin ∈ departureCities} × {destination ∈ destinationCandidates}`,
 * plus one stay query per destination. Flight LIVE and UNAVAILABLE outcomes are
 * persisted as `provider_search_runs`; `missingDestinations` tracks failed stay
 * coverage. The handler uses both surfaces to gate `generatePlan` — never
 * running the model until every flight cell was attempted and at least one
 * destination has commercial flight authority plus stay coverage.
 *
 * Concurrency: `Promise.allSettled` here is safe; providers are isolated and
 * per-cell deadlines are not enforced at this layer. Production deployment
 * should wrap with a bounded concurrency pool (Phase 6 hardening).
 */
export async function researchCoverageForSnapshot(params: {
  snapshotId: string;
  /** Needed to resolve a destination name to the reference adapters require. */
  tripId: string;
  agentTaskRunId?: string;
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart: string;
  travelDateEnd: string;
  signal?: AbortSignal;
  providerOverride?: PlanningDependencies;
}): Promise<CoverageResearchResult> {
  if (params.destinationCandidates.length === 0) {
    throw new PlanningDataUnavailableError(["destination_candidates_empty"]);
  }
  const deps = params.providerOverride ?? resolvePlanningDependencies();
  const allFlights: FlightOffer[] = [];
  const allStays: StayOffer[] = [];
  const allActivities: ActivityEvidence[] = [];
  const evaluatedDestinations = new Set<string>();
  const missingDestinations = new Set<string>();

  // Decoupled origin × destination fan-out for flights, over *controlled
  // airports* rather than the snapshot's city names.
  //
  // This used to pass the city strings straight through, and SerpApi said
  // exactly what was wrong with that: `departure_id` ("Singapore") should
  // either be an uppercase 3-letter code or start with "/m" or "/g". Every
  // coverage flight search 400'd, while the model's own tool loop — which
  // resolves airports first — got 200 and 28 offers for the same route on the
  // same run. Two paths, one route, two ideas of what a route is.
  //
  // A city with no controlled airport yields no cell, which the caller reports
  // as a flight gap. We still do not guess a neighbouring code (§#22).
  const routeMatrix = resolveFlightRouteMatrix({
    departureCities: params.departureCities,
    destinationCandidates: params.destinationCandidates,
  });
  const flightSettlements = await Promise.allSettled(
    routeMatrix.cells.map(({ originId, destinationId }) => (async () => {
      const destinationCity = routeMatrix.cityFor(destinationId) ?? destinationId;
      const origin = originId;
      const destination = destinationId;
      {
        const result = normalizeFlightProviderResult(await deps.flightProvider.searchFlights({
          origin,
          destination,
          dateStart: params.travelDateStart,
          dateEnd: params.travelDateEnd,
          snapshotId: params.snapshotId,
        }));
        // LIVE is evidence-bearing by definition. Some adapters can return an
        // HTTP-success envelope with an empty normalized array; treating that
        // as LIVE marked the matrix complete while leaving synthesis nothing
        // to cite. Fail closed at this orchestration boundary as NO_RESULTS.
        if (result.outcome === "UNAVAILABLE") {
          const unavailableReason = result.reason;
          if (params.agentTaskRunId) {
            await db.insert(providerSearchRuns).values({
              snapshotId: params.snapshotId,
              agentTaskRunId: params.agentTaskRunId,
              category: "flight",
              providerName: (result as { source?: string }).source ?? "flight",
              originId: origin.slice(0, 16),
              destinationId: destination.slice(0, 128),
              requestFingerprint: randomUUID(),
              outcome: "UNAVAILABLE",
              // The supplier's own classification, not a blank. Writing null
              // here lost the reason at the moment it was known: a run whose
              // flight searches came back INVALID_PROVIDER_RESPONSE was
              // reported to the traveller as "no verified results", which
              // reads as "there are no flights" for a route that has plenty.
              errorCode: unavailableReason,
            });
          }
          return; // UNAVAILABLE → no offer, but the attempted cell is durable
        }
        if (params.agentTaskRunId) {
          await db.insert(providerSearchRuns).values({
            snapshotId: params.snapshotId,
            agentTaskRunId: params.agentTaskRunId,
            category: "flight",
            providerName: result.source,
            originId: origin.slice(0, 16),
            destinationId: destination.slice(0, 128),
            requestFingerprint: randomUUID(),
            outcome: "LIVE",
            errorCode: null,
          });
        }
        // The city, not the airport: every downstream consumer
        // (`evaluatedDestinations`, `missingDestinations`, the orchestrator's
        // eligibility filter) is keyed by the snapshot's candidate strings.
        evaluatedDestinations.add(destinationCity);
        allFlights.push(...result.data);
      }
    })()),
  );
  if (params.signal?.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
  void flightSettlements;

  // Destination-scoped stay queries. POI / route / mobility evidence is
  // gathered through the LLM tool loop (`places.search` / `navigation.route`
  // / `mobility.search`) — it no longer flows through this server-side
  // pre-fetch.
  const staySettlements = await Promise.allSettled(
    params.destinationCandidates.map(async (destination) => {
      const covered = await hasAccommodationCoverage({
        deps,
        tripId: params.tripId,
        destination,
        snapshotId: params.snapshotId,
        ...(params.agentTaskRunId ? { agentTaskRunId: params.agentTaskRunId } : {}),
      });
      if (covered) evaluatedDestinations.add(destination);
      else missingDestinations.add(destination);
    }),
  );
  void staySettlements;

  return {
    allFlights,
    allStays,
    allActivities,
    evaluatedDestinations: [...evaluatedDestinations],
    missingDestinations: [...missingDestinations],
  };
}

/**
 * Spec §4.3 — Service outcome matrix.
 *
 * Translates the post-research view into a bounded `ServiceGap[]` set the
 * planner persists as `planning_research_results.service_gaps`. Only the
 * `origin-missing` condition is structural and remains a hard gate;
 * capability-level UNAVAILABLE is reported as a gap rather than a failure.
 */
/** Airport-id vs snapshot-city identity, shared with the plan validator. */
function flightServesOrigin(endpoint: string, city: string): boolean {
  if (endpoint === city) return true;
  const airport = resolveAirportReference(endpoint);
  return airport !== null && airportServesCity(airport, city);
}

type ProviderGapCode = ProviderUnavailableCode;
type ProviderGapCapability = "flight" | "stay" | "navigation" | "mobility" | "transit";

export function summarizeProviderGaps(params: {
  requiredOrigins: string[];
  flights: FlightOffer[];
  /**
   * Everything that answers "could this traveller sleep somewhere". Hotel
   * quotes and accommodation discovery both count; the legacy `StayOffer`
   * array does not exist any more.
   *
   * It used to be that array alone, whose only producer was a permanently
   * stubbed provider, so every run reported `stay: NO_RESULTS` — including
   * runs holding ten live Nuitee quotes and sixteen discovered stays. The
   * screen said "no accommodation found" over a database that had plenty.
   */
  stayEvidenceCount: number;
  /**
   * What the flight capability actually reported, when it reported anything.
   * Without this a supplier that answered `INVALID_PROVIDER_RESPONSE` was
   * flattened into `NO_RESULTS` — "there are no flights" for a route with
   * plenty, and a lost lead for whoever debugs it next.
   */
  flightFailureCode?: ProviderGapCode;
  // Optional signal flags so the matrix can express capabilities that are
  // soft-disabled (e.g. `PLAN_ENABLE_MOBILITY=false`). Today these are
  // computed by callers; the planner layer merely forwards them.
  unavailableCapabilities?: ReadonlyArray<{ capability: ProviderGapCapability; code: "NOT_CONFIGURED" | "PROVIDER_NOT_APPROVED" }>;
}): { gaps: { capability: ProviderGapCapability; code: ProviderGapCode }[]; missingOrigins: string[] } {
  const missingOrigins = params.requiredOrigins
    // Offers carry controlled airport ids; `requiredOrigins` carries the
    // snapshot's city names. Compared as strings, every origin reads as
    // uncovered — see `routeEndpointMatches` in plan-output-validator.ts.
    .filter(origin => !params.flights.some(flight => flightServesOrigin(flight.origin, origin)));
  const gaps: { capability: ProviderGapCapability; code: ProviderGapCode }[] = [];
  // Zero-candidate soft gates from Phase 4 outcome matrix: a capability
  // with zero results is a gap, not a throw — reported under the reason the
  // supplier gave when there is one.
  if (params.flights.length === 0) {
    gaps.push({ capability: "flight", code: params.flightFailureCode ?? "NO_RESULTS" });
  }
  if (params.stayEvidenceCount === 0) gaps.push({ capability: "stay", code: "NO_RESULTS" });
  for (const cap of params.unavailableCapabilities ?? []) {
    gaps.push({ capability: cap.capability, code: cap.code });
  }
  return { gaps, missingOrigins };
}

/**
 * Hard gate that ONLY fires on structural conditions (origin-missing,
 * destination-candidates-empty). Capability-level UNAVAILABLE is no longer
 * a throw; it is recorded via `summarizeProviderGaps` and surfaced through
 * `planning_research_results`.
 */
export function validateProviderCoverage(params: {
  requiredOrigins: string[];
  flights: FlightOffer[];
}): void {
  // Zero flights is the whole capability being unavailable — a supplier
  // outage, a refused request, a city with no controlled airport. That is a
  // gap (`summarizeProviderGaps` already emits `flight/NO_RESULTS`), and the
  // plan is still worth producing from whatever else came back live.
  //
  // Some flights but an uncovered origin is a different statement: the plan
  // would be telling one member there is a way to get there and another
  // nothing at all. That remains structural and still refuses.
  if (params.flights.length === 0) return;
  const { missingOrigins } = summarizeProviderGaps({
    requiredOrigins: params.requiredOrigins,
    flights: params.flights,
    stayEvidenceCount: 0,
  });
  if (missingOrigins.length > 0) {
    throw new PlanningDataUnavailableError(missingOrigins.map((origin) => `flight:${origin}`));
  }
}

/**
 * Create a new constraint snapshot for a planning round.
 *
 * Phase 3+ writes the v2 projection produced by `MemoryProjectionBuilder`:
 *  - `authorized_data` carries `{ schemaVersion: 2, teamVisible, orchestratorConfidential, projectionManifest }`
 *  - the v1 reader remains valid for legacy snapshots (compat shim in
 *    `snapshot-policy.ts#assertFieldAllowed`).
 *
 * Caller must already be inside a transaction if they need atomic snapshot + plan
 * writes. Outside callers use a default `db.transaction` wrapper.
 */
/**
 * The members a projection covers.
 *
 * An empty `memberIds` means "everyone on the trip" — callers that do not track
 * membership themselves, such as the Worker, pass nothing. Both the snapshot
 * and the commit-time fingerprint have to resolve it the same way: the snapshot
 * hashed the real members while the guard hashed the empty list, so every
 * Worker-generated plan failed its own guard with MemorySourceChangedError.
 */
type PlanningTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolveMemberIds(
  tx: PlanningTx,
  tripId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  if (memberIds.length > 0) return [...memberIds];
  const rows = await tx.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(eq(tripMembers.tripId, tripId));
  return rows.map((row) => row.userId);
}

export async function createConstraintSnapshot(params: {
  tripId: string;
  memberIds: string[];
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
  /** Override salt for run-scoped aliases (used only by tests). */
  aliasSalt?: string;
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0];
}): Promise<string> {
  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const existing = await tx.select({ version: constraintSnapshots.version })
      .from(constraintSnapshots)
      .where(eq(constraintSnapshots.tripId, params.tripId))
      .orderBy(desc(constraintSnapshots.version));
    const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

    // Resolve the full required projection before loading consents. An empty
    // caller list means every trip member; using the unresolved empty list
    // here would silently omit all authorized fields from the snapshot.
    const memberIdsResolved = await resolveMemberIds(tx, params.tripId, params.memberIds);

    // Pull active consents per member.
    const consentRows = await Promise.all(memberIdsResolved.map(async (memberId) => ({
      memberId,
      consents: await getActiveConsents({ tripId: params.tripId, userId: memberId }),
    })));
    const consents = consentRows.flatMap(({ memberId, consents: memberConsents }) =>
      memberConsents.flatMap((scope) => scope.fieldList.map((fieldKey) => ({
        userId: memberId,
        scope: scope.scope as
          | "PROFILE_BASIC" | "PROFILE_PREFERENCES" | "PROFILE_NATIONALITY"
          | "PROFILE_DOCUMENTS" | "PROFILE_BUDGET" | "PROFILE_RESTRICTIONS",
        fieldKey,
      }))),
    );

    // Pull active trip facts for the trip (any owner).
    const factRows = await tx.select({
      id: tripConstraintFacts.id,
      ownerUserId: tripConstraintFacts.ownerUserId,
      fieldKey: tripConstraintFacts.fieldKey,
      valueJson: tripConstraintFacts.valueJson,
      strength: tripConstraintFacts.strength,
      visibility: tripConstraintFacts.visibility,
      revision: tripConstraintFacts.revision,
      kind: tripConstraintFacts.kind,
    }).from(tripConstraintFacts).where(and(
      eq(tripConstraintFacts.tripId, params.tripId),
      eq(tripConstraintFacts.status, "ACTIVE"),
    ));

    const projectionInput: MemoryProjectionInput = {
      tripId: params.tripId,
      memberUserIds: memberIdsResolved,
      consents: consents.map((c) => ({
        userId: c.userId,
        scope: c.scope,
        fieldList: [c.fieldKey],
      })),
      tripConstraintFacts: factRows.map((f) => ({
        ownerUserId: f.ownerUserId,
        fieldKey: f.fieldKey,
        valueJson: f.valueJson,
        strength: f.strength,
        visibility: f.visibility,
        revision: f.revision,
        id: f.id,
      })),
      departureCities: params.departureCities,
      destinationCandidates: params.destinationCandidates,
      travelDateStart: params.travelDateStart,
      travelDateEnd: params.travelDateEnd,
    };

    const projected = buildMemoryProjection(projectionInput);

    // The personal memory namespace (§4.4). Built from preference facts rather
    // than the profile columns the v1 shape reads, because a fact carries the
    // version chain and the catalog registration that decide exportability.
    const activeFacts = memberIdsResolved.length === 0 ? [] : await tx.select({
      userId: preferenceFacts.userId,
      fieldKey: preferenceFacts.fieldKey,
      value: preferenceFacts.fieldValue,
    }).from(preferenceFacts).where(and(
      inArray(preferenceFacts.userId, memberIdsResolved),
      eq(preferenceFacts.status, "ACTIVE"),
    ));

    const consentedFieldsByUser: Record<string, string[]> = {};
    for (const consent of consents) {
      (consentedFieldsByUser[consent.userId] ??= []).push(consent.fieldKey);
    }

    const memoryNamespace = await withMemorySpan(
      "memory.projection.build",
      { operation: "build", source: "snapshot" },
      async () => {
        try {
          const built = buildMemoryNamespace({
            aliases: projected.snapshot.memberAliases,
            consentedFieldsByUser,
            preferenceFacts: activeFacts,
            tripFacts: factRows.map((f) => ({
              ownerUserId: f.ownerUserId,
              fieldKey: f.fieldKey,
              kind: f.kind,
              visibility: f.visibility,
              valueJson: f.valueJson,
            })),
          });
          const empty = Object.keys(built.groupDecisions).length === 0
            && Object.values(built.members).every((m) =>
              Object.keys(m.profileFacts).length === 0
              && Object.keys(m.tripOverrides).length === 0);
          metrics.inc("memory_projection_build_total", { result: empty ? "empty" : "built" });
          return { result: built, outcome: empty ? "empty" : "built" };
        } catch (error) {
          metrics.inc("memory_projection_build_total", { result: "failed" });
          throw error;
        }
      },
    );

    // v1 back-compat map: userId → consent-granted fields.
    const v1Shape: Record<string, unknown> = {};
    for (const memberId of memberIdsResolved) {
      v1Shape[memberId] = await buildAuthorizedData({ tripId: params.tripId, userId: memberId });
    }

    // Build a server-internal safePublicExplanationTokens union across all
    // fields referenced by active facts (so the validator allow-list is
    // exactly what was in-scope for this round).
    const referencedFieldKeys = new Set<string>();
    for (const fact of factRows) referencedFieldKeys.add(fact.fieldKey);
    const allowedExplanation = new Set<string>();
    for (const fieldKey of referencedFieldKeys) {
      for (const token of safePublicExplanationTokensFor(fieldKey)) {
        allowedExplanation.add(token);
      }
    }
    void allowedExplanation;

    // Single JSONB blob keeps v1 shape at top-level (for legacy readers) and
    // v2 privileged sections under `_meta`. The reserved key `_meta` never
    // collides with userId UUIDs.
    const authorizedData: Record<string, unknown> = {
      ...v1Shape,
      _meta: {
        schemaVersion: 2,
        // Identities and versions of the projection's sources, so the commit
        // gate can tell whether memory moved during the run (§6).
        memorySourceFingerprint: await computeMemorySourceFingerprint({
          tripId: params.tripId,
          memberUserIds: memberIdsResolved,
          tx,
        }),
        memberAliases: projected.snapshot.memberAliases,
        teamVisible: projected.snapshot.teamVisible,
        orchestratorConfidential: projected.snapshot.orchestratorConfidential,
        projectionManifest: projected.snapshot.projectionManifest,
        memory: memoryNamespace,
      },
    };

    const [snapshot] = await tx.insert(constraintSnapshots).values({
      tripId: params.tripId,
      version: nextVersion,
      authorizedData,
      departureCities: params.departureCities,
      destinationCandidates: params.destinationCandidates,
      travelDateStart: params.travelDateStart,
      travelDateEnd: params.travelDateEnd,
    }).returning();

    return snapshot.id;
  };

  if (params.tx) {
    return run(params.tx);
  }
  return db.transaction(run);
}

/**
 * Read the `_meta` envelope of a freshly loaded v2 snapshot. Returns null when
 * the snapshot is v1 or has no privileged sections.
 */
export interface SnapshotV2Meta {
  schemaVersion: 2;
  memberAliases: Record<string, string>;
  teamVisible: Record<string, Array<Record<string, unknown>>>;
  orchestratorConfidential: Record<string, Array<{
    fieldKey: string;
    valueJson: unknown;
    strength: "HARD" | "SOFT";
    visibility: "ORCHESTRATOR_CONFIDENTIAL";
    sourceType: "TRIP_FACT";
    sourceId: string;
  }>>;
  projectionManifest: Array<Record<string, unknown>>;
}

export function extractSnapshotV2Meta(authorizedData: unknown): SnapshotV2Meta | null {
  if (typeof authorizedData !== "object" || authorizedData === null) return null;
  const root = authorizedData as Record<string, unknown>;
  const meta = root._meta;
  if (!meta || typeof meta !== "object") return null;
  const schemaVersion = (meta as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== 2) return null;
  return meta as unknown as SnapshotV2Meta;
}

/**
 * The model/Shared Skills must never receive the legacy userId-keyed snapshot
 * map or the server-only userId→alias lookup. Keep that compatibility shape
 * available only to deterministic server readers.
 */
export function buildPlanningModelProjection(authorizedData: unknown): Record<string, unknown> {
  const meta = extractSnapshotV2Meta(authorizedData);
  if (!meta) return {};
  return {
    schemaVersion: 2,
    teamVisible: meta.teamVisible,
    orchestratorConfidential: meta.orchestratorConfidential,
    projectionManifest: meta.projectionManifest,
    planningMemory: buildSharedPlanningMemoryInput(authorizedData),
  };
}

/**
 * Generate a new plan based on the constraint snapshot.
 *
 * Phase 3 lifecycle:
 *  - `outputMode: "PROPOSED"` (default) writes the plan as `PROPOSED`; activation
 *    requires unanimous adoption vote (Phase 4 wires this in via
 *    `activateProposedPlan`).
 *  - `outputMode: "ACTIVATE"` is reserved for the unanimous-vote path; the plan
 *    is emitted as `ACTIVE` and writes `replacedByPlanId` to form the chain.
 *
 * Provider evidence is bound to the snapshot id so the validator's deterministic
 * `EVIDENCE_*` checks remain meaningful across runs. Shared planning obtains
 * flight evidence only through the registered model-requested Skill; the final
 * transaction verifies the complete authorized matrix before persisting a plan.
 */
/**
 * The search tools whose service reserves a `provider_search_runs` row per
 * run, so a second call for the same request is refused rather than repeated.
 */
const ONE_SHOT_TOOL_BY_CAPABILITY: Readonly<Record<string, string>> = {
  accommodation: "accommodation.discover",
  activities: "activities.search",
  hotel: "hotel.search",
  places: "places.search",
  // Coverage research fans out over the whole canonical route matrix before
  // synthesis starts, and hands the offers forward. Leaving the tool on offer
  // simply bought the same two searches a second time — the run that finally
  // produced a plan paid SerpApi twice for `SIN→PVG` and `SIN→SHA`.
  flight: "flight.search",
};

/**
 * Drop the tools whose capability the orchestrator already researched.
 *
 * Those searches are one-shot per run. Offering them again did not give the
 * model a second chance at anything — it gave it a POLICY_DENIED within a
 * millisecond, three of them in the opening turn, which read as three fresh
 * failures worth retrying. The evidence they would have returned is already
 * in this round's `provider_offers` and reaches synthesis through the
 * coverage bundle.
 */
export function planningToolsFor(
  alreadyResearched: readonly string[],
  tools: ModelToolDefinition[],
): ModelToolDefinition[] {
  const withdrawn = new Set(
    alreadyResearched.map((capability) => ONE_SHOT_TOOL_BY_CAPABILITY[capability]).filter(Boolean),
  );
  return tools.filter((tool) => !withdrawn.has(tool.name));
}

/**
 * How many times one tool may have the model's arguments refused by its own
 * declared schema before it stops being offered. Two: one is a stumble, and a
 * second says the model cannot express what this tool wants — every further
 * attempt costs a turn that the plan needs.
 */
export const TOOL_ARGUMENT_REJECTION_LIMIT = 2;

/** Which `places.adopt` action each of the three place-mutation tools performs. */
export const PLACE_MUTATION_ACTION_BY_TOOL: Readonly<Record<string, "propose" | "adopt" | "revoke" | undefined>> = {
  "places.propose": "propose",
  "places.adopt": "adopt",
  "places.revoke": "revoke",
};

/**
 * Parse the arguments a model produced for one tool.
 *
 * `INPUT_INVALID` is the whole point. A bare `.parse()` throws a `ZodError`,
 * which is not a `SkillError`, so the dispatcher's catch fell through to
 * `UPSTREAM_FAILURE` and the run reported "the provider was temporarily
 * unavailable" for arguments no provider ever saw. On 2026-09-06 eight such
 * gaps named `places` and `navigation` while every provider call in the run
 * had succeeded.
 */
function parseToolArguments<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  toolName: string,
  args: unknown,
): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new SkillError("INPUT_INVALID", `Model arguments for ${toolName} do not match its declared schema`);
  }
  return parsed.data;
}

/** The candidates a `places.search` answer carries, or none if it was not LIVE. */
function placeCandidatesOf(result: unknown): readonly PlaceCandidate[] {
  const outcome = (result as { outcome?: unknown } | null)?.outcome;
  if (outcome !== "LIVE") return [];
  const data = (result as { data?: unknown }).data;
  return Array.isArray(data) ? (data as PlaceCandidate[]) : [];
}

/**
 * How a place-mutation tool is offered.
 *
 * `places.propose` / `places.adopt` / `places.revoke` are three tools rather
 * than one `places.adopt` carrying an `action` discriminator. The single-tool
 * shape advertised `{ action, candidateId, placeId }` while the server
 * validated a discriminated union whose branches additionally require
 * `visibility` + `kind` (propose) and `reason` (revoke) — so every one of the
 * three actions was uncallable, and on 2026-09-06 a run spent its whole turn
 * budget discovering that one rejection at a time. Splitting them removes the
 * union entirely: each tool's advertised schema is a flat object that the
 * server validates verbatim, and the model chooses by name instead of by
 * assembling a field combination it was never shown.
 */
export interface PlanningToolCatalogOptions {
  originAirports: readonly string[];
  destinationAirports: readonly string[];
  activitiesEnabled: boolean;
  /**
   * Places tools are offered only when `places.search` is itself on offer this
   * run. A `candidateId` exists only inside the run that searched for it, so
   * offering the mutation tools without the search is offering something the
   * model cannot supply an argument for — which is exactly what happened when
   * coverage research had already withdrawn `places.search`.
   */
  placesEnabled: boolean;
  navigationEnabled: boolean;
  hotelEnabled: boolean;
  accommodationDiscoveryEnabled: boolean;
}

/**
 * The tools offered to the planning model, before per-run withdrawal.
 *
 * Exported so `tests/planning-tool-contract.test.ts` can compare every
 * advertised parameter schema against the Zod schema that actually validates
 * the call. Nothing else may describe these tools: an advertised contract
 * that no test holds against its validator is how the two drift apart.
 */
export function buildPlanningToolDefinitions(options: PlanningToolCatalogOptions): ModelToolDefinition[] {
  const flightsSearchable = options.originAirports.length > 0 && options.destinationAirports.length > 0;
  return [
    {
      name: "flight.search",
      // The allowed codes are named in the description rather than as a
      // JSON-schema `enum`: the provider's OpenAI-compatible endpoint
      // answered 5xx to every request carrying one, so the constraint that
      // was meant to keep the model on valid airports stopped it planning
      // at all. The server still rejects anything outside the list.
      description: flightsSearchable
        ? `Search normalized flights between two controlled airports. originId must be one of: ${options.originAirports.join(", ")}. destinationId must be one of: ${options.destinationAirports.join(", ")}. Any other value is rejected.`
        : "Unavailable for this trip: no controlled airport serves one of its cities. Do not call this tool.",
      parameters: { type: "object", additionalProperties: false, required: ["originId", "destinationId"], properties: {
        originId: { type: "string" }, destinationId: { type: "string" },
      } },
    },
    ...(options.activitiesEnabled ? [{
      name: "activities.search",
      description: "Search live activity evidence for one controlled destination.",
      parameters: { type: "object", additionalProperties: false, required: ["destinationId", "locale"], properties: {
        destinationId: { type: "string" },
        theme: { type: "string", enum: ["CULTURE", "FOOD", "OUTDOOR", "FAMILY"] },
        locale: { type: "string", enum: ["en", "zh"] },
      } },
    }] : []),
    ...(options.placesEnabled ? [{
      name: "places.search",
      description: "Search normalized POI candidates for one destination keyword and category. "
        + "Only the first few candidates of each answer are shown; propose one of those.",
      parameters: { type: "object", additionalProperties: false, required: ["destinationId", "keyword", "category"], properties: {
        destinationId: { type: "string", description: "Must be one of the snapshot's destinationCandidates." },
        keyword: { type: "string", description: "Free-text search term; never include private profile data." },
        category: { type: "string", enum: ["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"] },
      } },
    }, {
      name: "places.propose",
      description: "Record one POI candidate returned by places.search as a proposed trip place. "
        + "candidateId must be a candidateId this run's places.search actually returned; "
        + "the server holds the candidate's own details and will not accept them from you.",
      parameters: { type: "object", additionalProperties: false, required: ["candidateId", "visibility", "kind"], properties: {
        candidateId: { type: "string", format: "uuid", description: "candidateId from a places.search answer in this run." },
        visibility: { type: "string", enum: ["OWNER_PRIVATE", "TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"] },
        kind: { type: "string", enum: ["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"] },
      } },
    }, {
      name: "places.adopt",
      description: "Promote a proposed trip place to ACTIVE. placeId must come from a places.propose answer in this run.",
      parameters: { type: "object", additionalProperties: false, required: ["placeId"], properties: {
        placeId: { type: "string", format: "uuid", description: "placeId returned by places.propose in this run." },
      } },
    }, {
      name: "places.revoke",
      description: "Withdraw a trip place this run created. placeId must come from a places.propose answer in this run.",
      parameters: { type: "object", additionalProperties: false, required: ["placeId", "reason"], properties: {
        placeId: { type: "string", format: "uuid", description: "placeId returned by places.propose in this run." },
        reason: { type: "string", minLength: 1, maxLength: 256 },
      } },
    }] : []),
    // A route joins two places this run adopted, so navigation without the
    // places tools has nothing to name.
    ...(options.navigationEnabled && options.placesEnabled ? [{
      name: "navigation.route",
      description: "Compute a walking/driving/cycling route between two ACTIVE trip places adopted in this run.",
      parameters: { type: "object", additionalProperties: false, required: ["originPlaceId", "destinationPlaceId", "mode"], properties: {
        originPlaceId: { type: "string", format: "uuid", description: "placeId of an ACTIVE trip place, from places.adopt." },
        destinationPlaceId: { type: "string", format: "uuid", description: "placeId of a different ACTIVE trip place, from places.adopt." },
        mode: { type: "string", enum: ["WALK", "DRIVE", "CYCLE"] },
      } },
    }] : []),
    ...(options.hotelEnabled ? [{
      name: "hotel.search",
      description: "Search live hotel evidence for one controlled destination. Dates, occupancy, and currency are server-derived.",
      parameters: { type: "object", additionalProperties: false, required: ["destinationId"], properties: { destinationId: { type: "string" } } },
    }] : []),
    ...(options.accommodationDiscoveryEnabled ? [{
      name: "accommodation.discover",
      description: "Discover non-price accommodation candidates near one controlled destination. This is not availability or a quote.",
      parameters: { type: "object", additionalProperties: false, required: ["destinationId"], properties: { destinationId: { type: "string" } } },
    }] : []),
  ];
}

/**
 * Maximum number of pre-researched candidates shown to the model per
 * capability. This matches `boundToolResult` and keeps the initial prompt
 * bounded while guaranteeing that every shown id remains resolvable from the
 * complete server-side arrays.
 */
export const PLANNING_EVIDENCE_CATALOG_MAX_ITEMS = 5;

/**
 * Project complete provider records into the public comparison facts the
 * model needs to choose an id. The projection deliberately excludes raw
 * provider payloads, URLs and every member/profile field. Full evidence stays
 * server-side and is restored only by `bindPlanSelectionsToEvidence`.
 */
export function buildPlanningEvidenceCatalog(params: {
  flights: readonly FlightOffer[];
  activities: readonly ActivityEvidence[];
  hotels: readonly HotelOffer[];
  accommodations: readonly AccommodationEvidence[];
}): PlanningEvidenceCatalog {
  const take = <T>(items: readonly T[]): readonly T[] => items.slice(0, PLANNING_EVIDENCE_CATALOG_MAX_ITEMS);
  return {
    flights: take(params.flights).map((offer) => ({
      id: offer.id,
      origin: offer.origin,
      destination: offer.destination,
      departureAt: offer.segments[0]?.departureAt ?? null,
      arrivalAt: offer.segments.at(-1)?.arrivalAt ?? null,
      totalDuration: offer.totalDuration,
      totalPrice: offer.totalPrice,
      currency: offer.currency,
      cabin: offer.cabin,
      source: offer.source,
      capturedAt: offer.capturedAt,
    })),
    activities: take(params.activities).map((offer) => ({
      id: offer.id,
      destination: offer.destination,
      title: offer.title,
      rating: offer.rating,
      reviewCount: offer.reviewCount,
      durationMinutes: offer.durationMinutes,
      fromPrice: offer.fromPrice,
      currency: offer.currency,
      freeCancellation: offer.freeCancellation,
      source: offer.source,
      capturedAt: offer.capturedAt,
    })),
    hotels: take(params.hotels).map((offer) => ({
      id: offer.id,
      destinationId: offer.destinationId,
      propertyName: offer.propertyName,
      checkIn: offer.checkIn,
      checkOut: offer.checkOut,
      totalPrice: offer.totalPrice,
      pricePerNight: offer.pricePerNight,
      currency: offer.currency,
      cancellationSummary: offer.cancellationSummary,
      source: offer.source,
      capturedAt: offer.capturedAt,
    })),
    accommodations: take(params.accommodations).map((offer) => ({
      id: offer.id,
      destinationId: offer.destinationId,
      name: offer.name,
      kind: offer.kind,
      distanceMeters: offer.distanceMeters,
      popularityTier: offer.popularityTier,
      source: offer.source,
      capturedAt: offer.capturedAt,
    })),
  };
}

type PlanValidationMetricResult = "schema" | "authorization" | "route" | "provenance" | "evidence" | "unknown";

function planValidationMetricResult(code: string): PlanValidationMetricResult {
  switch (code) {
    case "STRUCTURE_INVALID":
      return "schema";
    case "FIELD_NOT_AUTHORIZED":
    case "CONFIDENTIAL_VALUE_LEAK":
    case "EXPLANATION_TOKEN_NOT_ALLOWED":
      return "authorization";
    case "ORIGIN_NOT_ALLOWED":
    case "ORIGIN_MISSING":
    case "DESTINATION_NOT_ALLOWED":
    case "DESTINATION_MISMATCH":
    case "DESTINATION_CANDIDATES_INCOMPLETE":
    case "HARD_CONSTRAINT_UNSATISFIED":
      return "route";
    case "SOURCE_REQUIRED":
    case "PROVENANCE_REQUIRED":
    case "GENERATED_AT_MISMATCH":
      return "provenance";
    case "EVIDENCE_NOT_FOUND":
    case "EVIDENCE_MISMATCH":
      return "evidence";
    default:
      return "unknown";
  }
}

/** Record only stable validator codes and paths; never the rejected values. */
function recordPlanValidationFailure(error: PlanValidationError): void {
  const metricResults = new Set(error.violations.map((violation) => planValidationMetricResult(violation.code)));
  for (const validationResult of metricResults) {
    metrics.inc("plan_validation_failures_total", { validationResult });
  }
  pinoInstance.warn({
    component: "plan-validation",
    violationCodes: [...new Set(error.violations.map((violation) => violation.code))].sort(),
    fieldPaths: [...new Set(error.violations.map((violation) => violation.fieldPath))].sort().slice(0, 16),
  }, "Plan candidate rejected");
}

export async function generatePlan(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  destination: string;
  memberIds: string[];
  agentTaskRunId?: string;
  flightSearchPreferencesVersion?: number;
  staySearchPreferencesVersion?: number;
  signal?: AbortSignal;
  leaseToken?: string;
  /**
   * Defaults to "ACTIVATE" to preserve the legacy flow: the planner emits an
   * `ACTIVE` plan that then funnels through `member_confirmations`. Team
   * Agent 协作编排 (Phase 3+) explicitly passes "PROPOSED" so the plan
   * routes through the adoption-vote lifecycle (spec §1.8). Booking-sandbox
   * integrations must consult plan status separately (Phase 4).
   */
  outputMode?: "PROPOSED" | "ACTIVATE";
  coverage?: CoverageResearchResult;
  /**
   * Capabilities the orchestrator already researched before calling here.
   * Their tools are one-shot per run — a second call hits the
   * `provider_search_runs` reservation and comes back POLICY_DENIED — so
   * offering them again guarantees the model spends its opening turn
   * collecting refusals. It read those as new failures and asked again.
   */
  alreadyResearchedCapabilities?: readonly string[];
  /**
   * What those already-researched capabilities returned. Withdrawing their
   * tools without carrying their results forward left synthesis with flights
   * and nothing else: the model cited none of the ten live hotel quotes or
   * four activities the run was holding, and the stay gap — which is computed
   * from this evidence — still reported NO_RESULTS.
   */
  researchedEvidence?: {
    hotels?: readonly HotelOffer[];
    activities?: readonly ActivityEvidence[];
    accommodations?: readonly AccommodationEvidence[];
  };
}, dependencies: PlanningDependencies = resolvePlanningDependencies()): Promise<PlanSynthesisOutcome> {
  // Get snapshot
  const [snapshot] = await db.select().from(constraintSnapshots)
    .where(eq(constraintSnapshots.id, params.snapshotId))
    .limit(1);

  if (!snapshot) throw new Error("Snapshot not found");

  // Get current plan version for this trip
  const existingPlans = await db.select().from(itineraryPlans)
    .where(eq(itineraryPlans.tripId, params.tripId))
    .orderBy(itineraryPlans.version);
  
  const nextVersion = existingPlans.length > 0 ? Math.max(...existingPlans.map(p => p.version)) + 1 : 1;

  // Fetch offers from all providers (all reference same snapshotId)
  const allFlights: FlightOffer[] = [];
  const allStays: StayOffer[] = [];
  const allActivities: ActivityEvidence[] = [];
  const allHotels: HotelOffer[] = [...(params.researchedEvidence?.hotels ?? [])];
  const allAccommodations: AccommodationEvidence[] = [...(params.researchedEvidence?.accommodations ?? [])];
  /**
   * Candidates this run's `places.search` returned, by `candidateId`.
   *
   * A candidateId is meaningful only inside the run that issued it, and the
   * model must not be the one carrying the candidate's coordinates and source
   * back to us. `places.propose` names an id; this map is what turns it into
   * the provider record that gets persisted.
   */
  const placeCandidatesThisRun = new Map<string, PlaceCandidate>();
  const activitiesEnabled = process.env.PLAN_ENABLE_ACTIVITIES === "true";
  const placesEnabled = process.env.PLAN_ENABLE_PLACES === "true";
  const navigationEnabled = process.env.PLAN_ENABLE_NAVIGATION === "true";
  const hotelEnabled = process.env.PLAN_ENABLE_HOTEL === "true";
  const accommodationDiscoveryEnabled = process.env.PLAN_ENABLE_ACCOMMODATION_DISCOVERY === "true";

  if (!snapshot.travelDateStart || !snapshot.travelDateEnd) {
    throw new PlanningDataUnavailableError(
      snapshot.travelDateStart ? ["travelDateEnd"] : ["travelDateStart"],
    );
  }

  // Phase 3: when the handler pre-collected research via `researchCoverageForSnapshot`,
  // honor it as the canonical evidence; otherwise fall back to in-line per-origin
  // research. The validator's `EVIDENCE_*` checks operate identically on either source.
  allActivities.push(...(params.researchedEvidence?.activities ?? []));
  if (params.coverage) {
    allFlights.push(...params.coverage.allFlights);
    allStays.push(...params.coverage.allStays);
    allActivities.push(...params.coverage.allActivities);
  } else if (!params.agentTaskRunId || !params.flightSearchPreferencesVersion) {
    for (const departureCity of snapshot.departureCities) {
      const result = await dependencies.flightProvider.searchFlights({
        origin: departureCity,
        destination: params.destination,
        dateStart: snapshot.travelDateStart,
        dateEnd: snapshot.travelDateEnd,
        snapshotId: params.snapshotId,
      });
      if (result.outcome !== "UNAVAILABLE") allFlights.push(...result.data);
    }
  }

  // There is no stay provider to call. `StayProvider` had exactly one
  // implementation in this repo — a stub returning NOT_CONFIGURED — so this
  // call could only ever leave `allStays` empty, and everything downstream
  // read that emptiness as "no accommodation was found". Runs holding ten live
  // Nuitee quotes and sixteen discovered stays reported `stay: NO_RESULTS`.
  //
  // Real accommodation reaches the plan as `hotels` (Nuitee / SerpApi quotes)
  // and is discovered through `accommodation.discover`; the stay gap is now
  // computed from that evidence. `allStays` stays as the plan contract's
  // `stays` slot, empty until something can genuinely fill it.
  // The flight tool takes controlled airport ids, and the snapshot holds city
  // names. Nothing translated between them, so the model dutifully passed
  // "Shanghai" and "Tokyo" and the search rejected them as uncontrolled — every
  // flight cell failed, the matrix was never complete, and the run died before
  // writing a plan. Resolving here and naming the ids in the tool schema means
  // the model can only ask for airports that exist, and a city with no
  // controlled airport is a flight gap stated up front instead of a failure
  // discovered at the end.
  // The one derivation every reader shares: the tool description below, the
  // gateway's required-cell matrix, and the two database completeness checks.
  // They used to derive it separately and disagree — the gateway demanded
  // `Singapore → Shanghai` while the model could only search `SIN → SHA`, so
  // its matrix never completed and it forced another flight search every turn
  // until the budget was gone.
  const flightRoutes = resolveFlightRouteMatrix({
    departureCities: snapshot.departureCities as string[],
    destinationCandidates: snapshot.destinationCandidates as string[],
  });
  const originAirports = flightRoutes.originIds;
  const destinationAirports = flightRoutes.destinationIds;
  const memberPreferences = buildPlanningModelProjection(snapshot.authorizedData);
  /**
   * Capabilities the tool loop could not deliver. Declared out here so they
   * reach the plan's recorded gaps: a plan built while a tool was failing must
   * say so, or it reads as complete when it is not.
   */
  const toolFailureGaps: Array<{ capability: string; code: string }> = [];
  /** Tool calls that already failed, keyed by name and arguments. */
  const failedToolCalls = new Map<string, { outcome: "UNAVAILABLE"; capability: string; reason: string; message: string }>();
  /**
   * How many times each tool's declared schema has refused the model's
   * arguments this run. Counted per tool rather than per argument set: the
   * model does not repeat one wrong shape, it produces a new one each turn,
   * and eight of those spent an entire run's budget on 2026-09-06.
   */
  const argumentRejectionsByTool = new Map<string, number>();
  /** Set once the gateway is entered; withdraws a tool from later turns. */
  let withdrawTool: ((toolName: string) => void) | undefined;
  const availableEvidence = buildPlanningEvidenceCatalog({
    flights: allFlights,
    activities: allActivities,
    hotels: allHotels,
    accommodations: allAccommodations,
  });
  for (const [category, entries] of Object.entries(availableEvidence)) {
    logSafeRuntimeEvent(params.ctx, {
      component: "planner",
      event: "evidence_catalog",
      operation: category,
      outcome: "success",
      itemCount: entries.length,
      relatedRunId: params.agentTaskRunId,
      relatedSnapshotId: params.snapshotId,
    });
  }

  /**
   * Bind compact model selections and run the same policy/evidence validation
   * used at persistence. The gateway calls this inside its repair loop; this
   * service calls it again after the gateway returns so no unvalidated model
   * output can cross the authoritative boundary.
   */
  const validateCandidatePlan = (candidate: Record<string, unknown>) => {
    // This must run on the raw model candidate, before evidence binding and
    // before the strict output schema. A compact hotel `{ id }` placed in
    // `stays[]` otherwise remains unbound and the stay schema reports only
    // missing fields, hiding the actionable category mismatch from repair.
    const slotViolations = preflightCategorySlots({
      candidate,
      flights: allFlights,
      stays: allStays,
      activities: allActivities,
      hotels: allHotels,
      accommodations: allAccommodations,
    });
    if (slotViolations.length > 0) {
      const error = new PlanValidationError(slotViolations);
      recordPlanValidationFailure(error);
      throw error;
    }
    const bound = params.agentTaskRunId
      ? bindPlanSelectionsToEvidence({
        candidate,
        flights: allFlights,
        stays: allStays,
        activities: allActivities,
        hotels: allHotels,
        accommodations: allAccommodations,
      })
      : candidate;
    validateProviderCoverage({ requiredOrigins: snapshot.departureCities, flights: allFlights });
    try {
      return validatePlanOutput({
        planData: bound,
        snapshot: {
          authorizedData: snapshot.authorizedData,
          departureCities: snapshot.departureCities,
          destinationCandidates: snapshot.destinationCandidates,
          travelDateStart: snapshot.travelDateStart ?? undefined,
          travelDateEnd: snapshot.travelDateEnd ?? undefined,
        },
        evidence: {
          flights: allFlights,
          stays: allStays,
          activities: allActivities,
          hotels: allHotels,
          accommodations: allAccommodations,
        },
        requireHotels: hotelEnabled && allHotels.some((hotel) => hotel.destinationId === params.destination),
      });
    } catch (error) {
      if (error instanceof PlanValidationError) recordPlanValidationFailure(error);
      throw error;
    }
  };
  let candidatePlanData: Record<string, unknown>;
  let planData: ReturnType<typeof validatePlanOutput>;
  try {
  if (params.agentTaskRunId && params.flightSearchPreferencesVersion) {
    /**
     * The places execution context, carrying this run's candidate store so the
     * skill can resolve a `candidateId` itself instead of trusting a caller to
     * hand back the provider's own record.
     */
    const placeSkillContext = () => ({
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      agentTaskRunId: params.agentTaskRunId,
      resolveCandidate: (candidateId: string) => placeCandidatesThisRun.get(candidateId),
    });
    const dispatchPlanningTool = async (call: { name: string; arguments: unknown }) => {
        const snapshotContext = {
          authorizedData: memberPreferences,
          departureCities: snapshot.departureCities as string[],
          destinationCandidates: snapshot.destinationCandidates as string[],
          travelDateStart: snapshot.travelDateStart ?? undefined,
          travelDateEnd: snapshot.travelDateEnd ?? undefined,
        };
        if (call.name === "flight.search") {
          const modelArgs = parseToolArguments(flightSearchModelArgumentsSchema, call.name, call.arguments);
          const result = await invokeSkill("flight.search", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            flightSearch: {
              tripId: params.tripId, snapshotId: params.snapshotId, searchPreferencesVersion: preferences.version,
              searchPreferences: { tripType: preferences.tripType as "ONE_WAY" | "ROUND_TRIP", adults: preferences.adults, cabin: preferences.cabin as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST", currency: preferences.currency },
              agentTaskRunId: params.agentTaskRunId,
            },
            policyGate: new DefaultPolicyGate("shared"),
          }, {
            snapshotId: params.snapshotId,
            originId: modelArgs.originId,
            destinationId: modelArgs.destinationId,
            tripType: preferences.tripType as "ONE_WAY" | "ROUND_TRIP",
            departureDate: snapshot.travelDateStart,
            ...(preferences.tripType === "ROUND_TRIP" ? { returnDate: snapshot.travelDateEnd } : {}),
            adults: preferences.adults,
            cabin: preferences.cabin as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST",
            currency: preferences.currency,
          }, { signal: params.signal });
          if ((result as { outcome: string }).outcome === "LIVE") allFlights.push(...(result as { offers: FlightOffer[] }).offers);
          return result;
        }
        if (call.name === "activities.search" && activitiesEnabled) {
          const modelArgs = parseToolArguments(activitiesSearchModelArgumentsSchema, call.name, call.arguments);
          const result = await invokeSkill("activities.search", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            activitiesSearch: {
              tripId: params.tripId, snapshotId: params.snapshotId,
              currency: preferences.currency,
              agentTaskRunId: params.agentTaskRunId,
            },
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
          if ((result as { outcome: string }).outcome === "LIVE") {
            allActivities.push(...(result as { activities: ActivityEvidence[] }).activities);
          }
          return result;
        }
        if (call.name === "places.search" && placesEnabled) {
          const modelArgs = parseToolArguments(placeSearchModelArgumentsSchema, call.name, call.arguments);
          const result = await invokeSkill("places.search", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            placeSearch: placeSkillContext(),
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
          // Remember what the provider actually said. `places.propose` names a
          // candidateId from here; nothing else may supply the record behind
          // it, least of all the model that read a trimmed copy of it.
          for (const candidate of placeCandidatesOf(result)) {
            placeCandidatesThisRun.set(candidate.candidateId, candidate);
          }
          return result;
        }
        // One skill, three tools. The `action` is supplied here rather than
        // asked of the model, so it can no longer pair an action with the
        // wrong fields — the failure that consumed a whole run's turn budget.
        const placeMutationAction = PLACE_MUTATION_ACTION_BY_TOOL[call.name];
        if (placeMutationAction && placesEnabled) {
          const rawArgs = parseToolArguments(
            tripPlaceModelArgumentsSchema,
            call.name,
            { ...((call.arguments as Record<string, unknown> | null) ?? {}), action: placeMutationAction },
          );
          return invokeSkill("places.adopt", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            placeSearch: placeSkillContext(),
            policyGate: new DefaultPolicyGate("shared"),
          }, rawArgs, { signal: params.signal });
        }
        if (call.name === "navigation.route" && navigationEnabled) {
          const modelArgs = parseToolArguments(navigationRouteModelArgumentsSchema, call.name, call.arguments);
          return invokeSkill("navigation.route", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            navigation: { tripId: params.tripId, snapshotId: params.snapshotId, agentTaskRunId: params.agentTaskRunId },
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
        }
        if (call.name === "hotel.search" && hotelEnabled && stayPreferences) {
          const modelArgs = parseToolArguments(hotelSearchModelArgumentsSchema, call.name, call.arguments);
          // Spec §3.1: pick the provider the task was bound to, not the
          // current env. Falls back to the env-resolved value when no run
          // row is in scope (legacy call paths, tests).
          const hotelProviderResolution = await resolveBoundHotelProvider(params.agentTaskRunId);
          const result = await invokeSkill("hotel.search", {
            ctx: params.ctx, snapshot: snapshotContext,
            hotelSearch: {
              tripId: params.tripId, snapshotId: params.snapshotId, searchPreferencesVersion: stayPreferences.version,
              searchPreferences: { roomCount: stayPreferences.roomCount, adultsPerRoom: stayPreferences.adultsPerRoom, currency: stayPreferences.currency },
              locale: "en", agentTaskRunId: params.agentTaskRunId,
              provider: hotelProviderResolution.providerName,
              providerAdapter: hotelProviderResolution.adapter,
              ...(hotelProviderResolution.authorization ? { quoteNationalityAuthorization: hotelProviderResolution.authorization } : {}),
            },
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
          if ((result as { outcome: string }).outcome === "LIVE") allHotels.push(...(result as { hotels: HotelOffer[] }).hotels);
          return result;
        }
        if (call.name === "accommodation.discover" && accommodationDiscoveryEnabled) {
          const modelArgs = parseToolArguments(accommodationDiscoveryModelArgumentsSchema, call.name, call.arguments);
          const result = await invokeSkill("accommodation.discover", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            accommodationDiscovery: {
              tripId: params.tripId,
              snapshotId: params.snapshotId,
              agentTaskRunId: params.agentTaskRunId,
            },
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
          if ((result as { outcome: string }).outcome === "LIVE") {
            allAccommodations.push(...(result as { accommodations: AccommodationEvidence[] }).accommodations);
          }
          return result;
        }
        throw new Error("UNKNOWN_SKILL");
    };

    const toolGateway = dependencies.modelGateway.generateStructuredPlanWithTools;
    if (!toolGateway) throw new PlanningDataUnavailableError(["tool_calling_not_supported"]);
    const preferences = await loadCurrentConfirmedSearchPreferences({
      tripId: params.tripId, version: params.flightSearchPreferencesVersion,
    });
    const stayPreferences = hotelEnabled
      ? await loadCurrentStaySearchPreferences({ tripId: params.tripId, version: params.staySearchPreferencesVersion! })
      : null;
    candidatePlanData = await toolGateway.call(dependencies.modelGateway, {
      destination: params.destination,
      destinationCandidates: snapshot.destinationCandidates as string[],
      flightSearchConstraints: {
        originIds: flightRoutes.originIds,
        destinationIds: flightRoutes.destinationIds,
        tripType: preferences.tripType as "ONE_WAY" | "ROUND_TRIP",
        departureDate: snapshot.travelDateStart,
        ...(preferences.tripType === "ROUND_TRIP" ? { returnDate: snapshot.travelDateEnd } : {}),
        adults: preferences.adults,
        cabin: preferences.cabin as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST",
        currency: preferences.currency,
      },
      availableEvidence,
      memberPreferences,
      planningMemory: (memberPreferences.planningMemory ?? { members: {}, tripWidePreferences: {} }) as import("../providers/model-gateway.js").SharedPlanningMemoryInput,
      maxTurns: Number(process.env.MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS ?? 8), signal: params.signal, ctx: params.ctx,
      // P3 (planner-resilience §6): hand the gateway a critic so that when
      // either `beforeFinal` (Gate A / Gate B) or the final structural check
      // throws, the gateway can re-emit a deterministic system message and
      // give the model one bounded repair iteration. The critic returns
      // `null` for errors it cannot safely describe (e.g. our own
      // `PlanEvidenceUnavailableError`, which is a Gate-B branch signal —
      // not a fixable output defect) so the original error propagates and
      // `generatePlan` can switch to the research-summary branch instead.
      repairBudget: Number(process.env.MODEL_GATEWAY_PLAN_REPAIR_BUDGET ?? 2),
      onToolControl: (control: { withdrawTool: (toolName: string) => void }) => { withdrawTool = control.withdrawTool; },
      onValidationFailure: (error: unknown) => {
        if (error instanceof PlanEvidenceUnavailableError) return null;
        return toCritiques(error);
      },
      validateFinalPlan: (candidate: Record<string, unknown>) => {
        validateCandidatePlan(candidate);
      },
      beforeFinal: async () => {
        // Both gates below exist to stop the model finalizing while it could
        // still have searched. When no controlled airport serves one of the
        // cities there is nothing left to search, so insisting on a complete
        // flight matrix would refuse every plan for a route the reference list
        // does not cover — which is most of them, the list holding five
        // airports. That is a flight gap on the plan, not a failed run.
        const flightsAreSearchable = originAirports.length > 0 && destinationAirports.length > 0;
        if (flightsAreSearchable) {
          const matrix = await evaluateFlightResearchCompleteness({
            snapshotId: params.snapshotId, agentTaskRunId: params.agentTaskRunId!,
            routes: flightRoutes,
          });
          if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);
          // Gate B used to refuse here when no cell on this destination came
          // back LIVE. It no longer does: one refused flight request withheld
          // every other capability the run had verified. A destination with no
          // usable flight is a gap on the plan, and the plan is still produced
          // from whatever else is live. What must still hold is that the plan
          // cites *something* — enforced at persistence, below, where the tool
          // loop has finished adding evidence.
          // Re-check usable flight coverage before accepting final synthesis.
          // Stay unavailability is intentionally a Phase 4 service gap and is
          // represented as an empty selection, never a runtime fixture.
          validateProviderCoverage({
            requiredOrigins: snapshot.departureCities,
            flights: allFlights,
          });
        } else {
          toolFailureGaps.push({ capability: "flight", code: "NOT_CONFIGURED" });
        }
        if (activitiesEnabled) {
          const activitiesMatrix = await evaluateActivitiesResearchCompleteness({
            snapshotId: params.snapshotId,
            agentTaskRunId: params.agentTaskRunId!,
            destinationCandidates: snapshot.destinationCandidates as string[],
          });
          if (!activitiesMatrix.complete) {
            throw new ActivitiesResearchIncompleteError(activitiesMatrix.cells);
          }
        }
        if (hotelEnabled) {
          const hotelMatrix = await evaluateHotelResearchCompleteness({ snapshotId: params.snapshotId, agentTaskRunId: params.agentTaskRunId!, destinationCandidates: snapshot.destinationCandidates as string[] });
          if (!hotelMatrix.complete) throw new HotelResearchIncompleteError(hotelMatrix.cells);
        }
        if (accommodationDiscoveryEnabled) {
          const accommodationMatrix = await evaluateAccommodationResearchCompleteness({
            snapshotId: params.snapshotId,
            agentTaskRunId: params.agentTaskRunId!,
            destinationCandidates: snapshot.destinationCandidates as string[],
          });
          if (!accommodationMatrix.complete) throw new AccommodationResearchIncompleteError(accommodationMatrix.cells);
        }
      },
      tools: planningToolsFor(params.alreadyResearchedCapabilities ?? [], buildPlanningToolDefinitions({
        originAirports,
        destinationAirports,
        activitiesEnabled,
        // `places.search` is one-shot per run; once coverage research has spent
        // it, the run can produce no new candidateId, so the whole places
        // family goes with it rather than being offered unanswerable.
        placesEnabled: placesEnabled && !(params.alreadyResearchedCapabilities ?? []).includes("places"),
        navigationEnabled,
        hotelEnabled,
        accommodationDiscoveryEnabled,
      })),
      dispatchTool: async (call) => {
        // A tool that fails must not end the run. The model asked for
        // something it could not have — a flight between airports missing
        // from the controlled reference list, a provider that is down — and
        // the useful answer is to say so and let it plan what it still can.
        // Throwing instead discarded every result the other tools had already
        // returned and produced no plan at all, which is how a single
        // uncontrolled airport meant no itinerary.
        //
        // Cancellation is different: that means this worker must stop, not
        // that a capability is unavailable.
        // A tool that has already failed for these exact arguments will fail
        // the same way again. Answering from this record instead of re-running
        // it stops the loop that made the model spend its whole turn budget
        // retrying: it asked, got "unavailable", asked again, and hit the
        // once-per-run guard, which read as another failure worth retrying.
        const callKey = `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
        const alreadyFailed = failedToolCalls.get(callKey);
        if (alreadyFailed) return alreadyFailed;
        try {
          return await dispatchPlanningTool(call);
        } catch (error) {
          if (params.signal?.aborted) throw error;
          if (error instanceof Error && error.name === "AbortError") throw error;
          const capability = call.name.split(".")[0] ?? "unknown";
          // `classifyError` and not `error.code`: the gap the traveller reads
          // must say whose failure it was. A `ZodError` from the model's own
          // arguments is not a `SkillError`, so the old fallback filed it as
          // `UPSTREAM_FAILURE` and the run reported "the provider was
          // temporarily unavailable" about calls no provider ever saw.
          const code = classifyError(error);
          toolFailureGaps.push({ capability, code });
          if (code === "SKILL_CONTRACT_VIOLATION") {
            // A tool whose declared schema we keep rejecting arguments against
            // is not going to start accepting them. Count it, and withdraw it
            // once the model has demonstrated it cannot call it — keying the
            // memo below on the exact arguments does not help here, because
            // each attempt is wrong in a new way and so costs a fresh turn.
            const rejections = (argumentRejectionsByTool.get(call.name) ?? 0) + 1;
            argumentRejectionsByTool.set(call.name, rejections);
            metrics.inc("planning_tool_args_rejected_total", { tool: call.name });
            if (rejections >= TOOL_ARGUMENT_REJECTION_LIMIT) withdrawTool?.(call.name);
          }
          logSafeRuntimeEvent(params.ctx, {
            component: "planner", event: "tool", operation: call.name,
            outcome: "failure", errorCode: String(code), toolContext: "planning",
          });
          // The code alone says a tool was refused and not what it was refused
          // for, which is the difference between "the model asked for the wrong
          // airport" and "the provider is down".
          pinoInstance.warn({
            component: "planning-tool-dispatch",
            tool: call.name,
            errorCode: String(code),
            errorClass: (error as Error)?.name ?? typeof error,
            errorMessage: String((error as Error)?.message ?? error).slice(0, 300),
          }, "Planning tool failed");
          const answer = {
            outcome: "UNAVAILABLE" as const,
            capability: call.name,
            reason: String(code),
            // Directive, because the model is deciding what to do next: an
            // "unavailable" with no instruction reads as something to try
            // again.
            message: "This request cannot be answered and will not succeed if repeated. "
              + "Do not call this tool with these arguments again. Continue planning with what you already have.",
          };
          failedToolCalls.set(callKey, answer);
          return answer;
        }
      },
    });
  } else {
    candidatePlanData = await dependencies.modelGateway.generateStructuredPlan({ destination: params.destination, flights: allFlights, memberPreferences, ctx: params.ctx, signal: params.signal });
  }

  // This repeats the gateway's callback on purpose. The callback exists to
  // support bounded model repair; this service-side check is the authoritative
  // boundary and also covers gateway implementations without that capability.
  planData = validateCandidatePlan(candidatePlanData);

  // Per §1.3 of the planner-resilience design, a destination that fails Gate B
  // (no commercial flight authority) must produce a research summary, not a
  // plan. The discriminator has already thrown `PlanEvidenceUnavailableError`
  // from inside `beforeFinal`; we catch it here at the planning-service boundary
  // and route to the research-summary branch — leaving the plan branch only for
  // destinations that survived both gates.
  } catch (error) {
    const summaryReason = researchSummaryReasonFor(error);
    if (summaryReason) {
      if (!params.agentTaskRunId || !params.leaseToken) {
        // No durable run to write a summary for — rethrow so the worker surfaces
        // the failure (matches the pre-P0 path which also had no run guard).
        throw error;
      }
      return await persistResearchSummary({
        ctx: params.ctx,
        tripId: params.tripId,
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        leaseToken: params.leaseToken,
        reason: summaryReason,
        toolFailureGaps: toolFailureGaps.map((g) => ({
          capability: g.capability,
          code: g.code,
        })),
        snapshotFields: {
          departureCities: snapshot.departureCities as string[],
          destinationCandidates: snapshot.destinationCandidates as string[],
        },
        allFlights,
        stayEvidenceCount: allHotels.length + allAccommodations.length,
        activitiesEnabled,
        hotelEnabled,
        accommodationDiscoveryEnabled,
      });
    }
    throw error;
  }

  // Only validated output may cross the authoritative persistence boundary.
  // All four writes (plan, offers, evidence, audit) commit atomically; if
  // any one fails the validated plan is discarded.
  let planId: { planId: string; gaps: ServiceGap[] };
  try {
    planId = await db.transaction(async (tx) => {
    if (params.agentTaskRunId) {
      if (!params.leaseToken || !params.flightSearchPreferencesVersion || (hotelEnabled && !params.staySearchPreferencesVersion)) throw new Error("Planning task lease authority is incomplete");
      const [currentTask] = await tx.select().from(agentTaskRuns).where(and(
        eq(agentTaskRuns.id, params.agentTaskRunId), eq(agentTaskRuns.leaseToken, params.leaseToken),
        eq(agentTaskRuns.status, "RUNNING"), eq(agentTaskRuns.snapshotId, params.snapshotId),
        gt(agentTaskRuns.leaseExpiresAt, new Date()),
      )).limit(1);
      const [latestPreference] = await tx.select().from(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, params.tripId)).orderBy(desc(tripSearchPreferences.version)).limit(1);
      const [latestStayPreference] = hotelEnabled
        ? await tx.select().from(tripStaySearchPreferences).where(eq(tripStaySearchPreferences.tripId, params.tripId)).orderBy(desc(tripStaySearchPreferences.version)).limit(1)
        : [];
      if (!currentTask || latestPreference?.version !== params.flightSearchPreferencesVersion
        || (hotelEnabled && latestStayPreference?.version !== params.staySearchPreferencesVersion)) {
        throw new Error("Planning task is stale or no longer owns finalization");
      }
      // This is the authoritative completion gate.  The earlier beforeFinal
      // check avoids an unnecessary final model response, but evidence can
      // change after that check; re-read it through this transaction before
      // any plan state is made durable.
      const matrix = await evaluateFlightResearchCompleteness({
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        routes: flightRoutes,
        client: tx,
      });
      // Phase 4 outcome matrix: a cell that returned UNAVAILABLE is an
      // auditable gap rather than a fatal condition. MISSING cells (the
      // planner never even tried) still hard-fail the round.
      if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);
      // A plan has to rest on something. Every capability may individually be
      // reported as a gap, but a card naming a destination and citing no
      // verifiable fact at all is not a plan — it is the "Demo data" shape
      // `AGENTS.md` forbids, dressed as a real one. Such a run writes the
      // research summary instead, which states honestly what was and was not
      // obtained.
      if (allFlights.length === 0 && allStays.length === 0
        && allActivities.length === 0 && allHotels.length === 0) {
        throw new PlanEvidenceUnavailableError(params.destination);
      }
      if (hotelEnabled) {
        const hotelMatrix = await evaluateHotelResearchCompleteness({
          snapshotId: params.snapshotId,
          agentTaskRunId: params.agentTaskRunId,
          destinationCandidates: snapshot.destinationCandidates as string[],
          client: tx,
        });
        if (!hotelMatrix.complete) throw new HotelResearchIncompleteError(hotelMatrix.cells);
      }
      if (activitiesEnabled) {
        const activitiesMatrix = await evaluateActivitiesResearchCompleteness({
          snapshotId: params.snapshotId,
          agentTaskRunId: params.agentTaskRunId,
          destinationCandidates: snapshot.destinationCandidates as string[],
          client: tx,
        });
        if (!activitiesMatrix.complete) {
          throw new ActivitiesResearchIncompleteError(activitiesMatrix.cells);
        }
      }
    }

    // Consent can be revoked, a preference edited or a trip override changed
    // while the model was working. Re-derive the projection sources through
    // this transaction; if they moved, the validated plan is discarded rather
    // than made authoritative on memory that no longer exists (§6).
    const recordedFingerprint = fingerprintFromSnapshot(snapshot.authorizedData);
    if (recordedFingerprint !== null) {
      const currentFingerprint = await computeMemorySourceFingerprint({
        tripId: params.tripId,
        memberUserIds: await resolveMemberIds(tx, params.tripId, params.memberIds),
        tx,
      });
      if (currentFingerprint !== recordedFingerprint) {
        throw new MemorySourceChangedError(params.snapshotId);
      }
    }

    const outputMode = params.outputMode ?? "ACTIVATE";
    const insertStatus = outputMode === "ACTIVATE" ? "ACTIVE" : "PROPOSED";
    const [plan] = await tx.insert(itineraryPlans).values({
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      version: nextVersion,
      status: insertStatus,
      planData,
      replacedByPlanId: null,
    }).returning();

    const normalizedOffers = [
      ...allFlights.map(offer => ({
        category: "flight",
        providerName: offer.providerName,
        offer,
      })),
      ...allStays.map(offer => ({
        category: "stay",
        providerName: offer.source,
        offer,
      })),
      ...allActivities.map(offer => ({
        category: "activity",
        providerName: "viator_mcp",
        offer,
      })),
      ...allHotels.map(offer => ({
        category: "hotel",
        providerName: offer.providerName,
        offer,
      })),
      ...allAccommodations.map(offer => ({
        category: "accommodation",
        providerName: "opentripmap",
        offer,
      })),
    ];

    await tx.insert(providerOffers).values(normalizedOffers.map(({ category, providerName, offer }) => ({
      snapshotId: params.snapshotId,
      planId: plan.id,
      category,
      providerName,
      offerData: offer as unknown as Record<string, unknown>,
      capturedAt: new Date(offer.capturedAt),
      // Flight is the only category with a confirmation/booking-time
      // freshness requirement (spec §6.2) — carry the fields
      // `validateSelectedFlightOffersFresh` needs from the in-memory
      // FlightOffer through to the plan-linked row. Search-time
      // `provider_offers` rows already have these, but this second,
      // plan-linked row (the one `planId` actually resolves to) previously
      // never did, so `expires_at` was always NULL for any selected offer.
      ...(category === "flight" ? {
        providerOfferId: (offer as FlightOffer).providerOfferId,
        currency: (offer as FlightOffer).currency,
        expiresAt: new Date((offer as FlightOffer).expiresAt),
        expiryProvenance: (offer as FlightOffer).expiryProvenance,
      } : {}),
    })));

    await tx.insert(sourceEvidence).values(normalizedOffers.map(({ category, offer }) => ({
      planId: plan.id,
      category,
      itemId: offer.id,
      source: offer.source,
      capturedAt: new Date(offer.capturedAt),
      metadata: null,
    })));

    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_CREATE",
      tripId: params.tripId,
      planId: plan.id,
      summary: { version: nextVersion, destination: params.destination, snapshotId: params.snapshotId },
      tx,
    });

    // Phase 4 — record the service outcome matrix on the same transaction.
    // Re-evaluate every research matrix against `tx` so the gap set reflects
    // the final state of `provider_search_runs`, then validate and cap via
    // the shared helper. UNAVAILABLE evidence becomes a `service_gaps` row;
    // the task terminator becomes `COMPLETED_WITH_GAPS` rather than
    // `COMPLETED`. The helper is the same one `persistResearchSummary` uses,
    // so plan-side and research-summary-side gap accounting cannot drift.
    let validatedServiceGaps: ServiceGap[] = [];
    let researchStatus: "COMPLETED_WITH_GAPS" | "COMPLETE" = "COMPLETE";
    if (params.agentTaskRunId) {
      const evaluated = await evaluateAndValidateServiceGaps({
        tx,
        ctx: params.ctx,
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        snapshot: {
          departureCities: snapshot.departureCities as string[],
          destinationCandidates: snapshot.destinationCandidates as string[],
        },
        allFlights,
        stayEvidenceCount: allHotels.length + allAccommodations.length,
        toolFailureGaps: toolFailureGaps.map((g) => ({
          capability: g.capability,
          code: g.code,
        })),
        activitiesEnabled,
        hotelEnabled,
        accommodationDiscoveryEnabled,
      });
      validatedServiceGaps = evaluated.gaps;
      researchStatus = evaluated.status;
    }
    if (params.agentTaskRunId) {
      // Drizzle's jsonb column expects `Record<string, unknown>[]`; we cast
      // here at the boundary only after `serviceGapSchema.strict()` has
      // validated every element (see `evaluateAndValidateServiceGaps`).
      const serviceGapsForDb = validatedServiceGaps as unknown as Record<string, unknown>[];
      await tx.insert(planningResearchResults).values({
        tripId: params.tripId,
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        status: researchStatus,
        serviceGaps: serviceGapsForDb,
        resultPlanId: plan.id,
      }).onConflictDoUpdate({
        target: planningResearchResults.agentTaskRunId,
        set: {
          status: researchStatus,
          serviceGaps: serviceGapsForDb,
          resultPlanId: plan.id,
        },
      });
      await recordAudit({
        ctx: params.ctx,
        action: "RESEARCH_RESULT_RECORDED",
        tripId: params.tripId,
        summary: {
          status: researchStatus,
          gapCount: validatedServiceGaps.length,
          capabilities: [...new Set(validatedServiceGaps.map((g) => g.capability))].sort(),
        },
        tx,
      });
    }

    if (params.agentTaskRunId) {
      const taskTerminalStatus = researchStatus === "COMPLETED_WITH_GAPS" ? "COMPLETED_WITH_GAPS" : "COMPLETED";
      const [completed] = await tx.update(agentTaskRuns).set({
        status: taskTerminalStatus, resultPlanId: plan.id, leaseToken: null, leaseExpiresAt: null,
        finishedAt: new Date(), updatedAt: new Date(), errorCode: null,
      }).where(and(
        eq(agentTaskRuns.id, params.agentTaskRunId), eq(agentTaskRuns.leaseToken, params.leaseToken!),
        eq(agentTaskRuns.status, "RUNNING"), gt(agentTaskRuns.leaseExpiresAt, new Date()),
      )).returning();
      if (!completed) throw new Error("Planning task lost finalization lease");
    }

      return { planId: plan.id, gaps: validatedServiceGaps };
    });
  } catch (error) {
    const summaryReason = researchSummaryReasonFor(error);
    if (summaryReason) {
      if (!params.agentTaskRunId || !params.leaseToken) throw error;
      return await persistResearchSummary({
        ctx: params.ctx,
        tripId: params.tripId,
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        leaseToken: params.leaseToken,
        reason: summaryReason,
        toolFailureGaps: toolFailureGaps.map((g) => ({ capability: g.capability, code: g.code })),
        snapshotFields: {
          departureCities: snapshot.departureCities as string[],
          destinationCandidates: snapshot.destinationCandidates as string[],
        },
        allFlights,
        stayEvidenceCount: allHotels.length + allAccommodations.length,
        activitiesEnabled,
        hotelEnabled,
        accommodationDiscoveryEnabled,
      });
    }
    throw error;
  }

  return { outcome: "PLAN", planId: planId.planId, gaps: planId.gaps };
}

/**
 * Activate a PROPOSED plan after unanimous adoption vote (Phase 4 wiring).
 *
 * Atomicity: idempotent on `(planId, status)`. If the plan was super-SUPERSEDED
 * by a newer REPLAN while voting was in flight (spec §6.2), this returns null
 * instead of mutating; the caller's vote tally handler maps that to a
 * structured no-op rather than an exception.
 */
export async function activateProposedPlan(params: {
  ctx: RequestContext;
  planId: string;
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0];
}): Promise<string | null> {
  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const [plan] = await tx.select().from(itineraryPlans)
      .where(eq(itineraryPlans.id, params.planId))
      .for("update")
      .limit(1);
    if (!plan) return null;
    if (plan.status !== "PROPOSED") {
      if (plan.status === "ACTIVE") return plan.id;
      return null;
    }
    // Spec §6.2 names confirmation and the booking sandbox as the freshness
    // checkpoints, not adoption — ACTIVE means "this is the chosen
    // itinerary," not "this quote is still bookable." Adoption must succeed
    // even for SYNTHETIC-provenance offers (e.g. SerpAPI, which never
    // qualifies as PROVIDER_VERIFIED); the guard runs later, in
    // `setConfirmation` and `submitBooking`.
    // Find the previous ACTIVE (or PROPOSED) head to wire replacedByPlanId.
    await tx.update(itineraryPlans)
      .set({ status: "SUPERSEDED", supersededAt: new Date() })
      .where(and(
        eq(itineraryPlans.tripId, plan.tripId),
        eq(itineraryPlans.status, "PROPOSED"),
        ne(itineraryPlans.id, plan.id),
      ));
    const [updated] = await tx.update(itineraryPlans)
      .set({ status: "ACTIVE", supersededAt: null })
      .where(and(eq(itineraryPlans.id, plan.id), eq(itineraryPlans.status, "PROPOSED")))
      .returning({ id: itineraryPlans.id });
    if (!updated) return null;
    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_ADOPTED",
      tripId: plan.tripId,
      planId: plan.id,
      summary: { activatedAt: new Date().toISOString() },
      tx,
    });
    return updated.id;
  };
  return params.tx ? run(params.tx) : db.transaction(run);
}

/**
 * Mark a plan as STALE due to a change event.
 */
export async function markPlanStale(params: {
  ctx: RequestContext;
  planId: string;
  reason: string;
}): Promise<void> {
  await db.update(itineraryPlans)
    .set({ status: "STALE", staleReason: params.reason, supersededAt: new Date() })
    .where(eq(itineraryPlans.id, params.planId));

  await recordAudit({
    ctx: params.ctx,
    action: "PLAN_STALE",
    planId: params.planId,
    summary: { reason: params.reason },
  });
}

/**
 * Get the latest active plan for a trip.
 */
export async function getLatestActivePlan(tripId: string): Promise<{ id: string; version: number; planData: Record<string, unknown> } | null> {
  const plans = await db.select().from(itineraryPlans)
    .where(and(eq(itineraryPlans.tripId, tripId), eq(itineraryPlans.status, "ACTIVE")))
    .orderBy(desc(itineraryPlans.version))
    .limit(1);

  if (plans.length === 0) return null;
  return { id: plans[0].id, version: plans[0].version, planData: plans[0].planData as Record<string, unknown> };
}
