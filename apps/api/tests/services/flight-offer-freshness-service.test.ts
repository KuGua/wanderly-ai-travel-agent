import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  auditEvents,
  constraintSnapshots,
  itineraryPlans,
  providerOffers,
  sharedTrips,
  users,
} from "../../src/db/schema.js";
import {
  FlightOfferStaleError,
  validateSelectedFlightOffersFresh,
} from "../../src/services/flight-offer-freshness-service.js";
import { createRequestContext } from "../../src/utils/context.js";
import { metrics } from "../../src/observability/metrics.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

/** Extracts the current sample value for one exact label combination from
 * the shared, cumulative metrics registry (the suite runs single-forked, so
 * other test files' increments persist across files — compare before/after
 * rather than asserting an absolute count). */
function counterValue(rendered: string, name: string, labelKey: string): number {
  const line = rendered.split("\n").find((l) => l === `${name}{${labelKey}} ` || l.startsWith(`${name}{${labelKey}} `));
  if (!line) return 0;
  const value = line.slice(line.lastIndexOf(" ") + 1);
  return Number(value);
}

describe("validateSelectedFlightOffersFresh", () => {
  let cleanup: postgres.Sql;
  let ownerId: string;
  let tripId: string;
  let snapshotId: string;
  let planId: string;

  beforeAll(async () => {
    await runMigrations(connectionString);
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterAll(async () => {
    await cleanup.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE
        audit_events, provider_offers, constraint_snapshots,
        itinerary_plans, shared_trips
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    ownerId = (await db.insert(users).values({
      externalId: `freshness-owner-${randomUUID()}`,
      displayName: "Freshness Owner",
    }).returning({ id: users.id }))![0].id;

    tripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: "Freshness Trip",
      nameSource: "AUTO",
      status: "PLANNING",
      createdBy: ownerId,
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
    });

    snapshotId = randomUUID();
    await db.insert(constraintSnapshots).values({
      id: snapshotId,
      tripId,
      version: 1,
      authorizedData: { _meta: { schemaVersion: 2 } },
      departureCities: ["SF"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-01",
      travelDateEnd: "2026-09-08",
    });

    planId = randomUUID();
    await db.insert(itineraryPlans).values({
      id: planId,
      tripId,
      snapshotId,
      version: 1,
      status: "PROPOSED",
      planData: {},
    });
  });

  async function insertFlightOffer(overrides: {
    providerName?: string;
    expiresAt?: Date | null;
    expiryProvenance?: "PROVIDER_VERIFIED" | "SYNTHETIC" | null;
    offerData?: Record<string, unknown>;
  } = {}): Promise<void> {
    await db.insert(providerOffers).values({
      snapshotId,
      planId,
      category: "flight",
      providerName: overrides.providerName ?? "amadeus",
      providerOfferId: "offer-1",
      currency: "USD",
      expiresAt: overrides.expiresAt ?? null,
      expiryProvenance: overrides.expiryProvenance === undefined ? "PROVIDER_VERIFIED" : overrides.expiryProvenance,
      offerData: overrides.offerData ?? { id: "amadeus:offer-1" },
    });
  }

  it("passes when the plan has no flight-category offers at all", async () => {
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).resolves.toBeUndefined();
  });

  it("passes an Amadeus offer with a real lastTicketingDate-derived (PROVIDER_VERIFIED) future expiry", async () => {
    await insertFlightOffer({
      providerName: "amadeus", expiryProvenance: "PROVIDER_VERIFIED",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).resolves.toBeUndefined();
  });

  it("rejects EXPIRED for a real (PROVIDER_VERIFIED) Amadeus expiry in the past, and records audit + metric", async () => {
    await insertFlightOffer({
      providerName: "amadeus", expiryProvenance: "PROVIDER_VERIFIED",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const before = metrics.render();

    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toMatchObject({ reason: "EXPIRED", statusCode: 409 });

    const [audit] = await db.select().from(auditEvents)
      .where(eq(auditEvents.action, "FLIGHT_OFFER_EXPIRED"));
    expect(audit?.planId).toBe(planId);
    expect(audit?.tripId).toBe(tripId);
    expect((audit?.summary as { reason?: string })?.reason).toBe("EXPIRED");

    const after = metrics.render();
    expect(counterValue(after, "flight_offer_staleness_total", 'reason="expired"'))
      .toBe(counterValue(before, "flight_offer_staleness_total", 'reason="expired"') + 1);
  });

  it("rejects MISSING_EXPIRY when a PROVIDER_VERIFIED offer's expires_at is somehow NULL", async () => {
    await insertFlightOffer({ providerName: "amadeus", expiryProvenance: "PROVIDER_VERIFIED", expiresAt: null });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toMatchObject({ reason: "MISSING_EXPIRY", statusCode: 422 });
  });

  it("rejects UNVERIFIABLE_EXPIRY for an Amadeus offer whose expiry is the SYNTHETIC fallback, even with a future timestamp (regression: previously inferred trust from provider name alone)", async () => {
    // This is the exact unsafe path the previous design allowed: Amadeus
    // falls back to capturedAt+15min when a specific offer lacks a real
    // lastTicketingDate. Provider name alone must never grant trust.
    await insertFlightOffer({
      providerName: "amadeus", expiryProvenance: "SYNTHETIC",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toMatchObject({ reason: "UNVERIFIABLE_EXPIRY", statusCode: 422 });
  });

  it("rejects UNVERIFIABLE_EXPIRY for a SerpAPI offer even with a future expires_at (spec §11)", async () => {
    // SerpAPI (Google Flights) has no fare-hold/ticketing-deadline concept;
    // its adapter always sets expiryProvenance: SYNTHETIC.
    await insertFlightOffer({
      providerName: "serpapi", expiryProvenance: "SYNTHETIC",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toMatchObject({ reason: "UNVERIFIABLE_EXPIRY" });
  });

  it("rejects UNVERIFIABLE_EXPIRY for a FlightAPI offer even with a future expires_at", async () => {
    await insertFlightOffer({
      providerName: "flightapi", expiryProvenance: "SYNTHETIC",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toMatchObject({ reason: "UNVERIFIABLE_EXPIRY" });
  });

  it("rejects UNVERIFIABLE_EXPIRY for a historical row with unknown (NULL) provenance, never upgrading it to trusted", async () => {
    // Rows persisted before the expiry_provenance column existed. Must fail
    // closed exactly like SYNTHETIC — never inferred as PROVIDER_VERIFIED
    // retroactively, even for a provider capable of real verification.
    await insertFlightOffer({
      providerName: "amadeus", expiryProvenance: null,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toMatchObject({ reason: "UNVERIFIABLE_EXPIRY" });
  });

  it("trusts only provider_offers.expires_at, never a value inside offer_data", async () => {
    // A client/model cannot override server authority by shaping offer_data;
    // only the authoritative column is consulted.
    await insertFlightOffer({
      providerName: "amadeus", expiryProvenance: "PROVIDER_VERIFIED",
      expiresAt: new Date(Date.now() - 60_000),
      offerData: { id: "amadeus:offer-1", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() },
    });
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).rejects.toBeInstanceOf(FlightOfferStaleError);
  });

  it("does not evaluate offers linked to a different plan", async () => {
    const otherPlanId = randomUUID();
    await db.insert(itineraryPlans).values({
      id: otherPlanId, tripId, snapshotId, version: 2, status: "PROPOSED", planData: {},
    });
    await db.insert(providerOffers).values({
      snapshotId, planId: otherPlanId, category: "flight", providerName: "amadeus",
      expiryProvenance: "PROVIDER_VERIFIED",
      expiresAt: new Date(Date.now() - 60_000), offerData: { id: "other" },
    });
    // The plan under test has no offers of its own — must pass regardless
    // of the other plan's expired offer.
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
    })).resolves.toBeUndefined();
  });

  it("honors an injected clock instead of wall time (deterministic, no sleeps)", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    await insertFlightOffer({ providerName: "amadeus", expiryProvenance: "PROVIDER_VERIFIED", expiresAt: future });
    // "Now" injected as one millisecond after the offer's expiry — must fail
    // even though real wall-clock time has not actually reached it.
    await expect(validateSelectedFlightOffersFresh({
      ctx: createRequestContext(ownerId), planId, tripId,
      now: new Date(future.getTime() + 1),
    })).rejects.toMatchObject({ reason: "EXPIRED" });
  });
});
