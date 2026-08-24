import { db } from "../db/database.js";
import { constraintSnapshots, itineraryPlans, sourceEvidence, providerOffers } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { buildAuthorizedData } from "./consent-service.js";
import { FixtureFlightProvider, FixtureStayProvider, FixtureGroundProvider } from "../providers/fixture-provider.js";
import { createModelGateway, __setModelGatewayForTests } from "../providers/gateway-factory.js";
import type { ModelGateway } from "../providers/model-gateway.js";
import type { FlightProvider, GroundProvider, StayProvider } from "../providers/types.js";
import { validatePlanOutput } from "../policy/plan-output-validator.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import type { FlightOffer, StayOffer, GroundOffer } from "../types/domain.js";

export interface PlanningDependencies {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  groundProvider: GroundProvider;
  modelGateway: ModelGateway;
}

const defaultPlanningDependencies: PlanningDependencies = {
  flightProvider: new FixtureFlightProvider(),
  stayProvider: new FixtureStayProvider(),
  groundProvider: new FixtureGroundProvider(),
  modelGateway: createModelGateway(),
};

export function __setModelGateway(gateway: ModelGateway): void {
  defaultPlanningDependencies.modelGateway = gateway;
  __setModelGatewayForTests(gateway);
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
 * Deterministic completeness gate for the fixture-backed planning slice.
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
}, dependencies: PlanningDependencies = defaultPlanningDependencies): Promise<string> {
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

  for (const departureCity of snapshot.departureCities) {
    const result = await dependencies.flightProvider.searchFlights({
      origin: departureCity,
      destination: params.destination,
      dateStart: snapshot.travelDateStart ?? "2025-08-01",
      dateEnd: snapshot.travelDateEnd ?? "2025-08-31",
      snapshotId: params.snapshotId,
    });
    if (result.outcome !== "UNAVAILABLE") {
      allFlights.push(...result.data);
    }
  }

  const stayResult = await dependencies.stayProvider.searchStays({
    destination: params.destination,
    checkIn: snapshot.travelDateStart ?? "2025-08-02",
    checkOut: snapshot.travelDateEnd ?? "2025-08-07",
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

  validateProviderCoverage({
    requiredOrigins: snapshot.departureCities,
    flights: allFlights,
    stays: allStays,
    ground: allGround,
  });

  // Generate structured plan via model gateway
  const memberPreferences = snapshot.authorizedData;
  const candidatePlanData = await dependencies.modelGateway.generateStructuredPlan({
    destination: params.destination,
    flights: allFlights,
    stays: allStays,
    ground: allGround,
    memberPreferences,
    ctx: params.ctx,
  });

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
  const [plan] = await db.insert(itineraryPlans).values({
    tripId: params.tripId,
    snapshotId: params.snapshotId,
    version: nextVersion,
    status: "ACTIVE",
    planData,
  }).returning();

  const normalizedOffers = [
    ...allFlights.map(offer => ({
      category: "flight",
      providerName: offer.airline,
      offer,
    })),
    ...allStays.map(offer => ({
      category: "stay",
      providerName: "FixtureStayProvider",
      offer,
    })),
    ...allGround.map(offer => ({
      category: "ground",
      providerName: offer.provider,
      offer,
    })),
  ];

  await db.insert(providerOffers).values(normalizedOffers.map(({ category, providerName, offer }) => ({
    snapshotId: params.snapshotId,
    planId: plan.id,
    category,
    providerName,
    offerData: offer as unknown as Record<string, unknown>,
    isDemo: offer.isDemo,
    capturedAt: new Date(offer.capturedAt),
  })));

  await db.insert(sourceEvidence).values(normalizedOffers.map(({ category, offer }) => ({
    planId: plan.id,
    category,
    itemId: offer.id,
    source: offer.source,
    capturedAt: new Date(offer.capturedAt),
    metadata: {
      isDemo: offer.isDemo,
      fixtureVersion: offer.fixtureVersion,
    },
  })));

  await recordAudit({
    ctx: params.ctx,
    action: "PLAN_CREATE",
    tripId: params.tripId,
    planId: plan.id,
    summary: { version: nextVersion, destination: params.destination, snapshotId: params.snapshotId },
  });

  return plan.id;
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
