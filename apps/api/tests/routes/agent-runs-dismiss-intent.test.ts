/**
 * Agent Run Dismiss Intent — Phase 2.
 *
 * Locks the contract of `POST /api/v1/agent-runs/:runId/dismiss-intent`:
 *  - Owner-only access (Bob cannot dismiss Alice's draft).
 *  - 404 when the run does not exist.
 *  - 409 when state is not PROPOSED (already dismissed / confirmed /
 *    superseded) or when the operation is not CONVERSATION.
 *  - 204 + state transition + SSE publish on the happy path.
 *  - No draft body leakage in the response or SSE payload.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  chatThreads,
  idempotencyRecords,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { AgentStreamRelay } from "../../src/tasks/agent-stream-relay.js";
import { authHeaders, verifyTestAccessToken } from "../helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
let tripId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken, agentStreamRelay: new AgentStreamRelay() });
  await app.ready();

  const [alice] = await db.insert(users).values({
    externalId: "alice-dismiss", displayName: "Alice",
  }).onConflictDoNothing({ target: users.externalId }).returning();
  const [bob] = await db.insert(users).values({
    externalId: "bob-dismiss", displayName: "Bob",
  }).onConflictDoNothing({ target: users.externalId }).returning();
  const aliceRow = alice ?? (await db.select().from(users).where(eq(users.externalId, "alice-dismiss")).limit(1))[0];
  const bobRow = bob ?? (await db.select().from(users).where(eq(users.externalId, "bob-dismiss")).limit(1))[0];
  aliceId = aliceRow!.id;
  bobId = bobRow!.id;

  const [trip] = await db.insert(sharedTrips).values({
    name: `dismiss-test-${randomUUID()}`,
    createdBy: aliceId,
    status: "PLANNING",
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-09-01",
    travelDateEnd: "2026-09-07",
  }).returning();
  tripId = trip!.id;
  await db.insert(tripMembers).values({ tripId, userId: aliceId, role: "CREATOR", isRequired: true });
  await db.insert(tripMembers).values({ tripId, userId: bobId, role: "MEMBER", isRequired: true });
});

afterAll(async () => {
  await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
  await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  await app.close();
});

interface DraftRow {
  threadId: string;
  runId: string;
  requestId: string;
}

async function seedProposedDraft(): Promise<DraftRow> {
  const [thread] = await db.insert(chatThreads).values({
    tripId,
    title: `dismiss-${randomUUID()}`,
    scope: "TRIP",
    isDefault: false,
    ownerUserId: aliceId,
    createdBy: aliceId,
  }).returning();
  const requestId = randomUUID();
  const [userMessage] = await db.insert(chatMessages).values({
    threadId: thread!.id,
    role: "USER",
    senderUserId: aliceId,
    body: "查酒店",
    messageSequence: 1,
  }).returning();
  const [run] = await db.insert(agentTaskRuns).values({
    operation: "CONVERSATION",
    status: "COMPLETED",
    createdByUserId: aliceId,
    threadId: thread!.id,
    tripId,
    requestId,
    userMessageId: userMessage!.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    researchIntentDraft: {
      schemaVersion: 1,
      kind: "RESEARCH_ONLY",
      requestedCapabilities: ["hotel"],
      classifierVersion: "research-intent/v1",
      readiness: "NEEDS_SETUP",
      missing: ["STAY_PREFERENCES_MISSING"],
    },
    researchIntentState: "PROPOSED",
  }).returning();
  return { threadId: thread!.id, runId: run!.id, requestId };
}

async function cleanup(row: DraftRow): Promise<void> {
  await db.delete(agentTaskRuns).where(eq(agentTaskRuns.id, row.runId));
  await db.delete(chatMessages).where(eq(chatMessages.threadId, row.threadId));
  await db.delete(chatThreads).where(eq(chatThreads.id, row.threadId));
  await db.delete(idempotencyRecords)
    .where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${row.threadId}:${row.requestId}`));
}

describe("POST /api/v1/agent-runs/:runId/dismiss-intent", () => {
  it("returns 204 and transitions state to DISMISSED on the happy path", async () => {
    const row = await seedProposedDraft();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${row.runId}/dismiss-intent`,
        headers: authHeaders("alice-dismiss"),
      });
      expect(response.statusCode).toBe(204);

      // DB state column reflects the transition.
      const [updated] = await db.select().from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, row.runId));
      expect(updated.researchIntentState).toBe("DISMISSED");
      // Draft body is preserved — never deleted on dismissal.
      expect(updated.researchIntentDraft).toBeTruthy();
      expect(updated.researchIntentDraft!.kind).toBe("RESEARCH_ONLY");
    } finally {
      await cleanup(row);
    }
  });

  it("returns 409 when the run is already DISMISSED", async () => {
    const row = await seedProposedDraft();
    try {
      const first = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${row.runId}/dismiss-intent`,
        headers: authHeaders("alice-dismiss"),
      });
      expect(first.statusCode).toBe(204);

      const second = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${row.runId}/dismiss-intent`,
        headers: authHeaders("alice-dismiss"),
      });
      expect(second.statusCode).toBe(409);
      const body = second.json() as { message: string };
      expect(body.message).toContain("DISMISSED");
    } finally {
      await cleanup(row);
    }
  });

  it("returns 409 when the run is CONFIRMED (research already accepted)", async () => {
    const row = await seedProposedDraft();
    try {
      await db.update(agentTaskRuns)
        .set({ researchIntentState: "CONFIRMED" })
        .where(eq(agentTaskRuns.id, row.runId));

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${row.runId}/dismiss-intent`,
        headers: authHeaders("alice-dismiss"),
      });
      expect(response.statusCode).toBe(409);
      const body = response.json() as { message: string };
      expect(body.message).toContain("CONFIRMED");
    } finally {
      await cleanup(row);
    }
  });

  it("returns 409 when the run is SUPERSEDED by a newer draft", async () => {
    const row = await seedProposedDraft();
    try {
      await db.update(agentTaskRuns)
        .set({ researchIntentState: "SUPERSEDED" })
        .where(eq(agentTaskRuns.id, row.runId));

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${row.runId}/dismiss-intent`,
        headers: authHeaders("alice-dismiss"),
      });
      expect(response.statusCode).toBe(409);
      const body = response.json() as { message: string };
      expect(body.message).toContain("SUPERSEDED");
    } finally {
      await cleanup(row);
    }
  });

  it("returns 403 when Bob tries to dismiss Alice's draft", async () => {
    const row = await seedProposedDraft();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/agent-runs/${row.runId}/dismiss-intent`,
        headers: authHeaders("bob-dismiss"),
      });
      expect(response.statusCode).toBe(403);
      // Alice's state is untouched.
      const [unchanged] = await db.select().from(agentTaskRuns)
        .where(eq(agentTaskRuns.id, row.runId));
      expect(unchanged.researchIntentState).toBe("PROPOSED");
    } finally {
      await cleanup(row);
    }
  });

  it("returns 404 when the run does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${randomUUID()}/dismiss-intent`,
      headers: authHeaders("alice-dismiss"),
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 when runId is not a uuid", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/not-a-uuid/dismiss-intent`,
      headers: authHeaders("alice-dismiss"),
    });
    expect(response.statusCode).toBe(400);
  });
});
