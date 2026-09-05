import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  constraintSnapshots,
  itineraryPlans,
  sharedTrips,
  staySearchProviderAuthorizations,
  tripMembers,
  userProfiles,
  preferenceFacts,
  users,
} from "../src/db/schema.js";
import {
  grantQuoteNationality,
  loadActiveQuoteNationality,
  listStaySearchAuthorizations,
  revokeQuoteNationality,
} from "../src/services/stay-search-provider-authorization.js";
import { __setQuoteNationalityCipherForTests } from "../src/services/quote-nationality-cipher.js";
import { eq } from "drizzle-orm";
import { applyQuoteNationalityDecision } from "../src/services/quote-nationality-decision-service.js";
import { createRequestContext } from "../src/utils/context.js";

describe("stay-search-provider-authorization", () => {
  let ownerId: string;
  let tripId: string;

  beforeEach(async () => {
    __setQuoteNationalityCipherForTests({
      encrypt: async (value) => Buffer.from(`test:${value}:opaque-test-padding`).toString("base64"),
      decrypt: async (value) => Buffer.from(value, "base64").toString("utf8").replace(/^test:|:opaque-test-padding$/g, ""),
    });
    const [owner] = await db.insert(users).values({
      externalId: `auth-${randomUUID()}`,
      displayName: "Auth owner",
    }).returning();
    ownerId = owner.id;
    const [trip] = await db.insert(sharedTrips).values({
      name: "Auth trip",
      createdBy: ownerId,
      authorizedData: {},
      departureCities: ["Shanghai"],
      destinationCandidates: ["Paris"],
    }).returning();
    tripId = trip.id;
    await db.insert(tripMembers).values({ tripId, userId: ownerId, role: "CREATOR", isRequired: true });
  });

  afterEach(async () => {
    __setQuoteNationalityCipherForTests(undefined);
    await db.delete(staySearchProviderAuthorizations).where(eq(staySearchProviderAuthorizations.tripId, tripId));
    await db.delete(auditEvents).where(eq(auditEvents.tripId, tripId));
    await db.delete(agentTaskRuns).where(eq(agentTaskRuns.tripId, tripId));
    await db.delete(itineraryPlans).where(eq(itineraryPlans.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
    // Profile-to-memory synchronization records a privacy-safe audit without a
    // trip id. Clear every event created by this isolated actor before the
    // user row, otherwise the audit FK correctly prevents teardown.
    await db.delete(auditEvents).where(eq(auditEvents.actorUserId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
  });

  it("encrypts the nationality at rest and decrypts only on read", async () => {
    const granted = await grantQuoteNationality({ tripId, memberId: ownerId, value: "us" });
    expect(granted).toMatchObject({ id: expect.any(String), version: 1 });

    const stored = await db.select().from(staySearchProviderAuthorizations)
      .where(eq(staySearchProviderAuthorizations.id, granted.id));
    expect(stored).toHaveLength(1);
    expect(stored[0].valueEncrypted).not.toContain("US");
    expect(stored[0].valueEncrypted).not.toContain("us");

    const loaded = await loadActiveQuoteNationality({ tripId, memberId: ownerId });
    expect(loaded?.nationality).toBe("US");
    expect(loaded?.version).toBe(1);
  });

  it("saves an explicitly entered nationality to the private Profile and grants this trip", async () => {
    await db.transaction((tx) => applyQuoteNationalityDecision({
      ctx: createRequestContext(ownerId),
      tripId,
      userId: ownerId,
      decision: {
        source: "INPUT",
        value: "sg",
        saveToProfile: true,
        confirmProviderUse: true,
      },
      tx,
    }));

    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId));
    expect(profile.nationality).toBe("SG");
    const facts = await db.select().from(preferenceFacts).where(eq(preferenceFacts.userId, ownerId));
    expect(facts.some((fact) => fact.fieldKey === "nationality" && fact.status === "ACTIVE")).toBe(true);
    expect((await loadActiveQuoteNationality({ tripId, memberId: ownerId }))?.nationality).toBe("SG");

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.tripId, tripId));
    expect(audits.map((event) => event.action)).toEqual(expect.arrayContaining([
      "PROFILE_CREATE",
      "HOTEL_PROVIDER_GRANTED",
    ]));
    expect(JSON.stringify(audits.map((event) => event.summary))).not.toContain('"SG"');
  });

  it("can keep an entered nationality trip-scoped without creating a Profile", async () => {
    await db.transaction((tx) => applyQuoteNationalityDecision({
      ctx: createRequestContext(ownerId),
      tripId,
      userId: ownerId,
      decision: {
        source: "INPUT",
        value: "jp",
        saveToProfile: false,
        confirmProviderUse: true,
      },
      tx,
    }));

    expect(await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId))).toHaveLength(0);
    expect((await loadActiveQuoteNationality({ tripId, memberId: ownerId }))?.nationality).toBe("JP");
  });

  it("uses a stored Profile value only after an explicit provider-use confirmation", async () => {
    await db.insert(userProfiles).values({ userId: ownerId, nationality: "DE" });
    await db.transaction((tx) => applyQuoteNationalityDecision({
      ctx: createRequestContext(ownerId),
      tripId,
      userId: ownerId,
      decision: { source: "PROFILE", confirmProviderUse: true },
      tx,
    }));

    expect((await loadActiveQuoteNationality({ tripId, memberId: ownerId }))?.nationality).toBe("DE");
  });

  it("fails closed when PROFILE is confirmed but no nationality is stored", async () => {
    await expect(db.transaction((tx) => applyQuoteNationalityDecision({
      ctx: createRequestContext(ownerId),
      tripId,
      userId: ownerId,
      decision: { source: "PROFILE", confirmProviderUse: true },
      tx,
    }))).rejects.toMatchObject({ statusCode: 422 });

    expect(await listStaySearchAuthorizations({ tripId, memberId: ownerId })).toEqual([]);
  });

  it("revokes the prior ACTIVE row on a new grant and bumps the version", async () => {
    const first = await grantQuoteNationality({ tripId, memberId: ownerId, value: "CN" });
    const second = await grantQuoteNationality({ tripId, memberId: ownerId, value: "JP" });

    expect(second.version).toBeGreaterThan(first.version);
    const rows = await db.select().from(staySearchProviderAuthorizations)
      .where(eq(staySearchProviderAuthorizations.tripId, tripId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    const loaded = await loadActiveQuoteNationality({ tripId, memberId: ownerId });
    expect(loaded?.nationality).toBe("JP");
  });

  it("returns null when no authorization is active", async () => {
    const loaded = await loadActiveQuoteNationality({ tripId, memberId: ownerId });
    expect(loaded).toBeNull();
  });

  it("revokes by id and rejects unknown ids", async () => {
    const granted = await grantQuoteNationality({ tripId, memberId: ownerId, value: "DE" });
    await revokeQuoteNationality({ tripId, memberId: ownerId, authorizationId: granted.id });
    const loaded = await loadActiveQuoteNationality({ tripId, memberId: ownerId });
    expect(loaded).toBeNull();

    await expect(revokeQuoteNationality({
      tripId, memberId: ownerId, authorizationId: randomUUID(),
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("respects expiresAt and refuses expired grants", async () => {
    const past = new Date(Date.now() - 60_000);
    await grantQuoteNationality({ tripId, memberId: ownerId, value: "FR", expiresAt: past });
    const loaded = await loadActiveQuoteNationality({ tripId, memberId: ownerId });
    expect(loaded).toBeNull();
  });

  it("normalizes nationality to uppercase ISO-3166-1 alpha-2 and rejects invalid codes", async () => {
    await expect(grantQuoteNationality({ tripId, memberId: ownerId, value: "USA" }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(grantQuoteNationality({ tripId, memberId: ownerId, value: "12" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("never echoes the nationality in list responses", async () => {
    await grantQuoteNationality({ tripId, memberId: ownerId, value: "SG" });
    const listed = await listStaySearchAuthorizations({ tripId, memberId: ownerId });
    expect(listed).toHaveLength(1);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("SG");
    expect(serialized).not.toContain("valueEncrypted");
  });

  it("stales dependent plans on grant and revoke", async () => {
    const [snapshot] = await db.insert(constraintSnapshots).values({
      tripId,
      version: 1,
      authorizedData: {},
      departureCities: ["Shanghai"],
      destinationCandidates: ["Paris"],
    }).returning();
    const [plan] = await db.insert(itineraryPlans).values({
      tripId,
      snapshotId: snapshot.id,
      status: "ACTIVE",
      destination: "Paris",
      planData: {},
      generatedByUserId: ownerId,
    }).returning();
    await grantQuoteNationality({ tripId, memberId: ownerId, value: "GB" });
    const [afterGrant] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, plan.id));
    expect(afterGrant.status).toBe("STALE");

    // Reset to ACTIVE and revoke.
    await db.update(itineraryPlans).set({ status: "ACTIVE", staleReason: null })
      .where(eq(itineraryPlans.id, plan.id));
    const active = await listStaySearchAuthorizations({ tripId, memberId: ownerId });
    await revokeQuoteNationality({ tripId, memberId: ownerId, authorizationId: active[0].id });
    const [afterRevoke] = await db.select().from(itineraryPlans).where(eq(itineraryPlans.id, plan.id));
    expect(afterRevoke.status).toBe("STALE");
  });
});
