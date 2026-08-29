import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { userProfiles } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  createProfileSchema,
  errorResponseSchema,
  profileResponseSchema,
  toJsonSchema,
  updateProfileResponseSchema,
  updateProfileSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";
import {
  deleteProfileFormMemory,
  syncProfileFormToMemory,
} from "../services/profile-form-memory.js";
import { recordAudit } from "../services/audit-service.js";
import { ApiError } from "../middleware/error-handler.js";

type ProfileRecord = typeof userProfiles.$inferSelect;

function serializeProfile(profile: ProfileRecord, displayName: string) {
  return {
    id: profile.id,
    userId: profile.userId,
    displayName,
    nationality: profile.nationality,
    dateOfBirth: profile.dateOfBirth,
    interests: profile.interests,
    accommodationStyle: profile.accommodationStyle,
    budgetMaxUsd: profile.budgetMaxUsd,
    noRedEye: profile.noRedEye,
    mobilityNotes: profile.mobilityNotes,
    availableDepartureDates: profile.availableDepartureDates,
    departureCity: profile.departureCity,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function profileRoutes(app: FastifyInstance) {
  // Create profile
  app.post("/profiles", async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = createProfileSchema.parse(request.body);

    const [profile] = await db.insert(userProfiles).values({
      userId: request.user.id,
      ...body,
    }).returning();

    // The form is where a user states a preference outright, and a stated
    // preference is what memory is built from — the columns alone are not
    // projected anywhere.
    await syncProfileFormToMemory({
      ctx, userId: request.user.id, profileId: profile.id, body,
    });

    await recordAudit({
      ctx,
      action: "PROFILE_CREATE",
      actorUserId: request.user.id,
      summary: { profileId: profile.id },
    });

    reply.code(201).send({ id: profile.id, userId: profile.userId, message: "Profile created" });
  });

  // Get my profile
  app.get("/profiles/me", {
    schema: {
      description: "Return the authenticated user's private profile with sensitive document data redacted.",
      response: {
        200: toJsonSchema(profileResponseSchema),
        401: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const profiles = await db.select().from(userProfiles)
      .where(eq(userProfiles.userId, request.user.id))
      .limit(1);

    if (profiles.length === 0) {
      return { profile: null };
    }

    return profileResponseSchema.parse({
      profile: serializeProfile(profiles[0], request.user.displayName),
    });
  });

  // Update my profile
  app.put("/profiles/me", {
    schema: {
      description: "Partially update the authenticated user's private profile.",
      body: toJsonSchema(updateProfileSchema),
      response: {
        200: toJsonSchema(updateProfileResponseSchema),
        400: toJsonSchema(errorResponseSchema),
        401: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
    preValidation: async (request) => {
      request.body = updateProfileSchema.parse(request.body);
    },
  }, async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = updateProfileSchema.parse(request.body);

    const existing = await db.select().from(userProfiles)
      .where(eq(userProfiles.userId, request.user.id))
      .limit(1);

    if (existing.length === 0) {
      throw new ApiError(404, "Not Found", "Profile not found");
    }

    const [updatedProfile] = await db.update(userProfiles)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(userProfiles.userId, request.user.id))
      .returning();

    await syncProfileFormToMemory({
      ctx, userId: request.user.id, profileId: updatedProfile.id, body,
    });

    await recordAudit({
      ctx,
      action: "PROFILE_UPDATE",
      actorUserId: request.user.id,
      summary: { updatedFields: Object.keys(body) },
    });

    return updateProfileResponseSchema.parse({
      message: "Profile updated",
      profile: serializeProfile(updatedProfile, request.user.displayName),
    });
  });

  // Delete my profile
  app.delete("/profiles/me", async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);

    // Facts cannot outlive the profile they describe; left behind they would
    // keep projecting into trips after the user asked for deletion.
    await deleteProfileFormMemory({ userId: request.user.id });
    await db.delete(userProfiles).where(eq(userProfiles.userId, request.user.id));

    await recordAudit({
      ctx,
      action: "PROFILE_DELETE",
      actorUserId: request.user.id,
    });

    return { message: "Profile deleted" };
  });
}
