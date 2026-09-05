import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  users,
  sharedTrips,
  tripMembers,
  chatMessages,
  chatThreads,
  auditEvents,
} from "../src/db/schema.js";
import { __setModelGatewayForTests } from "../src/providers/gateway-factory.js";
import type { ModelGateway } from "../src/providers/model-gateway.js";
import { SkillError } from "../src/agents/errors.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
let tripId: string;
let defaultThreadId: string;

let generateTripDestinationLabel = vi.fn();

function stubGateway(): void {
  __setModelGatewayForTests({ generateTripDestinationLabel } as unknown as ModelGateway);
}

function suggest(payload: Record<string, unknown> = {}, actor = "alice") {
  return app.inject({
    method: "POST",
    url: `/api/v1/trips/${tripId}/title/suggest`,
    headers: { ...authHeaders(actor), "content-type": "application/json" },
    payload: { locale: "zh", ...payload },
  });
}

async function readTrip() {
  const [row] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
  return row!;
}

async function addUserMessage(body: string): Promise<void> {
  await db.insert(chatMessages).values({
    threadId: defaultThreadId, senderUserId: aliceId, role: "USER", body,
  });
}

async function cleanup(): Promise<void> {
  if (!aliceId || !bobId) return;
  const threads = await db.select({ id: chatThreads.id }).from(chatThreads)
    .where(inArray(chatThreads.ownerUserId, [aliceId, bobId]));
  const threadIds = threads.map((t) => t.id);
  if (threadIds.length > 0) {
    await db.delete(chatMessages).where(inArray(chatMessages.threadId, threadIds));
    await db.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, [aliceId, bobId]));
  const trips = await db.select({ id: sharedTrips.id }).from(sharedTrips)
    .where(inArray(sharedTrips.createdBy, [aliceId, bobId]));
  const tripIds = trips.map((t) => t.id);
  if (tripIds.length > 0) {
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, tripIds));
    await db.delete(sharedTrips).where(inArray(sharedTrips.id, tripIds));
  }
}

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  const [alice] = await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" })
    .onConflictDoNothing({ target: users.externalId }).returning();
  const [bob] = await db.insert(users)
    .values({ externalId: "bob", displayName: "Bob" })
    .onConflictDoNothing({ target: users.externalId }).returning();
  aliceId = (alice ?? (await db.select().from(users).where(eq(users.externalId, "alice")).limit(1))[0])!.id;
  bobId = (bob ?? (await db.select().from(users).where(eq(users.externalId, "bob")).limit(1))[0])!.id;
});

afterAll(async () => {
  await cleanup();
  __setModelGatewayForTests(null);
  await app.close();
});

beforeEach(async () => {
  await cleanup();
  generateTripDestinationLabel = vi.fn();
  stubGateway();
  tripId = randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: "行程规划",
    nameSource: "AUTO",
    titleLocale: "zh",
    createdBy: aliceId,
    status: "DRAFT",
    departureCities: [],
    destinationCandidates: [],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
  const [thread] = await db.insert(chatThreads).values({
    tripId, ownerUserId: aliceId, isDefault: true, title: "行程规划",
    titleSource: "AUTO", titleLocale: "zh",
  }).returning({ id: chatThreads.id });
  defaultThreadId = thread!.id;
});

afterEach(() => {
  __setModelGatewayForTests(null);
});

describe("POST /trips/:tripId/title/suggest", () => {
  it("persists the dataset's canonical name, not the model's raw text", async () => {
    // The regression this locks down: the route used to write the raw model
    // output, so a zh caller whose model answered "France" got the title
    // "France行程规划" even though the postprocess had already resolved 法国.
    await addUserMessage("我想去欧洲，看看能不能安排一趟");
    generateTripDestinationLabel.mockResolvedValue({ kind: "COUNTRY", value: "France" });

    const res = await suggest({ locale: "zh" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true });
    const trip = await readTrip();
    expect(trip.titleDestinationLabel).toBe("法国");
    expect(trip.titleLabelSource).toBe("LLM");
    expect(trip.name).toBe("法国行程规划");
  });

  it("canonicalises a lower-cased city into the dataset spelling", async () => {
    await addUserMessage("想找个亚洲城市待几天");
    generateTripDestinationLabel.mockResolvedValue({ kind: "CITY", value: "tokyo" });

    await suggest({ locale: "en" });

    const trip = await readTrip();
    expect(trip.titleDestinationLabel).toBe("Tokyo");
    expect(trip.name).toBe("Tokyo Trip Planner");
  });

  it("audits the write without recording the label text", async () => {
    await addUserMessage("我想去法国");
    generateTripDestinationLabel.mockResolvedValue({ kind: "COUNTRY", value: "France" });

    await suggest({ locale: "zh" });

    const [row] = await db.select().from(auditEvents)
      .where(eq(auditEvents.action, "TRIP_TITLE_LABEL_UPDATE")).limit(1);
    expect(row!.summary).toEqual({ source: "LLM" });
    expect(JSON.stringify(row!.summary)).not.toContain("法国");
  });

  it("rejects free text the reference dataset cannot re-resolve", async () => {
    await addUserMessage("想去个安静的地方");
    generateTripDestinationLabel.mockResolvedValue({ kind: "COUNTRY", value: "somewhere quiet" });

    const res = await suggest();

    expect(res.json()).toMatchObject({ applied: false, reason: "REJECTED" });
    expect((await readTrip()).titleDestinationLabel).toBeNull();
  });

  it("reports UNAVAILABLE and leaves the title alone when the gateway fails", async () => {
    await addUserMessage("我想去法国");
    generateTripDestinationLabel.mockRejectedValue(new SkillError("TIMEOUT", "gateway timed out"));

    const res = await suggest();

    expect(res.json()).toMatchObject({ applied: false, reason: "UNAVAILABLE" });
    const trip = await readTrip();
    expect(trip.titleDestinationLabel).toBeNull();
    expect(trip.name).toBe("行程规划");
  });

  it("never calls the model when the owner has written nothing yet", async () => {
    const res = await suggest();

    expect(res.json()).toMatchObject({ applied: false, reason: "NO_MATERIAL" });
    expect(generateTripDestinationLabel).not.toHaveBeenCalled();
  });

  it("never calls the model on a manually renamed trip", async () => {
    await addUserMessage("我想去法国");
    await db.update(sharedTrips).set({ nameSource: "MANUAL", name: "我的欧洲行" })
      .where(eq(sharedTrips.id, tripId));

    const res = await suggest();

    expect(res.json()).toMatchObject({ applied: false, reason: "MANUAL_LOCKED" });
    expect(generateTripDestinationLabel).not.toHaveBeenCalled();
    expect((await readTrip()).name).toBe("我的欧洲行");
  });

  it("never calls the model after the trip leaves Draft", async () => {
    await addUserMessage("我想去法国");
    await db.update(sharedTrips).set({ status: "PLANNING" })
      .where(eq(sharedTrips.id, tripId));

    const res = await suggest();

    expect(res.json()).toMatchObject({ applied: false, reason: "NOT_DRAFT" });
    expect(generateTripDestinationLabel).not.toHaveBeenCalled();
  });

  it("declines once a real destination city has been confirmed", async () => {
    await addUserMessage("我想去法国");
    await db.update(sharedTrips).set({ destinationCandidates: ["Paris"] })
      .where(eq(sharedTrips.id, tripId));
    generateTripDestinationLabel.mockResolvedValue({ kind: "COUNTRY", value: "France" });

    const res = await suggest();

    expect(res.json()).toMatchObject({ applied: false, reason: "SUPERSEDED" });
    expect((await readTrip()).titleDestinationLabel).toBeNull();
  });

  it("refuses a non-creator member", async () => {
    await addUserMessage("我想去法国");
    const res = await suggest({}, "bob");
    expect(res.statusCode).toBe(403);
    expect(generateTripDestinationLabel).not.toHaveBeenCalled();
  });

  it("returns 404 for a trip that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${randomUUID()}/title/suggest`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { locale: "zh" },
    });
    expect(res.statusCode).toBe(404);
  });
});
