/**
 * Memory write commands are idempotent on a client key (§6).
 *
 * A repeated memory write is not harmless: it supersedes the fact again,
 * producing a second version, a second round of staled plans and a second audit
 * row for one change the user made once. A retry after a dropped response
 * should return the original result.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

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
import { replaceFact } from "../src/services/preference-fact-service.js";
import { createRequestContext } from "../src/utils/context.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

const EXTERNAL_ID = "test-memoryidem";

let app: FastifyInstance;
let userId: string;
let profileId: string;
let factId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();
  await app.inject({ method: "GET", url: "/api/v1/profiles/me", headers: authHeaders(EXTERNAL_ID) });

  const [user] = await db.select().from(users).where(eq(users.externalId, EXTERNAL_ID)).limit(1);
  userId = user!.id;
  const [profile] = await db.insert(userProfiles)
    .values({ userId, displayName: "Idem" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  profileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1))[0]!.id;
});

afterAll(async () => {
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.entityType, "memory_fact"));
  await db.delete(memoryProposals).where(eq(memoryProposals.userId, userId));
  await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, userId));
  await db.delete(auditEvents).where(eq(auditEvents.actorUserId, userId));
  await db.delete(userProfiles).where(eq(userProfiles.userId, userId));
  await app.close();
});

beforeEach(async () => {
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.entityType, "memory_fact"));
  await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, userId));
  await db.delete(auditEvents).where(eq(auditEvents.actorUserId, userId));

  const fact = await replaceFact({
    ctx: createRequestContext(userId), userId, profileId,
    fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
  });
  factId = fact.id;
});

const put = (value: unknown, key?: string) => app.inject({
  method: "PUT",
  url: `/api/v1/profiles/me/memory/facts/${factId}`,
  headers: { ...authHeaders(EXTERNAL_ID), ...(key ? { "idempotency-key": key } : {}) },
  payload: { value },
});

const rowCount = async () => (await db.select().from(preferenceFacts)
  .where(eq(preferenceFacts.userId, userId))).length;

const auditCount = async () => (await db.select().from(auditEvents).where(and(
  eq(auditEvents.actorUserId, userId),
  eq(auditEvents.action, "PREFERENCE_FACT_UPDATE"),
))).length;

describe("PUT fact with an idempotency key", () => {
  it("applies the change once and replays the same result", async () => {
    const first = await put("packed", "retry-1");
    expect(first.statusCode).toBe(200);

    const before = { rows: await rowCount(), audits: await auditCount() };
    const second = await put("packed", "retry-1");

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // A replay must not add a version, a stale cascade or an audit row.
    expect(await rowCount()).toBe(before.rows);
    expect(await auditCount()).toBe(before.audits);
  });

  it("applies a genuinely different command under a different key", async () => {
    await put("packed", "retry-1");
    const audits = await auditCount();

    const response = await put("balanced", "retry-2");
    expect(response.statusCode).toBe(200);
    expect(response.json().value).toBe("balanced");
    expect(await auditCount()).toBe(audits + 1);
  });

  it("still applies every call when no key is sent", async () => {
    // Requiring a key would break existing callers, so its absence means the
    // command simply runs.
    await put("packed");
    const audits = await auditCount();
    await put("balanced");

    expect(await auditCount()).toBe(audits + 1);
  });

  it("rejects a malformed key rather than ignoring it", async () => {
    // Silently dropping it would leave the caller believing it was protected.
    const response = await put("packed", "not a valid key!");
    expect(response.statusCode).toBe(400);
  });
});
