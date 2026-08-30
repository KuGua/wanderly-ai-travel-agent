import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  idempotencyRecords,
  memoryProposals,
  preferenceFacts,
  userProfiles,
  users,
} from "../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { replaceFact } from "../src/services/preference-fact-service.js";
import { observeBehavior } from "../src/services/memory-proposal-service.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000dd", actorUserId: undefined } as never;

const DAY = 86_400_000;
// Routes evaluate activation against the real clock, so evidence has to be
// anchored to now — dated fixtures would decay below the threshold.
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

const TRIP_A = "aaaaaaaa-1111-4000-8000-000000000001";
const TRIP_B = "bbbbbbbb-1111-4000-8000-000000000002";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
let aliceProfileId: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return existing!.id;
}

async function cleanup() {
  const ids = [aliceId, bobId].filter(Boolean);
  if (ids.length === 0) return;
  await db.delete(memoryProposals).where(inArray(memoryProposals.userId, ids));
  await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, ids));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.entityType, "memory_observation"));
}

let episodeSeq = 0;
/** Four episodes across two trips over 30 days: clears every gate. */
async function buildSuggestion(value = "packed") {
  for (const [index, day] of [30, 20, 10, 0].entries()) {
    episodeSeq += 1;
    await observeBehavior({
      ctx,
      userId: aliceId,
      profileId: aliceProfileId,
      fieldKey: "trip_pace",
      value,
      episodeId: `route-episode-${episodeSeq}`,
      tripId: index === 0 ? TRIP_A : TRIP_B,
      observedAt: daysAgo(day),
    });
  }
}

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  aliceId = await ensureUser("memory-route-owner");
  bobId = await ensureUser("memory-route-other");

  const [profile] = await db.insert(userProfiles)
    .values({ userId: aliceId, displayName: "Alice" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  aliceProfileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, aliceId)).limit(1))[0]!.id;
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

beforeEach(cleanup);

describe("GET /profiles/me/memory", () => {
  it("returns the owner's active facts", async () => {
    await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    const response = await app.inject({
      method: "GET", url: "/api/v1/profiles/me/memory", headers: authHeaders("memory-route-owner"),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0]).toMatchObject({ fieldKey: "trip_pace", value: "relaxed" });
  });

  it("never returns profileId, evidence dates or trip references", async () => {
    await buildSuggestion();
    const response = await app.inject({
      method: "GET", url: "/api/v1/profiles/me/memory", headers: authHeaders("memory-route-owner"),
    });

    const raw = response.body;
    expect(raw).not.toContain("profileId");
    expect(raw).not.toContain("recentObservedOn");
    expect(raw).not.toContain("contributingTripIds");
    expect(raw).not.toContain("activation");
    expect(raw).not.toContain(TRIP_A);
    expect(raw).not.toContain(aliceProfileId);
  });

  it("does not leak another owner's memory", async () => {
    await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    const response = await app.inject({
      method: "GET", url: "/api/v1/profiles/me/memory", headers: authHeaders("memory-route-other"),
    });

    expect(response.json().facts).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/profiles/me/memory" });
    expect(response.statusCode).toBe(401);
  });
});

describe("PUT /profiles/me/memory/facts/:factId", () => {
  it("replaces the value and clears conflicting suggestions", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    await buildSuggestion("packed");

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/me/memory/facts/${fact.id}`,
      headers: authHeaders("memory-route-owner"),
      payload: { value: "balanced" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().value).toBe("balanced");

    // Stating a value settles the question the suggestion was asking.
    const pending = await db.select().from(memoryProposals)
      .where(eq(memoryProposals.userId, aliceId));
    expect(pending).toHaveLength(0);
  });

  it("rejects a value outside the field schema", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/me/memory/facts/${fact.id}`,
      headers: authHeaders("memory-route-owner"),
      payload: { value: "sprint" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("will not let another user write to a fact", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/me/memory/facts/${fact.id}`,
      headers: authHeaders("memory-route-other"),
      payload: { value: "packed" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("refuses a body carrying extra fields such as userId", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/me/memory/facts/${fact.id}`,
      headers: authHeaders("memory-route-owner"),
      payload: { value: "packed", userId: bobId },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("DELETE /profiles/me/memory/facts/:factId", () => {
  it("removes the fact and the evidence behind it", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    await buildSuggestion("packed");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/profiles/me/memory/facts/${fact.id}`,
      headers: authHeaders("memory-route-owner"),
    });

    expect(response.statusCode).toBe(204);
    expect(await db.select().from(preferenceFacts).where(eq(preferenceFacts.userId, aliceId)))
      .toHaveLength(0);
    // Otherwise the suggestion would return from data the user just deleted.
    expect(await db.select().from(memoryProposals).where(eq(memoryProposals.userId, aliceId)))
      .toHaveLength(0);
  });

  it("will not let another user delete a fact", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/profiles/me/memory/facts/${fact.id}`,
      headers: authHeaders("memory-route-other"),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("proposal resolution", () => {
  it("confirms a suggestion into a fact, idempotently", async () => {
    await buildSuggestion();
    const listing = await app.inject({
      method: "GET", url: "/api/v1/profiles/me/memory", headers: authHeaders("memory-route-owner"),
    });
    const [suggestion] = listing.json().suggestions;
    expect(suggestion).toBeDefined();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/me/memory/proposals/${suggestion.id}/confirm`,
      headers: authHeaders("memory-route-owner"),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().factId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/me/memory/proposals/${suggestion.id}/confirm`,
      headers: authHeaders("memory-route-owner"),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().factId).toBeNull();

    const facts = await db.select().from(preferenceFacts)
      .where(eq(preferenceFacts.userId, aliceId));
    expect(facts.filter((fact) => fact.status === "ACTIVE")).toHaveLength(1);
  });

  it("dismisses a suggestion without creating a fact", async () => {
    await buildSuggestion();
    const listing = await app.inject({
      method: "GET", url: "/api/v1/profiles/me/memory", headers: authHeaders("memory-route-owner"),
    });
    const [suggestion] = listing.json().suggestions;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/me/memory/proposals/${suggestion.id}/dismiss`,
      headers: authHeaders("memory-route-owner"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("DISMISSED");
    expect(await db.select().from(preferenceFacts).where(eq(preferenceFacts.userId, aliceId)))
      .toHaveLength(0);
  });

  it("will not let another user resolve someone's suggestion", async () => {
    await buildSuggestion();
    const listing = await app.inject({
      method: "GET", url: "/api/v1/profiles/me/memory", headers: authHeaders("memory-route-owner"),
    });
    const [suggestion] = listing.json().suggestions;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/me/memory/proposals/${suggestion.id}/confirm`,
      headers: authHeaders("memory-route-other"),
    });

    expect(response.statusCode).toBe(404);
  });
});
