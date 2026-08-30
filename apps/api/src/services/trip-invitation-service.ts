import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import { chatThreads, sharedTrips, tripInvitations, tripMembers } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import type { RequestContext } from "../utils/context.js";

const TOKEN_BYTES = 32;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Draft teams may form before the creator finalizes the brief. Invitations
// never grant access to another member's private thread or profile, and all
// shared planning commands remain guarded independently.
async function assertTripInvitable(tripId: string): Promise<void> {
  const [trip] = await db.select({ status: sharedTrips.status, archivedAt: sharedTrips.archivedAt })
    .from(sharedTrips)
    .where(eq(sharedTrips.id, tripId))
    .limit(1);
  if (!trip) throw new ApiError(404, "Not Found", "Trip not found");
  if (trip.status === "CANCELLED" || trip.archivedAt) {
    metrics.inc("trip_invitation_rejected_total", { reason: "terminal_trip" });
    throw new ApiError(
      409,
      "Conflict",
      "TRIP_NOT_INVITABLE: archived or cancelled trips cannot accept new members",
    );
  }
}

export type InvitationCreateResult = {
  invitationId: string;
  inviteToken: string;
  expiresAt: Date;
};

export type InvitationAcceptResult = {
  tripId: string;
  defaultThreadId: string;
};

export type InvitationPreviewResult = {
  trip: {
    name: string;
    status: "DRAFT" | "PLANNING" | "CONFIRMED" | "BOOKED" | "CANCELLED" | "STALE";
    destinationCandidates: string[];
    travelDateStart: string | null;
    travelDateEnd: string | null;
  };
  expiresAt: Date;
};

export async function createInvitation(params: {
  ctx: RequestContext;
  tripId: string;
  recipientEmail: string;
  expiresAt: Date;
  actorUserId: string;
}): Promise<InvitationCreateResult> {
  const expiresAt = params.expiresAt;
  if (Number.isNaN(expiresAt.getTime())) {
    throw new ApiError(400, "Bad Request", "expiresAt must be a valid ISO-8601 timestamp");
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, "Bad Request", "expiresAt must be in the future");
  }

  return await db.transaction(async (tx) => {
    await assertTripInvitable(params.tripId);

    const [trip] = await tx.select({ id: sharedTrips.id })
      .from(sharedTrips)
      .where(eq(sharedTrips.id, params.tripId))
      .limit(1);
    if (!trip) throw new ApiError(404, "Not Found", "Trip not found");

    const [membership] = await tx.select({ role: tripMembers.role })
      .from(tripMembers)
      .where(and(eq(tripMembers.tripId, params.tripId), eq(tripMembers.userId, params.actorUserId)))
      .limit(1);
    if (!membership || membership.role !== "CREATOR") {
      throw new ApiError(403, "Forbidden", "Only the trip creator may invite members");
    }

    const recipientEmail = normalizeEmail(params.recipientEmail);
    const recipientEmailHash = hashEmail(recipientEmail);

    await tx.update(tripInvitations).set({ status: "EXPIRED" }).where(and(
      eq(tripInvitations.tripId, params.tripId),
      eq(tripInvitations.recipientEmailHash, recipientEmailHash),
      eq(tripInvitations.status, "PENDING"),
      lt(tripInvitations.expiresAt, new Date()),
    ));

    const [existingPending] = await tx.select({ id: tripInvitations.id })
      .from(tripInvitations)
      .where(and(
        eq(tripInvitations.tripId, params.tripId),
        eq(tripInvitations.recipientEmailHash, recipientEmailHash),
        eq(tripInvitations.status, "PENDING"),
      ))
      .limit(1)
      .for("update");
    if (existingPending) {
      throw new ApiError(409, "Conflict", "A pending invitation already exists for this email address");
    }

    const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = hashToken(rawToken);

    const [created] = await tx.insert(tripInvitations).values({
      tripId: params.tripId,
      recipientEmailHash,
      recipientEmailMasked: maskEmail(recipientEmail),
      invitedByUserId: params.actorUserId,
      status: "PENDING",
      tokenHash,
      expiresAt,
    }).returning();

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_INVITATION_CREATE",
      actorUserId: params.actorUserId,
      tripId: params.tripId,
      summary: {
        invitationId: created.id,
        expiresAt: expiresAt.toISOString(),
      },
      tx,
    });

    return {
      invitationId: created.id,
      inviteToken: rawToken,
      expiresAt,
    };
  });
}

export async function acceptInvitation(params: {
  ctx: RequestContext;
  token: string;
  actorUserId: string;
  actorEmail: string | null;
}): Promise<InvitationAcceptResult> {
  if (typeof params.token !== "string" || params.token.length < 32) {
    throw new ApiError(400, "Bad Request", "Invalid invitation token");
  }
  const tokenHash = hashToken(params.token);

  return await db.transaction(async (tx) => {
    const [invitation] = await tx.select()
      .from(tripInvitations)
      .where(eq(tripInvitations.tokenHash, tokenHash))
      .limit(1);
    if (!invitation) {
      throw new ApiError(404, "Not Found", "Invitation not found");
    }

    await assertTripInvitable(invitation.tripId);

    // Reject when caller is not the invited user; never 404 in place of
    // 403 to avoid enumeration.
    if (!constantTimeEquals(invitation.tokenHash, tokenHash)) {
      throw new ApiError(404, "Not Found", "Invitation not found");
    }

    if (!matchesRecipient(invitation, params.actorUserId, params.actorEmail)) {
      throw new ApiError(403, "Forbidden", "This invitation is for a different account");
    }

    if (invitation.status === "REVOKED") {
      throw new ApiError(410, "Gone", "Invitation has been revoked");
    }
    if (invitation.status === "DECLINED") {
      throw new ApiError(410, "Gone", "Invitation has been declined");
    }
    if (invitation.status === "ACCEPTED") {
      // Idempotent: already accepted → return the existing default
      // thread for this (owner, trip) without writing a new audit row.
      const [existingDefault] = await tx.select({ id: chatThreads.id })
        .from(chatThreads)
        .where(and(
          eq(chatThreads.tripId, invitation.tripId),
          eq(chatThreads.ownerUserId, params.actorUserId),
          eq(chatThreads.isDefault, true),
          sql`${chatThreads.archivedAt} IS NULL`,
        ))
        .limit(1);
      if (!existingDefault) {
        // Should not happen: acceptance always provisions a default
        // thread.  Surface as internal to avoid silent recovery.
        throw new ApiError(500, "Internal Server Error", "Default thread missing for accepted invitation");
      }
      return { tripId: invitation.tripId, defaultThreadId: existingDefault.id };
    }
    if (invitation.status === "EXPIRED") {
      throw new ApiError(410, "Gone", "Invitation has expired");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await tx.update(tripInvitations).set({ status: "EXPIRED" })
        .where(eq(tripInvitations.id, invitation.id));
      throw new ApiError(410, "Gone", "Invitation has expired");
    }

    // upsert membership (idempotent on re-accept after PENDING recovery)
    const [existingMembership] = await tx.select({ id: tripMembers.id })
      .from(tripMembers)
      .where(and(eq(tripMembers.tripId, invitation.tripId), eq(tripMembers.userId, params.actorUserId)))
      .limit(1);
    if (!existingMembership) {
      await tx.insert(tripMembers).values({
        tripId: invitation.tripId,
        userId: params.actorUserId,
        role: "MEMBER",
        isRequired: true,
      }).onConflictDoNothing();
    }

    const defaultThreadId = await getOrCreateDefaultThread(tx, {
      tripId: invitation.tripId,
      ownerUserId: params.actorUserId,
    });

    await tx.update(tripInvitations)
      .set({ status: "ACCEPTED", acceptedAt: new Date() })
      .where(eq(tripInvitations.id, invitation.id));

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_INVITATION_ACCEPT",
      actorUserId: params.actorUserId,
      tripId: invitation.tripId,
      summary: { invitationId: invitation.id },
      tx,
    });
    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_DEFAULT_THREAD_PROVISION",
      actorUserId: params.actorUserId,
      tripId: invitation.tripId,
      summary: {
        threadId: defaultThreadId,
        invitationId: invitation.id,
      },
      tx,
    });

    return { tripId: invitation.tripId, defaultThreadId };
  });
}

/**
 * Reads only decision-critical invitation data after both token and account
 * binding have been verified. Invalid, expired, and wrong-account tokens all
 * produce the same unavailable response to avoid leaking trip metadata.
 */
export async function getInvitationPreview(params: {
  token: string;
  actorUserId: string;
  actorEmail: string | null;
}): Promise<InvitationPreviewResult> {
  const invitation = await getPendingInvitationForActor(params);
  const [trip] = await db.select({
    name: sharedTrips.name,
    status: sharedTrips.status,
    destinationCandidates: sharedTrips.destinationCandidates,
    travelDateStart: sharedTrips.travelDateStart,
    travelDateEnd: sharedTrips.travelDateEnd,
  }).from(sharedTrips).where(eq(sharedTrips.id, invitation.tripId)).limit(1);
  if (!trip || trip.status === "CANCELLED") throw invitationUnavailable();
  return {
    trip: {
      name: trip.name,
      status: trip.status,
      // An invitee can decide whether to join a Draft, but must not see its
      // creator's unconfirmed exploration details before accepting.
      destinationCandidates: trip.status === "DRAFT" ? [] : trip.destinationCandidates,
      travelDateStart: trip.status === "DRAFT" ? null : trip.travelDateStart,
      travelDateEnd: trip.status === "DRAFT" ? null : trip.travelDateEnd,
    },
    expiresAt: invitation.expiresAt,
  };
}

export async function declineInvitation(params: {
  ctx: RequestContext;
  token: string;
  actorUserId: string;
  actorEmail: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const invitation = await getPendingInvitationForActor(params, tx);
    await tx.update(tripInvitations)
      .set({ status: "DECLINED", declinedAt: new Date() })
      .where(eq(tripInvitations.id, invitation.id));
    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_INVITATION_DECLINE",
      actorUserId: params.actorUserId,
      tripId: invitation.tripId,
      summary: { invitationId: invitation.id },
      tx,
    });
  });
}

export async function revokeInvitation(params: {
  ctx: RequestContext;
  invitationId: string;
  actorUserId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invitation] = await tx.select()
      .from(tripInvitations)
      .where(eq(tripInvitations.id, params.invitationId))
      .limit(1);
    if (!invitation) throw new ApiError(404, "Not Found", "Invitation not found");

    const [membership] = await tx.select({ role: tripMembers.role })
      .from(tripMembers)
      .where(and(eq(tripMembers.tripId, invitation.tripId), eq(tripMembers.userId, params.actorUserId)))
      .limit(1);
    if (!membership || membership.role !== "CREATOR") {
      throw new ApiError(403, "Forbidden", "Only the trip creator may revoke invitations");
    }

    if (invitation.status !== "PENDING") {
      throw new ApiError(409, "Conflict", `Cannot revoke invitation in status ${invitation.status}`);
    }

    await tx.update(tripInvitations)
      .set({ status: "REVOKED", revokedAt: new Date() })
      .where(eq(tripInvitations.id, invitation.id));

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_INVITATION_REVOKE",
      actorUserId: params.actorUserId,
      tripId: invitation.tripId,
      summary: { invitationId: invitation.id },
      tx,
    });
  });
}

export async function getOrCreateDefaultThread(
  tx: Tx,
  params: { tripId: string; ownerUserId: string },
): Promise<string> {
  const [existing] = await tx.select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.tripId, params.tripId),
      eq(chatThreads.ownerUserId, params.ownerUserId),
      eq(chatThreads.isDefault, true),
      sql`${chatThreads.archivedAt} IS NULL`,
    ))
    .limit(1);
  if (existing) return existing.id;

  // Partial unique index on (owner_user_id, trip_id) WHERE is_default AND
  // archived_at IS NULL guards against duplicates; ON CONFLICT DO NOTHING
  // lets concurrent accepts converge to one row.
  await tx.insert(chatThreads).values({
    ownerUserId: params.ownerUserId,
    tripId: params.tripId,
    scope: "TRIP",
    isDefault: true,
    title: "Personal trip scratchpad",
  }).onConflictDoNothing();

  const [after] = await tx.select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.tripId, params.tripId),
      eq(chatThreads.ownerUserId, params.ownerUserId),
      eq(chatThreads.isDefault, true),
      sql`${chatThreads.archivedAt} IS NULL`,
    ))
    .limit(1);
  if (!after) {
    throw new ApiError(500, "Internal Server Error", "Failed to provision default thread");
  }
  return after.id;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

type InvitationReader = Pick<typeof db, "select">;

async function getPendingInvitationForActor(
  params: { token: string; actorUserId: string; actorEmail: string | null },
  reader: InvitationReader = db,
) {
  if (typeof params.token !== "string" || params.token.length < 32) throw invitationUnavailable();
  const tokenHash = hashToken(params.token);
  const [invitation] = await reader.select().from(tripInvitations)
    .where(eq(tripInvitations.tokenHash, tokenHash)).limit(1);
  if (!invitation || !matchesRecipient(invitation, params.actorUserId, params.actorEmail)) throw invitationUnavailable();
  if (invitation.status !== "PENDING" || invitation.expiresAt.getTime() <= Date.now()) {
    throw invitationUnavailable();
  }
  return invitation;
}

function invitationUnavailable(): ApiError {
  return new ApiError(404, "Not Found", "Invitation is unavailable");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new ApiError(400, "Bad Request", "recipientEmail must be a valid email address");
  }
  return normalized;
}

function hashEmail(email: string): string {
  const secret = process.env.INVITATION_EMAIL_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError(503, "Service Unavailable", "Invitation email protection is not configured");
  }
  return createHmac("sha256", secret).update(email).digest("hex");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, local.length - 1))}@${domain}`;
}

function matchesRecipient(invitation: typeof tripInvitations.$inferSelect, actorUserId: string, actorEmail: string | null): boolean {
  if (invitation.recipientEmailHash) {
    if (!actorEmail) return false;
    return constantTimeEquals(invitation.recipientEmailHash, hashEmail(normalizeEmail(actorEmail)));
  }
  return invitation.invitedUserId === actorUserId;
}
