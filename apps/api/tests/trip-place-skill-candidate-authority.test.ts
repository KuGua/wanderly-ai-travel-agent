import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { sharedTrips, tripPlaces, users } from "../src/db/schema.js";
import { tripPlaceSkill } from "../src/skills/shared/trip-place-skill.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createRequestContext } from "../src/utils/context.js";
import { SkillError } from "../src/agents/errors.js";
import type { PlaceCandidate } from "../src/types/domain.js";

/**
 * `places.propose` used to take the candidate's own fields — display name,
 * coordinates, source, capturedAt — from its caller, and on the planning path
 * the caller is the model. Nothing checked that those values had ever come
 * from a provider, so a model could name a place that does not exist and have
 * its invented coordinates and `source` persisted as trip evidence, with a
 * `capturedAt` it made up. `AGENTS.md` requires every output to carry a real
 * source and capture time; this is where that is now enforced.
 */
const CANDIDATE: PlaceCandidate = {
  candidateId: randomUUID(),
  displayName: "Senso-ji",
  kind: "ATTRACTION",
  countryCode: "JP",
  cityName: "Tokyo",
  longitude: 139.79,
  latitude: 35.71,
  confidence: 0.9,
  needsUserConfirmation: false,
  source: "ORS Geocoding",
  capturedAt: new Date().toISOString(),
};

async function seedTrip(): Promise<{ tripId: string; userId: string }> {
  const [user] = await db.insert(users).values({
    externalId: `place-authority-${randomUUID()}`,
    displayName: "Place authority owner",
  }).returning();
  const [trip] = await db.insert(sharedTrips).values({
    name: "Place authority trip",
    createdBy: user.id,
    authorizedData: {},
    departureCities: ["Shanghai"],
    destinationCandidates: ["tokyo"],
  }).returning();
  return { tripId: trip.id, userId: user.id };
}

function contextFor(tripId: string, userId: string, store: Map<string, PlaceCandidate>) {
  return {
    ctx: createRequestContext(userId, randomUUID()),
    snapshot: { authorizedData: {}, departureCities: ["Shanghai"], destinationCandidates: ["tokyo"] },
    placeSearch: {
      tripId,
      snapshotId: randomUUID(),
      resolveCandidate: (candidateId: string) => store.get(candidateId),
    },
    policyGate: new DefaultPolicyGate("shared"),
  };
}

describe("places.propose candidate authority", () => {
  it("persists the provider's own record, not the caller's account of it", async () => {
    const { tripId, userId } = await seedTrip();
    const store = new Map<string, PlaceCandidate>([[CANDIDATE.candidateId, CANDIDATE]]);

    const result = await tripPlaceSkill.handler(
      contextFor(tripId, userId, store),
      { action: "propose", candidateId: CANDIDATE.candidateId, visibility: "TEAM_VISIBLE", kind: "ATTRACTION" },
    );

    expect(result).toMatchObject({ outcome: "ACCEPTED" });
    const [row] = await db.select().from(tripPlaces).where(eq(tripPlaces.tripId, tripId));
    expect(row.displayName).toBe(CANDIDATE.displayName);
    expect(row.source).toBe(CANDIDATE.source);
    expect(Number(row.longitude)).toBeCloseTo(CANDIDATE.longitude, 5);
  });

  it("refuses a candidateId this run never issued, and writes nothing", async () => {
    const { tripId, userId } = await seedTrip();
    const store = new Map<string, PlaceCandidate>();

    await expect(tripPlaceSkill.handler(
      contextFor(tripId, userId, store),
      { action: "propose", candidateId: randomUUID(), visibility: "TEAM_VISIBLE", kind: "ATTRACTION" },
    )).rejects.toThrow(SkillError);

    expect(await db.select().from(tripPlaces).where(eq(tripPlaces.tripId, tripId))).toHaveLength(0);
  });

  it("refuses the invented id as our own input problem, not a provider outage", async () => {
    const { tripId, userId } = await seedTrip();
    const error = await tripPlaceSkill.handler(
      contextFor(tripId, userId, new Map()),
      { action: "propose", candidateId: randomUUID(), visibility: "TEAM_VISIBLE", kind: "ATTRACTION" },
    ).catch((caught: unknown) => caught);

    // The gap the traveller reads is derived from this code. `UPSTREAM_FAILURE`
    // here would blame a supplier that was never called.
    expect((error as SkillError).code).toBe("INPUT_INVALID");
  });
});
