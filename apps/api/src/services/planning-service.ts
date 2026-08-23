import { db } from "../db/database.js";
import { constraintSnapshots, itineraryPlans, sourceEvidence, providerOffers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { buildAuthorizedData } from "./consent-service.js";
import { FixtureFlightProvider, FixtureStayProvider, FixtureGroundProvider } from "../providers/fixture-provider.js";
import { MockModelGateway } from "../providers/model-gateway.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import type { FlightOffer, StayOffer, GroundOffer } from "../types/domain.js";

const flightProvider = new FixtureFlightProvider();
const stayProvider = new FixtureStayProvider();
const groundProvider = new FixtureGroundProvider();
const modelGateway = new MockModelGateway();

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
}): Promise<string> {
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
    const flights = await flightProvider.searchFlights({
      origin: departureCity,
      destination: params.destination,
      dateStart: snapshot.travelDateStart ?? "2025-08-01",
      dateEnd: snapshot.travelDateEnd ?? "2025-08-31",
      snapshotId: params.snapshotId,
    });
    allFlights.push(...flights);
  }

  const stays = await stayProvider.searchStays({
    destination: params.destination,
    checkIn: snapshot.travelDateStart ?? "2025-08-02",
    checkOut: snapshot.travelDateEnd ?? "2025-08-07",
    snapshotId: params.snapshotId,
  });
  allStays.push(...stays);

  const ground = await groundProvider.searchGround({
    destination: params.destination,
    snapshotId: params.snapshotId,
  });
  allGround.push(...ground);

  // Record provider offers
  for (const flight of allFlights) {
    await db.insert(providerOffers).values({
      snapshotId: params.snapshotId,
      category: "flight",
      providerName: flight.airline,
      offerData: flight as unknown as Record<string, unknown>,
      isDemo: flight.isDemo,
    });
  }

  // Generate structured plan via model gateway
  const memberPreferences = snapshot.authorizedData;
  const planData = await modelGateway.generateStructuredPlan({
    destination: params.destination,
    flights: allFlights,
    stays: allStays,
    ground: allGround,
    memberPreferences,
  });

  // Insert plan
  const [plan] = await db.insert(itineraryPlans).values({
    tripId: params.tripId,
    snapshotId: params.snapshotId,
    version: nextVersion,
    status: "ACTIVE",
    planData,
  }).returning();

  // Record source evidence
  for (const flight of allFlights) {
    await db.insert(sourceEvidence).values({
      planId: plan.id,
      category: "flight",
      itemId: flight.id,
      source: flight.source,
      capturedAt: new Date(flight.capturedAt),
    });
  }

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
    .orderBy(itineraryPlans.version)
    .limit(1);

  if (plans.length === 0) return null;
  return { id: plans[0].id, version: plans[0].version, planData: plans[0].planData as Record<string, unknown> };
}
