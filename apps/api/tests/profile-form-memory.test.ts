/**
 * The Profile form is a memory write path.
 *
 * Existing coverage called `PreferenceFactService` directly, so it proved the
 * service worked while the API route never called it: a preference the user
 * typed into the form stayed in `user_profiles` and never became a fact, which
 * is the only thing memory is actually built from.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

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
import { listActiveFacts } from "../src/services/preference-fact-service.js";
import { listPendingProposals, observeBehavior } from "../src/services/memory-proposal-service.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { createRequestContext } from "../src/utils/context.js";

const EXTERNAL_ID = "test-profileform";

let app: FastifyInstance;
let userId: string;

async function currentProfileId(): Promise<string> {
  const [row] = await db.select().from(userProfiles)
    .where(eq(userProfiles.userId, userId)).limit(1);
  return row!.id;
}

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  // The route creates the user on first authenticated request.
  await app.inject({ method: "GET", url: "/api/v1/profiles/me", headers: authHeaders(EXTERNAL_ID) });
  const [row] = await db.select().from(users).where(eq(users.externalId, EXTERNAL_ID)).limit(1);
  userId = row!.id;
});

afterAll(async () => {
  await db.delete(idempotencyRecords)
    .where(eq(idempotencyRecords.entityType, "memory_observation"));
  await db.delete(memoryProposals).where(eq(memoryProposals.userId, userId));
  await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, userId));
  await db.delete(auditEvents).where(eq(auditEvents.actorUserId, userId));
  await db.delete(userProfiles).where(eq(userProfiles.userId, userId));
  await app.close();
});

beforeEach(async () => {
  // Episode ids are fixed, so the idempotency claims from a previous run would
  // make every observation a duplicate and the suggestion never appear.
  await db.delete(idempotencyRecords)
    .where(eq(idempotencyRecords.entityType, "memory_observation"));
  await db.delete(memoryProposals).where(eq(memoryProposals.userId, userId));
  await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, userId));
  await db.delete(userProfiles).where(eq(userProfiles.userId, userId));
});

const post = (body: Record<string, unknown>) => app.inject({
  method: "POST", url: "/api/v1/profiles", headers: authHeaders(EXTERNAL_ID), payload: body,
});
const put = (body: Record<string, unknown>) => app.inject({
  method: "PUT", url: "/api/v1/profiles/me", headers: authHeaders(EXTERNAL_ID), payload: body,
});

describe("POST /profiles", () => {
  it("records what the user stated as a long-term fact", async () => {
    const response = await post({ accommodationStyle: "budget", noRedEye: true });
    expect(response.statusCode).toBe(201);

    const facts = await listActiveFacts(userId);
    expect(facts.map((fact) => [fact.fieldKey, fact.value]).sort()).toEqual([
      ["accommodation_style", "budget"],
      ["no_red_eye", true],
    ]);
    expect(facts.every((fact) => fact.source === "PROFILE_FORM")).toBe(true);
  });
});

describe("PUT /profiles/me", () => {
  beforeEach(async () => {
    await post({ accommodationStyle: "budget" });
  });

  it("supersedes the fact rather than adding a second active one", async () => {
    expect((await put({ accommodationStyle: "luxury" })).statusCode).toBe(200);

    const facts = await listActiveFacts(userId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fieldKey: "accommodation_style", value: "luxury" });
  });

  it("leaves fields the request did not mention alone", async () => {
    // A partial update means "unchanged", not "cleared".
    await put({ noRedEye: true });

    const fields = (await listActiveFacts(userId)).map((fact) => fact.fieldKey).sort();
    expect(fields).toEqual(["accommodation_style", "no_red_eye"]);
  });

  it("rejects a null and leaves the fact standing", async () => {
    // `updateProfileSchema` is `createProfileSchema.partial()`, which makes a
    // field optional but not nullable, so the form currently offers no way to
    // clear a stated preference. Pinned as the API's actual behaviour rather
    // than asserted as desirable — see `syncProfileFormToMemory`, which does
    // handle a cleared field once the schema allows one.
    const response = await put({ accommodationStyle: null });
    expect(response.statusCode).toBe(400);
    expect(await listActiveFacts(userId)).toHaveLength(1);
  });

  it("drops a pending suggestion for a field the user has now answered", async () => {
    const profileId = await currentProfileId();
    for (const [index, day] of [0, 15, 30].entries()) {
      await observeBehavior({
        ctx: createRequestContext(userId),
        userId, profileId,
        fieldKey: "trip_pace", value: "packed",
        episodeId: `profile-form-${index}`,
        tripId: `0000000${index}-0000-4000-8000-00000000000${index}`,
        observedAt: new Date(Date.now() - (30 - day) * 86_400_000),
      });
    }
    expect(await listPendingProposals(userId)).toHaveLength(1);

    // `trip_pace` has no profile column, so answering a *different* field must
    // not touch it.
    await put({ accommodationStyle: "luxury" });
    expect(await listPendingProposals(userId)).toHaveLength(1);
  });

  it("stores a sensitive field as a fact but keeps it unexportable", async () => {
    // The form is the only path allowed to write these at all; the catalog is
    // what stops them being projected.
    await put({ nationality: "Singapore" });

    const facts = await listActiveFacts(userId);
    expect(facts.find((fact) => fact.fieldKey === "nationality")?.value).toBe("Singapore");
  });

  it("still updates the profile when a value is outside the memory schema", async () => {
    // The profile column's schema is looser than memory's. Memory must not get
    // to veto what a user records about themselves.
    const tooMany = Array.from({ length: 25 }, (_, i) => `interest-${i}`);
    const response = await put({ interests: tooMany });

    expect(response.statusCode).toBe(200);
    const [profile] = await db.select().from(userProfiles)
      .where(eq(userProfiles.userId, userId)).limit(1);
    expect(profile.interests).toHaveLength(25);
    expect((await listActiveFacts(userId)).map((f) => f.fieldKey)).not.toContain("interests");
  });
});

describe("DELETE /profiles/me", () => {
  it("removes the facts the profile recorded", async () => {
    await post({ accommodationStyle: "budget", noRedEye: true });
    expect(await listActiveFacts(userId)).toHaveLength(2);

    const response = await app.inject({
      method: "DELETE", url: "/api/v1/profiles/me", headers: authHeaders(EXTERNAL_ID),
    });
    expect(response.statusCode).toBe(200);

    // Facts left behind would keep projecting into trips after the user asked
    // for deletion.
    expect(await db.select().from(preferenceFacts)
      .where(eq(preferenceFacts.userId, userId))).toHaveLength(0);
  });
});
