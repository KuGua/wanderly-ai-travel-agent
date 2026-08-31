import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  auditEvents,
  bookingExecutions,
  chatThreads,
  constraintSnapshots,
  consentGrants,
  destinationCandidates,
  idempotencyRecords,
  itineraryPlans,
  memberConfirmations,
  preferenceFacts,
  providerOffers,
  sharedTrips,
  sourceEvidence,
  tripMembers,
  tripInvitations,
  users,
  visaReadinessChecks,
  agentTaskRuns,
} from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

const originalInvitationSecret = process.env.INVITATION_EMAIL_HMAC_SECRET;
process.env.INVITATION_EMAIL_HMAC_SECRET = "test-invitation-email-hmac-secret-please-rotate-32+chars";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  // Ensure both `alice` and `bob` users exist so `authHeaders("alice")`
  // resolves a known identity in the draft-guard tests and the non-creator
  // invitation test uses a recipient email; it must not enumerate Bob's account.
  for (const [subject, email] of [["alice", "alice@example.com"], ["bob", "bob@example.com"]] as const) {
    const [existing] = await db.select().from(users)
      .where(eq(users.externalId, subject)).limit(1);
    if (existing) {
      if (existing.email !== email) {
        await db.update(users).set({ email }).where(eq(users.id, existing.id));
      }
      continue;
    }
    await db.insert(users).values({
      externalId: subject,
      displayName: subject.charAt(0).toUpperCase() + subject.slice(1),
      email,
    });
  }
});

afterAll(async () => {
  await app.close();
  if (originalInvitationSecret === undefined) delete process.env.INVITATION_EMAIL_HMAC_SECRET;
  else process.env.INVITATION_EMAIL_HMAC_SECRET = originalInvitationSecret;
});

beforeEach(async () => {
  // Order matters: clear leaf tables before their parents so FK cascades
  // from `shared_trips` (e.g. → `constraint_snapshots`) are not blocked by
  // rows in `provider_offers` / `visa_readiness_checks` left over from
  // sibling test files (the test DB is shared across files in one run).
  await db.delete(bookingExecutions);
  await db.delete(providerOffers);
  await db.delete(sourceEvidence);
  await db.delete(visaReadinessChecks);
  await db.delete(auditEvents);
  await db.delete(itineraryPlans);
  await db.delete(agentTaskRuns);
  await db.delete(destinationCandidates);
  await db.delete(constraintSnapshots);
  await db.delete(idempotencyRecords);
  await db.delete(memberConfirmations);
  await db.delete(preferenceFacts);
  await db.delete(consentGrants);
  await db.delete(tripInvitations);
  await db.delete(tripMembers);
  await db.delete(chatThreads);
  await db.delete(sharedTrips);
});

async function createDraftFor(externalId: "alice" | "bob"): Promise<string> {
  const start = await app.inject({
    method: "POST",
    url: "/api/v1/explorations/start",
    headers: authHeaders(externalId),
    payload: { requestId: randomUUID() },
  });
  expect(start.statusCode).toBe(201);
  return start.json().trip.id;
}

describe("Draft trip command guards", () => {
  it("POST /consent/grant returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consent/grant",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        scope: "PROFILE_BASIC",
        fieldList: ["displayName"],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/TRIP_NOT_ACTIVE/);

    const rows = await db.select().from(consentGrants);
    expect(rows).toHaveLength(0);
  });

  it("POST /consent/revoke returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consent/revoke",
      headers: authHeaders("alice"),
      payload: { tripId: draftId, scope: "PROFILE_BASIC" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("GET /consent/:tripId/me returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/consent/${draftId}/me`,
      headers: authHeaders("alice"),
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /planning/generate returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/planning/generate",
      headers: authHeaders("alice"),
      payload: { tripId: draftId },
    });
    expect(res.statusCode).toBe(409);
    const plans = await db.select().from(itineraryPlans);
    expect(plans).toHaveLength(0);
  });

  it("POST /change-events returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/change-events",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        eventId: randomUUID(),
        eventType: "PRICE_CHANGE",
        payload: {},
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /confirmations returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/confirmations",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        planId: randomUUID(),
        decision: "CONFIRMED",
      },
    });
    expect(res.statusCode).toBe(409);
    const rows = await db.select().from(memberConfirmations);
    expect(rows).toHaveLength(0);
  });

  it("POST /bookings returns 409 TRIP_NOT_ACTIVE on a DRAFT", async () => {
    const draftId = await createDraftFor("alice");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bookings",
      headers: authHeaders("alice"),
      payload: {
        tripId: draftId,
        planId: randomUUID(),
        orchestrationRequestId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(409);
    const rows = await db.select().from(bookingExecutions);
    expect(rows).toHaveLength(0);
  });

  it("Draft collaboration guards never write audit rows", async () => {
    const draftId = await createDraftFor("alice");

    // Hit every guarded route; all should reject.
    const requests = [
      app.inject({
        method: "POST",
        url: "/api/v1/consent/grant",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, scope: "PROFILE_BASIC", fieldList: ["displayName"] },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/consent/revoke",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, scope: "PROFILE_BASIC" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/planning/generate",
        headers: authHeaders("alice"),
        payload: { tripId: draftId },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/confirmations",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, planId: randomUUID(), decision: "CONFIRMED" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/bookings",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, planId: randomUUID(), orchestrationRequestId: randomUUID() },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/change-events",
        headers: authHeaders("alice"),
        payload: { tripId: draftId, eventId: randomUUID(), eventType: "PRICE_CHANGE", payload: {} },
      }),
    ];
    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.statusCode).toBe(409);
    }

    // Only the EXPLORATION_START and TRIP_DEFAULT_THREAD_PROVISION rows
    // from creating the draft are present. No new audit events.
    const audits = await db.select().from(auditEvents)
      .where(eq(auditEvents.tripId, draftId));
    expect(audits.map((row) => row.action).sort())
      .toEqual(["EXPLORATION_START", "TRIP_DEFAULT_THREAD_PROVISION"]);
  });

  it("allows an email-bound invitation to a Draft without exposing the creator's private conversation", async () => {
    const draftId = await createDraftFor("alice");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/invitations`,
      headers: authHeaders("alice"),
      payload: {
        recipientEmail: "bob@example.com",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    const inviteToken = res.json().inviteToken as string;

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/trip-invitations/${inviteToken}`,
      headers: authHeaders("bob"),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().trip).toMatchObject({ status: "DRAFT", destinationCandidates: [] });

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/trip-invitations/${inviteToken}/accept`,
      headers: authHeaders("bob"),
    });
    expect(accepted.statusCode).toBe(200);

    const [creatorThread] = await db.select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.tripId, draftId))
      .limit(1);
    const privateConversation = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${creatorThread.id}/conversation`,
      headers: authHeaders("bob"),
    });
    expect(privateConversation.statusCode).toBe(403);

    const members = await db.select().from(tripMembers).where(eq(tripMembers.tripId, draftId));
    expect(members).toHaveLength(2);
  });

  it("rejects new invitations and acceptance against cancelled or archived trips", async () => {
    const draftId = await createDraftFor("alice");

    const create = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/invitations`,
      headers: authHeaders("alice"),
      payload: {
        recipientEmail: "bob@example.com",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(create.statusCode).toBe(201);
    const inviteToken = create.json().inviteToken as string;

    // Cancelling the trip must reject both new invitations and pending acceptance.
    await db.update(sharedTrips).set({ status: "CANCELLED" }).where(eq(sharedTrips.id, draftId));

    const followUpCreate = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/invitations`,
      headers: authHeaders("alice"),
      payload: {
        recipientEmail: "carol@example.com",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(followUpCreate.statusCode, JSON.stringify(followUpCreate.json())).toBe(409);
    expect(followUpCreate.json().message).toMatch(/TRIP_NOT_INVITABLE/);

    const lateAccept = await app.inject({
      method: "POST",
      url: `/api/v1/trip-invitations/${inviteToken}/accept`,
      headers: authHeaders("bob"),
    });
    expect(lateAccept.statusCode).toBe(409);
    expect(lateAccept.json().message).toMatch(/TRIP_NOT_INVITABLE/);
  });

  it("does not disclose a pending invitation after its Draft trip is archived", async () => {
    const draftId = await createDraftFor("alice");
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/trips/${draftId}/invitations`,
      headers: authHeaders("alice"),
      payload: {
        recipientEmail: "bob@example.com",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(create.statusCode).toBe(201);
    const inviteToken = create.json().inviteToken as string;

    await db.update(sharedTrips)
      .set({ archivedAt: new Date(), archiveReason: "USER_ARCHIVED" })
      .where(eq(sharedTrips.id, draftId));

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/trip-invitations/${inviteToken}`,
      headers: authHeaders("bob"),
    });
    expect(preview.statusCode).toBe(404);

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/trip-invitations/${inviteToken}/accept`,
      headers: authHeaders("bob"),
    });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().message).toMatch(/TRIP_NOT_INVITABLE/);
  });
});
