import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  planningResearchResults,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import {
  RECORD_RESEARCH_RESULT_MAX_GAPS,
  isGapOnlyStatus,
  recordPlanningResearchResult,
  serviceGapSchema,
  toResearchResultDto,
} from "../src/services/planning-research-result-service.js";
import { createRequestContext } from "../src/utils/context.js";

describe("planning-research-result-service", () => {
  let userId: string;
  let tripId: string;
  let snapshotId: string;
  let taskId: string;

  beforeEach(async () => {
    const [user] = await db.insert(users).values({ externalId: `research-${randomUUID()}`, displayName: "Research result test" }).returning();
    userId = user.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Research trip", createdBy: userId, authorizedData: {},
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
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(planningResearchResults).where(eq(planningResearchResults.snapshotId, snapshotId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    await db.delete(constraintSnapshots).where(eq(constraintSnapshots.id, snapshotId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("persists a COMPLETE row when no gaps are recorded", async () => {
    const id = await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETE", serviceGaps: [],
    });
    const rows = await db.select().from(planningResearchResults).where(eq(planningResearchResults.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETE");
    expect(rows[0].serviceGaps).toEqual([]);
    expect(rows[0].agentTaskRunId).toBe(taskId);
  });

  it("persists a COMPLETED_WITH_GAPS row with bounded service_gaps", async () => {
    const gaps = [
      { capability: "flight" as const, code: "UPSTREAM_FAILURE" as const, destinationId: "tokyo" },
      { capability: "navigation" as const, code: "NO_RESULTS" as const },
    ];
    const id = await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS", serviceGaps: gaps,
    });
    const rows = await db.select().from(planningResearchResults).where(eq(planningResearchResults.id, id));
    expect(rows[0].status).toBe("COMPLETED_WITH_GAPS");
    expect(rows[0].serviceGaps).toEqual(gaps);
  });

  it("deduplicates identical user-visible gaps before persistence", async () => {
    const duplicate = {
      capability: "places" as const,
      code: "SKILL_CONTRACT_VIOLATION" as const,
      destinationId: "shanghai",
    };
    const id = await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS",
      serviceGaps: [duplicate, duplicate, { ...duplicate, destinationId: "tokyo" }],
    });
    const rows = await db.select().from(planningResearchResults).where(eq(planningResearchResults.id, id));
    expect(rows[0].serviceGaps).toEqual([duplicate, { ...duplicate, destinationId: "tokyo" }]);
  });

  it("rejects malformed service gaps", () => {
    const result = serviceGapSchema.safeParse({
      capability: "spaceship",
      code: "PROVIDER_NOT_APPROVED",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when too many gaps are submitted", async () => {
    const gaps = Array.from({ length: RECORD_RESEARCH_RESULT_MAX_GAPS + 1 }, () => ({
      capability: "flight" as const,
      code: "UPSTREAM_FAILURE" as const,
      destinationId: "tokyo",
    }));
    await expect(recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS", serviceGaps: gaps,
    })).rejects.toThrow(/too many serviceGaps/);
  });

  it("is idempotent on (agentTaskRunId)", async () => {
    const first = await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETE", serviceGaps: [],
    });
    const second = await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS", serviceGaps: [{ capability: "navigation", code: "NO_RESULTS" }],
    });
    expect(second).toBe(first);
    const rows = await db.select().from(planningResearchResults).where(eq(planningResearchResults.id, first));
    expect(rows[0].status).toBe("COMPLETED_WITH_GAPS");
  });

  it("toResearchResultDto maps the row to a safe domain object", () => {
    const createdAt = new Date();
    const dto = toResearchResultDto({
      id: "11111111-1111-4111-8111-111111111111",
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS",
      serviceGaps: [{ capability: "flight", code: "UPSTREAM_FAILURE", destinationId: "tokyo" }],
      resultPlanId: null,
      summaryReason: null,
      createdAt,
    });
    expect(dto.status).toBe("COMPLETED_WITH_GAPS");
    expect(dto.createdAt).toBe(createdAt.toISOString());
    expect(dto.serviceGaps).toHaveLength(1);
    expect(dto.summaryReason).toBeNull();
  });

  it("toResearchResultDto propagates a non-null summaryReason through", () => {
    const dto = toResearchResultDto({
      id: "11111111-1111-4111-8111-111111111111",
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS",
      serviceGaps: [],
      resultPlanId: null,
      summaryReason: "PLAN_SCHEMA_UNMET",
      createdAt: new Date(),
    });
    expect(dto.summaryReason).toBe("PLAN_SCHEMA_UNMET");
  });

  it("recordPlanningResearchResult round-trips summaryReason through insert and onConflict", async () => {
    const id = await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS", serviceGaps: [],
      summaryReason: "PLAN_SCHEMA_UNMET",
    });
    const rows = await db.select().from(planningResearchResults).where(eq(planningResearchResults.id, id));
    expect(rows[0].summaryReason).toBe("PLAN_SCHEMA_UNMET");

    // A second write to the same agentTaskRunId (idempotent path) must keep
    // the reason — it is part of the durable row, not the diff.
    await recordPlanningResearchResult({
      ctx: createRequestContext(userId, randomUUID(), randomUUID()),
      tripId, snapshotId, agentTaskRunId: taskId,
      status: "COMPLETED_WITH_GAPS", serviceGaps: [],
      summaryReason: "TOOL_BUDGET_EXHAUSTED",
    });
    const after = await db.select().from(planningResearchResults).where(eq(planningResearchResults.id, id));
    expect(after[0].summaryReason).toBe("TOOL_BUDGET_EXHAUSTED");
  });

  it("isGapOnlyStatus returns true when any gap is present", () => {
    expect(isGapOnlyStatus([])).toBe(false);
    expect(isGapOnlyStatus([{ capability: "flight", code: "UPSTREAM_FAILURE" }])).toBe(true);
  });
});
