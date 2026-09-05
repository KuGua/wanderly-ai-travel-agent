import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { agentTaskRuns, constraintSnapshots, itineraryPlans, sharedTrips, tripMembers, users } from "../src/db/schema.js";
import { loadSharedPlanningState } from "../src/services/shared-planning-state-service.js";

/**
 * The predicate behind "can another planning run be offered right now".
 *
 * It lives on the server because it used to live in two places — the web CTA
 * and the conversation prompt — and they answered differently the moment a
 * trip left DRAFT: the button disappeared, the prompt's authoritative handoff
 * block went empty, and the assistant spent the rest of the thread telling the
 * traveller to press a button that was no longer there.
 */
describe("shared planning state", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;

  beforeEach(async () => {
    const [user] = await db.insert(users)
      .values({ externalId: `sps-${randomUUID()}`, displayName: "Shared planning state" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Shanghai", createdBy: userId, status: "PLANNING",
      departureCities: ["Singapore"], destinationCandidates: ["Shanghai"],
      travelDateStart: "2026-12-04", travelDateEnd: "2026-12-08",
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 1, authorizedData: {},
      departureCities: ["Singapore"], destinationCandidates: ["Shanghai"],
    }).returning();
    snapshotId = snapshot.id;
  });

  afterEach(async () => {
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  async function insertRun(status: "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED_WITH_GAPS") {
    await db.insert(agentTaskRuns).values({
      id: randomUUID(), operation: "RESEARCH", status, createdByUserId: userId, tripId,
      snapshotId, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
      ...(status === "FAILED" || status === "COMPLETED_WITH_GAPS" ? { finishedAt: new Date() } : {}),
    });
  }

  it("reports NOT_STARTED for a Draft brief regardless of what else exists", async () => {
    await insertRun("RUNNING");
    expect(await loadSharedPlanningState({ tripId, tripStatus: "DRAFT" })).toBe("NOT_STARTED");
  });

  it("reports NO_PLAN_YET after a run failed — the state that had no way out", async () => {
    await insertRun("FAILED");
    expect(await loadSharedPlanningState({ tripId, tripStatus: "PLANNING" })).toBe("NO_PLAN_YET");
  });

  it("reports NO_PLAN_YET when a run completed with gaps and no itinerary", async () => {
    await insertRun("COMPLETED_WITH_GAPS");
    expect(await loadSharedPlanningState({ tripId, tripStatus: "PLANNING" })).toBe("NO_PLAN_YET");
  });

  it("reports IN_PROGRESS while a run is queued or running", async () => {
    await insertRun("QUEUED");
    expect(await loadSharedPlanningState({ tripId, tripStatus: "PLANNING" })).toBe("IN_PROGRESS");
  });

  it("reports PLAN_AVAILABLE once a proposed plan exists", async () => {
    await insertRun("COMPLETED_WITH_GAPS");
    await db.insert(itineraryPlans).values({
      tripId, snapshotId, version: 1, status: "PROPOSED", planData: {},
    });
    expect(await loadSharedPlanningState({ tripId, tripStatus: "PLANNING" })).toBe("PLAN_AVAILABLE");
  });

  it("treats a stale plan as history, not as something to show", async () => {
    await db.insert(itineraryPlans).values({
      tripId, snapshotId, version: 1, status: "STALE", planData: {},
    });
    expect(await loadSharedPlanningState({ tripId, tripStatus: "PLANNING" })).toBe("NO_PLAN_YET");
  });

  it("prefers IN_PROGRESS over an existing plan — a replan is already running", async () => {
    await db.insert(itineraryPlans).values({
      tripId, snapshotId, version: 1, status: "ACTIVE", planData: {},
    });
    await insertRun("RUNNING");
    expect(await loadSharedPlanningState({ tripId, tripStatus: "PLANNING" })).toBe("IN_PROGRESS");
  });
});
