import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  itineraryPlans,
  planningResearchResults,
  providerOffers,
  providerSearchRuns,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  users,
} from "../src/db/schema.js";
import { generatePlan, type PlanningDependencies } from "../src/services/planning-service.js";
import { FlightResearchIncompleteError } from "../src/services/flight-research-matrix-service.js";
import { saveConfirmedSearchPreferences } from "../src/services/flight-search-preferences-service.js";
import { __resetRegistryForTests, registerSkill } from "../src/agents/skill-registry.js";
import { createFlightSearchSkill } from "../src/skills/shared/flight-search-skill.js";
import { createRequestContext } from "../src/utils/context.js";
import { ModelGatewayError } from "../src/providers/llm-gateway.js";
import { PlanValidationError } from "../src/policy/plan-output-validator.js";
import { testPlanningDependencies } from "./helpers/planning.js";

/**
 * A round that did real work must report it.
 *
 * `researchSummaryReasonFor` used to recognise only an exhausted turn budget
 * and a genuinely evidence-free destination. Everything else — a final output
 * the plan contract rejected, a research matrix left with a `MISSING` cell —
 * failed the whole run, so evidence already sitting in `provider_offers` was
 * reported to the traveller as nothing at all. Those two are the same shape as
 * the budget case: the work is durable and only the model's plan is missing.
 *
 * `NO_CITABLE_EVIDENCE` stays a refusal and is covered in
 * `tests/flight-research-matrix.test.ts`; a card citing no verifiable fact is
 * the "Demo data" shape `AGENTS.md` forbids.
 */
describe("planning run outcome", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let taskId: string;
  let leaseToken: string;
  let preferenceVersion: number;

  beforeEach(async () => {
    const [user] = await db.insert(users).values({
      externalId: `run-outcome-${randomUUID()}`, displayName: "Run outcome",
    }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Run outcome", createdBy: userId, authorizedData: {},
      departureCities: ["SFO"], destinationCandidates: ["NRT"],
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId, role: "CREATOR", isRequired: true });
    const [snapshot] = await db.insert(constraintSnapshots).values({
      tripId, version: 1, authorizedData: {}, departureCities: ["SFO"], destinationCandidates: ["NRT"],
      travelDateStart: "2026-10-10", travelDateEnd: "2026-10-17",
    }).returning();
    snapshotId = snapshot.id;
    const preference = await saveConfirmedSearchPreferences({
      ctx: createRequestContext(userId), tripId, confirmedBy: userId,
      input: { tripType: "ROUND_TRIP", adults: 1, cabin: "ECONOMY", currency: "USD", offerFreshnessMinutes: 30 },
    });
    preferenceVersion = preference.version;
    taskId = randomUUID();
    leaseToken = randomUUID();
    await db.insert(agentTaskRuns).values({
      id: taskId, operation: "PLAN", status: "RUNNING", createdByUserId: userId, tripId,
      snapshotId, flightSearchPreferencesVersion: preference.version, requestId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000), leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date(),
    });
    __resetRegistryForTests();
    registerSkill(createFlightSearchSkill({
      async searchFlights() {
        return { outcome: "UNAVAILABLE" as const, reason: "NO_RESULTS" as const };
      },
    }));
  });

  afterEach(async () => {
    __resetRegistryForTests();
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(auditEvents).where(eq(auditEvents.actorUserId, userId));
    await db.delete(planningResearchResults).where(eq(planningResearchResults.snapshotId, snapshotId));
    await db.delete(providerOffers).where(eq(providerOffers.snapshotId, snapshotId));
    await db.delete(providerSearchRuns).where(eq(providerSearchRuns.snapshotId, snapshotId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, taskId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  function dependenciesThatThrow(error: unknown): PlanningDependencies {
    return {
      ...testPlanningDependencies,
      modelGateway: {
        ...testPlanningDependencies.modelGateway,
        async generateStructuredPlanWithTools() { throw error; },
      },
    };
  }

  const run = (dependencies: PlanningDependencies) => generatePlan({
    ctx: createRequestContext(userId), tripId, snapshotId, destination: "NRT",
    memberIds: [], agentTaskRunId: taskId,
    flightSearchPreferencesVersion: preferenceVersion, leaseToken,
  }, dependencies);

  it.each([
    ["PLAN_SCHEMA_UNMET", new PlanValidationError([{
      code: "EVIDENCE_NOT_FOUND", fieldPath: "hotels.0", reason: "test",
    }])],
    ["RESEARCH_MATRIX_INCOMPLETE", new FlightResearchIncompleteError([{ originId: "SFO", destinationId: "NRT", status: "MISSING" }])],
    ["TOOL_BUDGET_EXHAUSTED", new ModelGatewayError("TOOL_CALL_MAX_TURNS")],
  ])("records %s as a research summary rather than failing the round", async (reason, error) => {
    const synthesis = await run(dependenciesThatThrow(error));

    expect(synthesis.outcome).toBe("RESEARCH_SUMMARY");
    if (synthesis.outcome !== "RESEARCH_SUMMARY") throw new Error("expected RESEARCH_SUMMARY");
    expect(synthesis.reason).toBe(reason);

    // The traveller must be able to read *why*, not just that there is no plan.
    const [result] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, taskId));
    expect(result.summaryReason).toBe(reason);

    const [task] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, taskId));
    expect(task.status).toBe("COMPLETED_WITH_GAPS");
    expect(task.errorCode).toBeNull();
  });

  /**
   * 2026-09-06: a replan that exhausted repair without producing a plan
   * persisted `resultPlanId: null`, and the run terminal status collapsed
   * to `COMPLETED` whenever the synthesised `serviceGaps` came back empty
   * — so the Shared Plan view rendered "plan ready" over an empty surface.
   * The invariant is on the terminal status, not the gap list: a
   * research-summary branch (any `resultPlanId === null`) MUST terminate as
   * `COMPLETED_WITH_GAPS` regardless of gap count.
   */
  it("keeps the run at COMPLETED_WITH_GAPS even when serviceGaps round-trip as []", async () => {
    await run(dependenciesThatThrow(new PlanValidationError([{
      code: "EVIDENCE_SLOT_MISMATCH", fieldPath: "stays.0", reason: "test",
    }])));

    const [result] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, taskId));
    expect(result.resultPlanId).toBeNull();
    expect(result.summaryReason).toBe("PLAN_SCHEMA_UNMET");

    const [task] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, taskId));
    expect(task.status).toBe("COMPLETED_WITH_GAPS");
    expect(task.resultPlanId).toBeNull();
  });

  it("still fails the round for an error that is not a missing plan", async () => {
    // Losing the lease is not "the model did not produce a plan" — the round no
    // longer owns finalization and must not write anything on this trip's behalf.
    await db.update(agentTaskRuns).set({ leaseToken: randomUUID() }).where(eq(agentTaskRuns.id, taskId));
    await expect(run(dependenciesThatThrow(new Error("boom")))).rejects.toThrow();

    expect(await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, taskId))).toHaveLength(0);
  });

  it("refuses a summary_reason the contract does not name", async () => {
    // The value is rendered to the traveller, so an unknown one has to fail at
    // the write and not at the render.
    await expect(db.insert(planningResearchResults).values({
      tripId, snapshotId, agentTaskRunId: null, status: "COMPLETED_WITH_GAPS",
      serviceGaps: [], resultPlanId: null,
      summaryReason: "PROVIDER_WAS_SAD" as never,
    })).rejects.toThrow();
  });
});
