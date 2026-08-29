import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/database.js";
import { agentTaskRuns, constraintSnapshots, providerSearchRuns, sharedTrips, tripMembers, users } from "../src/db/schema.js";
import { evaluateNavigationResearchCompleteness } from "../src/services/navigation-research-matrix-service.js";

describe("navigation-research-matrix-service", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let taskId: string;

  beforeEach(async () => {
    const [user] = await db.insert(users).values({ externalId: `nav-matrix-${randomUUID()}`, displayName: "Nav matrix" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Nav matrix trip", createdBy: userId, authorizedData: {},
      departureCities: ["Shanghai"], destinationCandidates: ["tokyo"],
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 1, authorizedData: {}, departureCities: ["Shanghai"], destinationCandidates: ["tokyo"],
    }).returning();
    snapshotId = snapshot.id;
    taskId = randomUUID();
    await db.insert(agentTaskRuns).values({
      id: taskId, operation: "PLAN", status: "RUNNING", createdByUserId: userId, tripId,
      snapshotId, flightSearchPreferencesVersion: 1, requestId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000), leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterEach(async () => {
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  async function record(placeA: string, placeB: string, mode: "WALK" | "DRIVE" | "CYCLE", outcome: "LIVE" | "UNAVAILABLE") {
    await db.insert(providerSearchRuns).values({
      snapshotId, agentTaskRunId: taskId, category: "navigation",
      providerName: "openrouteservice", originId: placeA, destinationId: placeB,
      requestFingerprint: randomUUID().replaceAll("-", ""), outcome,
      errorCode: outcome === "UNAVAILABLE" ? "NO_RESULTS" : null,
    });
  }

  it("returns complete=false when cells are MISSING", async () => {
    const result = await evaluateNavigationResearchCompleteness({
      snapshotId, agentTaskRunId: taskId,
      originPlaceIds: ["a"], destinationPlaceIds: ["b"],
    });
    expect(result.complete).toBe(false);
    expect(result.cells).toHaveLength(3); // 1 origin × 1 dest × 3 modes
    expect(result.cells.every((cell) => cell.outcome === "MISSING")).toBe(true);
  });

  it("returns complete=true when every cell has an attempted run (Phase 4 outcome matrix)", async () => {
    await record("a", "b", "WALK", "UNAVAILABLE");
    await record("a", "b", "DRIVE", "UNAVAILABLE");
    await record("a", "b", "CYCLE", "UNAVAILABLE");
    const result = await evaluateNavigationResearchCompleteness({
      snapshotId, agentTaskRunId: taskId,
      originPlaceIds: ["a"], destinationPlaceIds: ["b"],
    });
    expect(result.complete).toBe(true);
    expect(result.cells.every((cell) => cell.outcome === "UNAVAILABLE")).toBe(true);
  });

  it("scopes evidence to the given snapshot and run", async () => {
    await record("a", "b", "WALK", "LIVE");
    // Different snapshot — should be ignored.
    const [otherSnapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 2, authorizedData: {}, departureCities: ["Shanghai"], destinationCandidates: ["tokyo"],
    }).returning();
    await db.insert(providerSearchRuns).values({
      snapshotId: otherSnapshot.id, agentTaskRunId: taskId, category: "navigation",
      providerName: "openrouteservice", originId: "a", destinationId: "b",
      requestFingerprint: randomUUID().replaceAll("-", ""), outcome: "LIVE", errorCode: null,
    });
    const result = await evaluateNavigationResearchCompleteness({
      snapshotId, agentTaskRunId: taskId,
      originPlaceIds: ["a"], destinationPlaceIds: ["b"], modes: ["WALK"],
    });
    expect(result.complete).toBe(true);
    expect(result.cells[0].outcome).toBe("LIVE");
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, otherSnapshot.id));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, otherSnapshot.id));
  });
});