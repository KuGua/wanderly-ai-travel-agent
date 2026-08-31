import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/database.js";
import { agentTaskRuns, auditEvents, constraintSnapshots, itineraryPlans, providerOffers, providerSearchRuns, sharedTrips, tripMembers, tripSearchPreferences, users } from "../src/db/schema.js";
import { evaluateFlightResearchCompleteness, FlightResearchIncompleteError } from "../src/services/flight-research-matrix-service.js";
import { acceptPlanningTask, getLatestAuthorizedPlanningRun } from "../src/tasks/task-repository.js";
import { createRequestContext } from "../src/utils/context.js";
import { generatePlan, type PlanningDependencies } from "../src/services/planning-service.js";
import { __resetRegistryForTests, registerSkill } from "../src/agents/skill-registry.js";
import { createFlightSearchSkill } from "../src/skills/shared/flight-search-skill.js";
import { saveConfirmedSearchPreferences } from "../src/services/flight-search-preferences-service.js";
import { testPlanningDependencies } from "./helpers/planning.js";

describe("flight research matrix", () => {
  let userId: string; let tripId: string; let snapshotId: string; let taskId: string; let otherTaskId: string; let planningSnapshotId: string | null;
  beforeEach(async () => {
    const [user] = await db.insert(users).values({ externalId: `matrix-${randomUUID()}`, displayName: "Matrix" }).returning(); userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({ name: "Matrix", createdBy: userId, authorizedData: {}, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT", "CDG"] }).returning(); tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({ tripId, version: 1, authorizedData: {}, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT", "CDG"] }).returning(); snapshotId = snapshot.id;
    planningSnapshotId = null; taskId = randomUUID();
    await db.insert(agentTaskRuns).values({ id: taskId, operation: "PLAN", status: "QUEUED", createdByUserId: userId, tripId, snapshotId, flightSearchPreferencesVersion: 1, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    otherTaskId = randomUUID();
    await db.insert(agentTaskRuns).values({ id: otherTaskId, operation: "REPLAN", status: "COMPLETED", createdByUserId: userId, tripId, snapshotId, flightSearchPreferencesVersion: 1, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60_000), finishedAt: new Date() });
  });
  afterEach(async () => { __resetRegistryForTests(); if (planningSnapshotId) { await db.delete(providerOffers).where(eq(providerOffers.snapshotId, planningSnapshotId)); await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, planningSnapshotId)); await db.delete(agentTaskRuns).where(eq(agentTaskRuns.snapshotId, planningSnapshotId)); await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, planningSnapshotId)); } await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId)); await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId)); await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId)); await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, taskId)); await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, otherTaskId)); await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId)); await db.delete(auditEvents).where(eq(auditEvents.actorUserId, userId)); await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId)); await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId)); await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId)); await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId)); await db.delete(users).where(eq(users.id, userId)); });
  async function evidence(originId: string, destinationId: string, outcome: "LIVE" | "UNAVAILABLE" = "LIVE", runId = taskId, sid = snapshotId) {
    await db.insert(providerSearchRuns).values({ snapshotId: sid, agentTaskRunId: runId, category: "flight", providerName: "amadeus", requestFingerprint: randomUUID().replaceAll("-", ""), outcome, errorCode: outcome === "UNAVAILABLE" ? "NO_RESULTS" : null, originId, destinationId });
  }
  it("requires exactly departureCities × destinationCandidates and scopes LIVE evidence to task/snapshot", async () => {
    await evidence("SFO", "NRT"); await evidence("SIN", "NRT"); await evidence("SFO", "CDG"); await evidence("SIN", "CDG", "LIVE", otherTaskId);
    const result = await evaluateFlightResearchCompleteness({ snapshotId, agentTaskRunId: taskId, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT", "CDG"] });
    expect(result.cells).toHaveLength(4);
    expect(result.complete).toBe(false);
    expect(result.cells.find((cell) => cell.originId === "SIN" && cell.destinationId === "CDG")?.outcome).toBe("MISSING");
  });
  it("treats persisted UNAVAILABLE as incomplete and complete LIVE coverage as complete", async () => {
    for (const origin of ["SFO", "SIN"]) for (const destination of ["NRT", "CDG"]) await evidence(origin, destination);
    expect((await evaluateFlightResearchCompleteness({ snapshotId, agentTaskRunId: taskId, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT", "CDG"] })).complete).toBe(true);
    await evidence("SFO", "NRT", "UNAVAILABLE", taskId, snapshotId);
    // A prior valid LIVE result remains evidence; UNAVAILABLE cannot create a
    // missing cell but also cannot displace an already persisted LIVE result.
    expect((await evaluateFlightResearchCompleteness({ snapshotId, agentTaskRunId: taskId, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT", "CDG"] })).complete).toBe(true);
  });

  it("does not treat UNAVAILABLE-only or wrong-snapshot evidence as coverage", async () => {
    await evidence("SFO", "NRT", "UNAVAILABLE");
    const unavailable = await evaluateFlightResearchCompleteness({
      snapshotId, agentTaskRunId: taskId, departureCities: ["SFO"], destinationCandidates: ["NRT"],
    });
    expect(unavailable).toMatchObject({ complete: false, cells: [{ originId: "SFO", destinationId: "NRT", outcome: "UNAVAILABLE" }] });

    const [otherSnapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 2, authorizedData: {}, departureCities: ["SFO"], destinationCandidates: ["NRT"],
    }).returning();
    await evidence("SFO", "NRT", "LIVE", taskId, otherSnapshot.id);
    const wrongSnapshot = await evaluateFlightResearchCompleteness({
      snapshotId, agentTaskRunId: taskId, departureCities: ["SFO"], destinationCandidates: ["NRT"],
    });
    expect(wrongSnapshot.complete).toBe(false);
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, otherSnapshot.id));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, otherSnapshot.id));
  });

  it("supersedes an active planning run for a newer REPLAN", async () => {
    const accepted = await acceptPlanningTask({
      ctx: createRequestContext(userId), tripId, userId, snapshotId,
      flightSearchPreferencesVersion: 1, operation: "REPLAN", requestId: randomUUID(),
    });
    const [oldRun] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, taskId));
    const [newRun] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, accepted.runId));
    expect(oldRun.status).toBe("CANCELLED");
    expect(newRun).toMatchObject({ operation: "REPLAN", status: "QUEUED", snapshotId });
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, accepted.runId));
  });

  it("recovers the latest Shared planning run from server state for a current member", async () => {
    const recovered = await getLatestAuthorizedPlanningRun(tripId, userId);
    expect(recovered).toMatchObject({ runId: otherTaskId, operation: "REPLAN", status: "COMPLETED" });
  });

  it("re-checks research in the final transaction when evidence changes after beforeFinal", async () => {
    const [planningSnapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 2, authorizedData: {}, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT"],
      travelDateStart: "2026-10-10", travelDateEnd: "2026-10-17",
    }).returning();
    planningSnapshotId = planningSnapshot.id;
    const preference = await saveConfirmedSearchPreferences({
      ctx: createRequestContext(userId), tripId, confirmedBy: userId,
      input: { tripType: "ROUND_TRIP", adults: 1, cabin: "ECONOMY", currency: "USD", offerFreshnessMinutes: 30 },
    });
    await db.update(agentTaskRuns).set({ status: "CANCELLED", finishedAt: new Date() }).where(eq(agentTaskRuns.id, taskId));
    const durableTaskId = randomUUID();
    const leaseToken = randomUUID();
    await db.insert(agentTaskRuns).values({
      id: durableTaskId, operation: "PLAN", status: "RUNNING", createdByUserId: userId, tripId,
      snapshotId: planningSnapshot.id, flightSearchPreferencesVersion: preference.version, requestId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000), leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date(),
    });
    __resetRegistryForTests();
    registerSkill(createFlightSearchSkill({
      async searchFlights(input) {
        const capturedAt = "2026-08-25T00:00:00.000Z";
        return { outcome: "LIVE" as const, source: "TOCTOU test provider", capturedAt, data: [{
          id: `toctou-${input.origin}-${input.destination}`, providerOfferId: `toctou-${input.origin}-${input.destination}`,
          providerName: "toctou-test-provider", queryId: randomUUID(), origin: input.origin, destination: input.destination,
          segments: [{ carrierCode: "TT", flightNumber: "1", origin: input.origin, destination: input.destination, departureAt: `${input.dateStart}T08:00:00.000Z`, arrivalAt: `${input.dateStart}T18:00:00.000Z`, duration: "PT10H" }],
          totalDuration: "PT10H", totalPrice: 500, currency: input.currency!, cabin: input.cabin!, adults: input.adults!,
          baggageSummary: null, changeSummary: null, source: "TOCTOU test provider", capturedAt, expiresAt: "2026-12-31T00:00:00.000Z",
          expiryProvenance: "PROVIDER_VERIFIED" as const,
        }] };
      },
    }));
    let beforeFinalPassed = false;
    let matrixCompleteBeforeFinal = false;
    const dependencies: PlanningDependencies = {
      ...testPlanningDependencies,
      modelGateway: {
        ...testPlanningDependencies.modelGateway,
        async generateStructuredPlanWithTools(params) {
          const flights = [];
          for (const originId of ["SFO", "SIN"]) {
            const result = await params.dispatchTool({ id: randomUUID(), name: "flight.search", arguments: {
              originId, destinationId: "NRT",
            } });
            if ((result as { outcome: string }).outcome === "LIVE") flights.push(...(result as { offers: never[] }).offers);
          }
          matrixCompleteBeforeFinal = (await evaluateFlightResearchCompleteness({ snapshotId: planningSnapshot.id, agentTaskRunId: durableTaskId, departureCities: ["SFO", "SIN"], destinationCandidates: ["NRT"] })).complete;
          await params.beforeFinal?.();
          beforeFinalPassed = true;
          await db.update(providerSearchRuns).set({ outcome: "UNAVAILABLE", errorCode: "UPSTREAM_FAILURE" }).where(and(eq(providerSearchRuns.snapshotId, planningSnapshot.id), eq(providerSearchRuns.agentTaskRunId, durableTaskId), eq(providerSearchRuns.originId, "SFO"), eq(providerSearchRuns.destinationId, "NRT")));
          return { destination: "NRT", destinationCandidatesEvaluated: ["NRT"], flights, stays: params.stays, generatedAt: "2026-08-25T00:00:00.000Z" };
        },
      },
    };

    await expect(generatePlan({ ctx: createRequestContext(userId), tripId, snapshotId: planningSnapshot.id, destination: "NRT", memberIds: [], agentTaskRunId: durableTaskId, flightSearchPreferencesVersion: preference.version, leaseToken }, dependencies)).rejects.toBeInstanceOf(FlightResearchIncompleteError);
    expect(matrixCompleteBeforeFinal).toBe(true);
    expect(beforeFinalPassed).toBe(true);
    expect((await db.select().from(itineraryPlans).where(eq(itineraryPlans.snapshotId, planningSnapshot.id))).length).toBe(0);
    const [task] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, durableTaskId));
    expect(task.status).toBe("RUNNING");
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, durableTaskId));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, planningSnapshot.id));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, planningSnapshot.id));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, planningSnapshot.id));
    planningSnapshotId = null;
  });
});
