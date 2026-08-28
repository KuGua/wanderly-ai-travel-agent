import { db } from "../db/database.js";
import { constraintSnapshots, itineraryPlans, sourceEvidence, providerOffers, agentTaskRuns, tripSearchPreferences } from "../db/schema.js";
import { eq, and, desc, gt } from "drizzle-orm";
import { buildAuthorizedData } from "./consent-service.js";
import { createTravelProviders } from "../providers/live-provider-factory.js";
import { modelGateway, __setModelGatewayForTests } from "../providers/gateway-factory.js";
import type { ModelGateway } from "../providers/model-gateway.js";
import type { FlightProvider, GroundProvider, StayProvider } from "../providers/types.js";
import { validatePlanOutput } from "../policy/plan-output-validator.js";
import { DefaultPolicyGate } from "../agents/policy-gate.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { flightSearchModelArgumentsSchema } from "./flight-search-service.js";
import { loadCurrentConfirmedSearchPreferences } from "./flight-search-preferences-service.js";
import { evaluateFlightResearchCompleteness, FlightResearchIncompleteError } from "./flight-research-matrix-service.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import type { FlightOffer, StayOffer, GroundOffer } from "../types/domain.js";

export interface PlanningDependencies {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  groundProvider: GroundProvider;
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
    stayProvider: configuredProviders.stayProvider,
    groundProvider: configuredProviders.groundProvider,
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
 * Completeness gate for provider-backed planning.
 * An empty provider result is an explicit failure, never implicit inventory.
 */
export function validateProviderCoverage(params: {
  requiredOrigins: string[];
  flights: FlightOffer[];
  stays: StayOffer[];
  ground: GroundOffer[];
}): void {
  const missing = params.requiredOrigins
    .filter(origin => !params.flights.some(flight => flight.origin === origin))
    .map(origin => `flight:${origin}`);

  if (params.stays.length === 0) missing.push("stay");
  if (params.ground.length === 0) missing.push("ground");

  if (missing.length > 0) {
    throw new PlanningDataUnavailableError(missing);
  }
}

/**
 * Create a new constraint snapshot for a planning round.
 * Captures authorized data for all members at this point in time.
 */
export async function createConstraintSnapshot(params: {
  tripId: string;
  memberIds: string[];
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
}): Promise<string> {
  // Get current version for this trip
  const existing = await db.select().from(constraintSnapshots)
    .where(eq(constraintSnapshots.tripId, params.tripId))
    .orderBy(constraintSnapshots.version);
  
  const nextVersion = existing.length > 0 ? Math.max(...existing.map(s => s.version)) + 1 : 1;

  // Build authorized data for each member
  const authorizedData: Record<string, unknown> = {};
  for (const memberId of params.memberIds) {
    authorizedData[memberId] = await buildAuthorizedData({ tripId: params.tripId, userId: memberId });
  }

  const [snapshot] = await db.insert(constraintSnapshots).values({
    tripId: params.tripId,
    version: nextVersion,
    authorizedData,
    departureCities: params.departureCities,
    destinationCandidates: params.destinationCandidates,
    travelDateStart: params.travelDateStart,
    travelDateEnd: params.travelDateEnd,
  }).returning();

  return snapshot.id;
}

/**
 * Generate a new plan based on the constraint snapshot.
 * All provider calls reference the same snapshot ID.
 */
export async function generatePlan(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  destination: string;
  memberIds: string[];
  agentTaskRunId?: string;
  flightSearchPreferencesVersion?: number;
  signal?: AbortSignal;
  leaseToken?: string;
}, dependencies: PlanningDependencies = resolvePlanningDependencies()): Promise<string> {
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
  const allGround: GroundOffer[] = [];

  if (!snapshot.travelDateStart || !snapshot.travelDateEnd) {
    throw new PlanningDataUnavailableError(
      snapshot.travelDateStart ? ["travelDateEnd"] : ["travelDateStart"],
    );
  }

  if (!params.agentTaskRunId || !params.flightSearchPreferencesVersion) {
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

  const stayResult = await dependencies.stayProvider.searchStays({
    destination: params.destination,
    checkIn: snapshot.travelDateStart,
    checkOut: snapshot.travelDateEnd,
    snapshotId: params.snapshotId,
  });
  if (stayResult.outcome !== "UNAVAILABLE") {
    allStays.push(...stayResult.data);
  }

  const groundResult = await dependencies.groundProvider.searchGround({
    destination: params.destination,
    snapshotId: params.snapshotId,
  });
  if (groundResult.outcome !== "UNAVAILABLE") {
    allGround.push(...groundResult.data);
  }

  const memberPreferences = snapshot.authorizedData;
  let candidatePlanData: Record<string, unknown>;
  if (params.agentTaskRunId && params.flightSearchPreferencesVersion) {
    const toolGateway = dependencies.modelGateway.generateStructuredPlanWithTools;
    if (!toolGateway) throw new PlanningDataUnavailableError(["tool_calling_not_supported"]);
    const preferences = await loadCurrentConfirmedSearchPreferences({
      tripId: params.tripId, version: params.flightSearchPreferencesVersion,
    });
    candidatePlanData = await toolGateway.call(dependencies.modelGateway, {
      destination: params.destination, stays: allStays, ground: allGround, memberPreferences,
      maxTurns: Number(process.env.MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS ?? 8), signal: params.signal, ctx: params.ctx,
      beforeFinal: async () => {
        const matrix = await evaluateFlightResearchCompleteness({
          snapshotId: params.snapshotId, agentTaskRunId: params.agentTaskRunId!,
          departureCities: snapshot.departureCities as string[], destinationCandidates: snapshot.destinationCandidates as string[],
        });
        if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);
      },
      tools: [{
        name: "flight.search", description: "Search normalized flights for one controlled origin and destination.",
        parameters: { type: "object", additionalProperties: false, required: ["originId", "destinationId", "tripType", "departureDate", "adults", "cabin", "currency"], properties: {
          originId: { type: "string" }, destinationId: { type: "string" }, tripType: { type: "string", enum: ["ONE_WAY", "ROUND_TRIP"] },
          departureDate: { type: "string" }, returnDate: { type: "string" }, adults: { type: "integer" }, cabin: { type: "string" }, currency: { type: "string" },
        } },
      }],
      dispatchTool: async (call) => {
        if (call.name !== "flight.search") throw new Error("UNKNOWN_SKILL");
        const modelArgs = flightSearchModelArgumentsSchema.parse(call.arguments);
        const result = await invokeSkill("flight.search", {
          ctx: params.ctx, snapshot: {
            authorizedData: snapshot.authorizedData as Record<string, unknown>, departureCities: snapshot.departureCities as string[],
            destinationCandidates: snapshot.destinationCandidates as string[], travelDateStart: snapshot.travelDateStart ?? undefined, travelDateEnd: snapshot.travelDateEnd ?? undefined,
          },
          flightSearch: {
            tripId: params.tripId, snapshotId: params.snapshotId, searchPreferencesVersion: preferences.version,
            searchPreferences: { tripType: preferences.tripType as "ONE_WAY" | "ROUND_TRIP", adults: preferences.adults, cabin: preferences.cabin as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST", currency: preferences.currency },
            agentTaskRunId: params.agentTaskRunId,
          }, policyGate: new DefaultPolicyGate("shared"),
        }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
        if ((result as { outcome: string }).outcome === "LIVE") allFlights.push(...(result as { offers: FlightOffer[] }).offers);
        return result;
      },
    });
  } else {
    validateProviderCoverage({ requiredOrigins: snapshot.departureCities, flights: allFlights, stays: allStays, ground: allGround });
    candidatePlanData = await dependencies.modelGateway.generateStructuredPlan({ destination: params.destination, flights: allFlights, stays: allStays, ground: allGround, memberPreferences, ctx: params.ctx, signal: params.signal });
  }

  validateProviderCoverage({ requiredOrigins: snapshot.departureCities, flights: allFlights, stays: allStays, ground: allGround });

  // The model output is untrusted until the deterministic control plane proves
  // snapshot authorization and an exact match to run-scoped provider evidence.
  const planData = validatePlanOutput({
    planData: candidatePlanData,
    snapshot: {
      authorizedData: snapshot.authorizedData,
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart ?? undefined,
      travelDateEnd: snapshot.travelDateEnd ?? undefined,
    },
    evidence: { flights: allFlights, stays: allStays, ground: allGround },
  });

  // Only validated output may cross the authoritative persistence boundary.
  // All four writes (plan, offers, evidence, audit) commit atomically; if
  // any one fails the validated plan is discarded.
  const planId = await db.transaction(async (tx) => {
    if (params.agentTaskRunId) {
      if (!params.leaseToken || !params.flightSearchPreferencesVersion) throw new Error("Planning task lease authority is incomplete");
      const [currentTask] = await tx.select().from(agentTaskRuns).where(and(
        eq(agentTaskRuns.id, params.agentTaskRunId), eq(agentTaskRuns.leaseToken, params.leaseToken),
        eq(agentTaskRuns.status, "RUNNING"), eq(agentTaskRuns.snapshotId, params.snapshotId),
        gt(agentTaskRuns.leaseExpiresAt, new Date()),
      )).limit(1);
      const [latestPreference] = await tx.select().from(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, params.tripId)).orderBy(desc(tripSearchPreferences.version)).limit(1);
      if (!currentTask || latestPreference?.version !== params.flightSearchPreferencesVersion) {
        throw new Error("Planning task is stale or no longer owns finalization");
      }
      // This is the authoritative completion gate.  The earlier beforeFinal
      // check avoids an unnecessary final model response, but evidence can
      // change after that check; re-read it through this transaction before
      // any plan state is made durable.
      const matrix = await evaluateFlightResearchCompleteness({
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        departureCities: snapshot.departureCities as string[],
        destinationCandidates: snapshot.destinationCandidates as string[],
        client: tx,
      });
      if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);
    }
    const [plan] = await tx.insert(itineraryPlans).values({
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      version: nextVersion,
      status: "ACTIVE",
      planData,
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
      ...allGround.map(offer => ({
        category: "ground",
        providerName: offer.provider,
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

    if (params.agentTaskRunId) {
      const [completed] = await tx.update(agentTaskRuns).set({
        status: "COMPLETED", resultPlanId: plan.id, leaseToken: null, leaseExpiresAt: null,
        finishedAt: new Date(), updatedAt: new Date(), errorCode: null,
      }).where(and(
        eq(agentTaskRuns.id, params.agentTaskRunId), eq(agentTaskRuns.leaseToken, params.leaseToken!),
        eq(agentTaskRuns.status, "RUNNING"), gt(agentTaskRuns.leaseExpiresAt, new Date()),
      )).returning();
      if (!completed) throw new Error("Planning task lost finalization lease");
    }

    return plan.id;
  });

  return planId;
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
