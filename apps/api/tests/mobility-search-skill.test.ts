import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { __resetRegistryForTests, invokeSkill, registerSkill } from "../src/agents/skill-registry.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createMobilitySearchSkill } from "../src/skills/shared/mobility-search-skill.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  constraintSnapshots,
  providerOffers,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import { createRequestContext } from "../src/utils/context.js";
import type { MobilityOfferProvider, NormalizedMobilityOffer, ProviderResult } from "../src/providers/types.js";

const SNAPSHOT_DATA = {
  authorizedData: {},
  departureCities: ["Shanghai"],
  destinationCandidates: ["tokyo"],
};

const ORIGIN_ID = "11111111-1111-4111-8111-111111111111";
const DEST_ID = "22222222-2222-4222-8222-222222222222";

function liveProvider(): MobilityOfferProvider {
  return {
    async searchOffers(): Promise<ProviderResult<NormalizedMobilityOffer[]>> {
      return {
        outcome: "LIVE",
        data: [{
          offerId: "offer-1",
          serviceType: "TAXI",
          originPlaceId: ORIGIN_ID,
          destinationPlaceId: DEST_ID,
          passengers: 2,
          departureAt: "2026-09-01T10:00:00.000Z",
          estimatedPrice: 45.5,
          currency: "USD",
          vehicleClass: "Sedan",
          estimated: true,
          expiresAt: "2026-09-01T11:00:00.000Z",
          source: "Amadeus Transfer Search",
          capturedAt: "2026-08-28T00:00:00.000Z",
        }],
        source: "Amadeus Transfer Search",
        capturedAt: "2026-08-28T00:00:00.000Z",
      };
    },
  };
}

function unavailableProvider(): MobilityOfferProvider {
  return {
    async searchOffers(): Promise<ProviderResult<NormalizedMobilityOffer[]>> {
      return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
    },
  };
}

describe("mobility.search Shared Skill", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;

  beforeEach(async () => {
    __resetRegistryForTests();
    const [user] = await db.insert(users).values({ externalId: `mobility-skill-${randomUUID()}`, displayName: "Mobility skill test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({ name: "Mobility skill trip", createdBy: userId, ...SNAPSHOT_DATA }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({ tripId, version: 1, ...SNAPSHOT_DATA }).returning();
    snapshotId = snapshot.id;
    registerSkill(createMobilitySearchSkill(liveProvider()));
  });

  afterEach(async () => {
    await db.delete(auditEvents).where(or(eq(auditEvents.tripId, tripId), eq(auditEvents.actorUserId, userId)));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  function context(agent: "shared" | "personal" | "review" = "shared") {
    return {
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      snapshot: SNAPSHOT_DATA,
      mobility: { tripId, snapshotId },
      policyGate: new DefaultPolicyGate(agent),
    };
  }

  function request(overrides: Record<string, unknown> = {}) {
    return {
      snapshotId,
      originPlaceId: ORIGIN_ID,
      destinationPlaceId: DEST_ID,
      passengers: 2,
      departureAt: "2026-09-01T10:00:00.000Z",
      serviceType: "TAXI" as const,
      ...overrides,
    };
  }

  it("returns LIVE offers and persists provider_search_runs + provider_offers WITHOUT bookingUrl", async () => {
    const output = await invokeSkill("mobility.search", context(), request());
    expect(output).toMatchObject({
      outcome: "LIVE",
      offers: [expect.objectContaining({
        offerId: "offer-1",
        currency: "USD",
        estimated: true,
        estimatedPrice: 45.5,
        // Critical: the schema must not have a bookingUrl field at all.
      })],
    });
    if (output.outcome === "LIVE") {
      expect("bookingUrl" in output.offers[0]).toBe(false);
    }
    const runs = await db.select().from(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    expect(runs).toHaveLength(1);
    expect(runs[0].category).toBe("mobility");
    const offers = await db.select().from(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    expect(offers).toHaveLength(1);
    expect(offers[0].category).toBe("mobility");
    expect((offers[0].offerData as Record<string, unknown>)).not.toHaveProperty("bookingUrl");
  });

  it("denies personal and review agents", async () => {
    await expect(invokeSkill("mobility.search", context("personal"), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
    await expect(invokeSkill("mobility.search", context("review"), request())).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
  });

  it("rejects mismatched snapshotId", async () => {
    await expect(invokeSkill("mobility.search", context(), request({ snapshotId: randomUUID() })))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("rejects origin equal to destination", async () => {
    await expect(invokeSkill("mobility.search", context(), { ...request(), destinationPlaceId: ORIGIN_ID }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects unknown service types", async () => {
    await expect(invokeSkill("mobility.search", context(), { ...request(), serviceType: "BUS" }))
      .rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("returns UNAVAILABLE without writing provider_offers", async () => {
    __resetRegistryForTests();
    registerSkill(createMobilitySearchSkill(unavailableProvider()));
    const output = await invokeSkill("mobility.search", context(), request());
    expect(output).toMatchObject({ outcome: "UNAVAILABLE", code: "NOT_CONFIGURED" });
    const offers = await db.select().from(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    expect(offers).toHaveLength(0);
  });
});