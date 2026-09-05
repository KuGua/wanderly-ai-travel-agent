import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  chatThreads,
  constraintSnapshots,
  destinationCandidates,
  idempotencyRecords,
  itineraryPlans,
  preferenceFacts,
  providerOffers,
  providerSearchRuns,
  sharedTrips,
  sourceEvidence,
  staySearchProviderAuthorizations,
  tripSearchPreferences,
  agentTaskRuns,
  tripMembers,
  userProfiles,
  users,
  visaReadinessChecks,
} from "../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { __setQuoteNationalityCipherForTests } from "../src/services/quote-nationality-cipher.js";
import { loadActiveQuoteNationality } from "../src/services/stay-search-provider-authorization.js";

let app: FastifyInstance;
let aliceId: string;

beforeAll(async () => {
  // The quote-nationality grant is encrypted before it is stored, and the real
  // cipher needs KMS. A reversible stand-in keeps the assertions about *which*
  // value was authorized without reaching for a key. The padding is not
  // decoration: `stay_search_provider_authorizations_value_encrypted_check`
  // refuses a ciphertext short enough to be a two-letter country code.
  __setQuoteNationalityCipherForTests({
    encrypt: async (value) => Buffer.from(`test:${value}:opaque-test-padding`).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString("utf8")
      .replace(/^test:|:opaque-test-padding$/g, ""),
  });
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  // Ensure both `alice` and `bob` users exist so `authHeaders("bob")`
  // resolves a known identity in the non-creator rejection test.
  for (const subject of ["alice", "bob"] as const) {
    const [existing] = await db.select().from(users)
      .where(eq(users.externalId, subject)).limit(1);
    if (existing) {
      if (subject === "alice") aliceId = existing.id;
      continue;
    }
    const [created] = await db.insert(users).values({
      externalId: subject,
      displayName: subject.charAt(0).toUpperCase() + subject.slice(1),
    }).returning();
    if (subject === "alice") aliceId = created.id;
  }
});

afterAll(async () => {
  __setQuoteNationalityCipherForTests(undefined);
  await app.close();
});

beforeEach(async () => {
  // Order matters: clear leaf tables before their parents so FK cascades
  // from `shared_trips` (e.g. → `constraint_snapshots`) are not blocked by
  // rows in `provider_offers` / `visa_readiness_checks` left over from
  // sibling test files (the test DB is shared across files in one run).
  await db.delete(providerOffers);
  await db.delete(sourceEvidence);
  await db.delete(visaReadinessChecks);
  // Audit events retain the plan reference, so they must be cleared before
  // plans. Their deletion is scoped to the disposable test database.
  await db.delete(auditEvents);
  await db.delete(itineraryPlans);
  await db.delete(providerSearchRuns);
  await db.delete(agentTaskRuns);
  await db.delete(destinationCandidates);
  await db.delete(constraintSnapshots);
  await db.delete(preferenceFacts);
  await db.delete(idempotencyRecords);
  await db.delete(tripSearchPreferences);
  await db.delete(chatThreads);
  await db.delete(staySearchProviderAuthorizations);
  await db.delete(tripMembers);
  await db.delete(sharedTrips);
  await db.delete(userProfiles);
});

async function createDraftFor(userId: string, externalId: "alice" | "bob"): Promise<string> {
  const start = await app.inject({
    method: "POST",
    url: "/api/v1/explorations/start",
    headers: authHeaders(externalId),
    payload: { requestId: randomUUID() },
  });
  expect(start.statusCode).toBe(201);
  return start.json().trip.id;
}

const validBrief = {
  departureCities: ["San Francisco", "Shanghai"],
  destinationCandidates: ["Tokyo", "Bangkok"],
  travelDateStart: "2026-10-01",
  travelDateEnd: "2026-10-10",
  titleLocale: "en" as const,
};

describe("Trip activation", () => {
  it("moves a DRAFT trip to PLANNING and writes TRIP_ACTIVATE audit", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: validBrief,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trip.status).toBe("PLANNING");
    expect(body.trip.name).toBe("Tokyo · Bangkok Trip Planner｜10 Days");
    expect(body.trip.departureCities).toEqual(validBrief.departureCities);
    expect(body.trip.destinationCandidates).toEqual(validBrief.destinationCandidates);
    expect(body.trip.travelDateStart).toBe(validBrief.travelDateStart);
    expect(body.trip.travelDateEnd).toBe(validBrief.travelDateEnd);
    expect(body.planningRun).toMatchObject({ runId: expect.any(String), snapshotId: expect.any(String) });

    const [persisted] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("PLANNING");

    const [queuedRun] = await db.select().from(agentTaskRuns)
      .where(eq(agentTaskRuns.tripId, draftId)).limit(1);
    expect(queuedRun).toMatchObject({ operation: "RESEARCH", status: "QUEUED", researchMode: "PROPOSE_PLAN" });

    const audits = await db.select().from(auditEvents)
      .where(eq(auditEvents.tripId, draftId));
    const actions = audits.map((row) => row.action);
    expect(actions).toContain("TRIP_ACTIVATE");
  });

  it("starts the first solo planning task from a confirmed date and duration", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        departureCities: ["Shanghai"],
        destinationCandidates: ["Suzhou"],
        travelDateStart: "2026-12-10",
        travelDays: 3,
        titleLocale: "en",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.travelDateEnd).toBe("2026-12-12");
    // The English-locale title is regenerated from explicit brief fields only.
    // Regression: the dist activate endpoint previously forgot to forward
    // `travelDays` to buildTripTitle, which silently dropped the day suffix
    // and produced "Suzhou Trip Planner" instead.
    expect(res.json().trip.name).toBe("Suzhou Trip Planner｜3 Days");
    expect(res.json().planningRun).toMatchObject({ runId: expect.any(String), snapshotId: expect.any(String) });
  });

  it("derives the title from explicit travelDays in the Chinese locale", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        departureCities: ["上海"],
        destinationCandidates: ["苏州"],
        travelDateStart: "2026-12-10",
        travelDays: 3,
        titleLocale: "zh",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.travelDateEnd).toBe("2026-12-12");
    // Chinese locale uses "行程规划" as the planner noun and "天" as the
    // day suffix; destinations are concatenated without a separating space.
    expect(res.json().trip.name).toBe("苏州行程规划｜3天");
  });

  it("rejects activation by a non-creator with 403", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("bob"),
      payload: validBrief,
    });
    expect(res.statusCode).toBe(403);

    const [persisted] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("DRAFT");
  });

  it("rejects an empty brief with 400", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        departureCities: [],
        destinationCandidates: ["Tokyo", "Bangkok"],
        titleLocale: "en",
      },
    });
    expect(res.statusCode).toBe(400);

    const [persisted] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("DRAFT");
  });

  it("rejects invalid or reverse date ranges rather than deriving a title from them", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: { ...validBrief, travelDateStart: "2026-10-10", travelDateEnd: "2026-10-01" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("allows only the creator to replace an automatic title manually and records no title text in audit", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    await app.inject({
      method: "POST", url: `/api/v1/trips/${draftId}/activate`, headers: authHeaders("alice"), payload: validBrief,
    });

    const forbidden = await app.inject({
      method: "PATCH", url: `/api/v1/trips/${draftId}/title`, headers: authHeaders("bob"), payload: { name: "Bob title" },
    });
    expect(forbidden.statusCode).toBe(403);

    const renamed = await app.inject({
      method: "PATCH", url: `/api/v1/trips/${draftId}/title`, headers: authHeaders("alice"), payload: { name: "Friends' escape" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().trip).toMatchObject({ name: "Friends' escape", nameSource: "MANUAL", titleLocale: null });

    const [persisted] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.nameSource).toBe("MANUAL");
    expect(persisted.titleLocale).toBeNull();
    const titleAudit = (await db.select().from(auditEvents).where(eq(auditEvents.tripId, draftId)))
      .find((event) => event.action === "TRIP_TITLE_UPDATE");
    expect(titleAudit?.summary).toEqual({ source: "manual" });
    expect(JSON.stringify(titleAudit?.summary)).not.toContain("Friends' escape");
  });

  it("rejects a trip that is not in DRAFT with 409", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    // Manually move to PLANNING so the second activate is a duplicate.
    await db.update(sharedTrips).set({ status: "PLANNING" })
      .where(eq(sharedTrips.id, draftId));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: validBrief,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/TRIP_NOT_DRAFT/);
  });

  it("returns 404 for an unknown trip", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${randomUUID()}/activate`,
      headers: authHeaders("alice"),
      payload: validBrief,
    });
    expect(res.statusCode).toBe(404);
  });

  it("database trigger blocks DRAFT → CONFIRMED bypass", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    await expect(
      db.update(sharedTrips).set({ status: "CONFIRMED" })
        .where(eq(sharedTrips.id, draftId)),
    ).rejects.toThrow();

    const [persisted] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("DRAFT");
  });

  it("database trigger permits DRAFT → CANCELLED", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    await db.update(sharedTrips).set({ status: "CANCELLED" })
      .where(eq(sharedTrips.id, draftId));

    const [persisted] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("CANCELLED");
  });

  it("retains the existing default thread after activation", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const [before] = await db.select().from(chatThreads)
      .where(and(eq(chatThreads.tripId, draftId), eq(chatThreads.isDefault, true)))
      .limit(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: validBrief,
    });
    expect(res.statusCode).toBe(200);

    const [after] = await db.select().from(chatThreads)
      .where(and(eq(chatThreads.tripId, draftId), eq(chatThreads.isDefault, true)))
      .limit(1);
    expect(after?.id).toBe(before?.id);
  });

  // Regression: Fastify's default AJV ran with `removeAdditional: true`, and
  // inside `quoteNationalityDecision`'s `oneOf` the PROFILE branch's
  // `additionalProperties: false` deleted `value` and `saveToProfile` from an
  // INPUT decision before the INPUT branch was even tried. Every hand-entered
  // nationality was answered with 400 "must have required property 'value'",
  // so a traveller with no stored nationality could never leave DRAFT. These
  // tests go through `app.inject`, which is the only place that runs.
  it("activates with a hand-entered nationality and authorizes it for this trip only", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        ...validBrief,
        quoteNationalityDecision: { source: "INPUT", value: "TW", saveToProfile: false, confirmProviderUse: true },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trip.status).toBe("PLANNING");
    // The value must survive validation intact — this is what the stripped
    // payload used to lose.
    const authorization = await loadActiveQuoteNationality({ tripId: draftId, memberId: aliceId });
    expect(authorization).toMatchObject({ nationality: "TW", version: 1 });

    // `saveToProfile: false` authorizes the provider call without writing the
    // traveller's private Profile.
    const profiles = await db.select().from(userProfiles).where(eq(userProfiles.userId, aliceId));
    expect(profiles).toHaveLength(0);
    // Nor may the authorized value appear in the audit trail.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.tripId, draftId));
    expect(JSON.stringify(audits.map((row) => row.summary))).not.toContain("TW");
  });

  it("saves the hand-entered nationality to the Profile when that box is ticked", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        ...validBrief,
        // Lower case on purpose: the stored form is normalized.
        quoteNationalityDecision: { source: "INPUT", value: "tw", saveToProfile: true, confirmProviderUse: true },
      },
    });

    expect(res.statusCode).toBe(200);
    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, aliceId));
    expect(profile?.nationality).toBe("TW");
    expect(await loadActiveQuoteNationality({ tripId: draftId, memberId: aliceId }))
      .toMatchObject({ nationality: "TW" });
  });

  it("activates from a stored Profile nationality without the browser sending it", async () => {
    await db.insert(userProfiles).values({ userId: aliceId, nationality: "TW" });
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        ...validBrief,
        quoteNationalityDecision: { source: "PROFILE", confirmProviderUse: true },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(await loadActiveQuoteNationality({ tripId: draftId, memberId: aliceId }))
      .toMatchObject({ nationality: "TW" });
  });

  it("fails closed when a PROFILE decision has no stored nationality to read", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: {
        ...validBrief,
        quoteNationalityDecision: { source: "PROFILE", confirmProviderUse: true },
      },
    });

    expect(res.statusCode).toBe(422);
    const [persisted] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("DRAFT");
  });

  it("rejects an unknown body field instead of silently dropping it", async () => {
    // The companion to the fix above: with AJV no longer editing the payload,
    // the `.strict()` on every request schema is what refuses extra keys, and
    // it now gets to. A misspelled field must not activate a trip under
    // whatever the server happened to default it to.
    const draftId = await createDraftFor(aliceId, "alice");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/activate`,
      headers: authHeaders("alice"),
      payload: { ...validBrief, travelDatesEnd: "2026-10-20" },
    });

    expect(res.statusCode).toBe(400);
    const [persisted] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, draftId)).limit(1);
    expect(persisted.status).toBe("DRAFT");
  });

  it("does not expose the removed registered-account invitation search endpoint", async () => {
    const draftId = await createDraftFor(aliceId, "alice");
    await app.inject({
      method: "POST", url: `/api/v1/trips/${draftId}/activate`, headers: authHeaders("alice"), payload: validBrief,
    });

    const creatorSearch = await app.inject({
      method: "GET", url: `/api/v1/trips/${draftId}/invitees?q=bo`, headers: authHeaders("alice"),
    });
    expect(creatorSearch.statusCode).toBe(404);

    const nonCreatorSearch = await app.inject({
      method: "GET", url: `/api/v1/trips/${draftId}/invitees?q=bo`, headers: authHeaders("bob"),
    });
    expect(nonCreatorSearch.statusCode).toBe(404);
  });
});
