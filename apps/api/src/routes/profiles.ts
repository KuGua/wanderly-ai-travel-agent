import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { userProfiles } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createProfileSchema, updateProfileSchema } from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";
import { recordAudit } from "../services/audit-service.js";

export async function profileRoutes(app: FastifyInstance) {
  // Create profile
  app.post("/profiles", async (request, reply) => {
    const ctx = createRequestContext(request.user.id);
    const body = createProfileSchema.parse(request.body);

    const [profile] = await db.insert(userProfiles).values({
      userId: request.user.id,
      ...body,
    }).returning();

    await recordAudit({
      ctx,
      action: "PROFILE_CREATE",
      actorUserId: request.user.id,
      summary: { profileId: profile.id },
    });

    reply.code(201).send({ id: profile.id, userId: profile.userId, message: "Profile created" });
  });

  // Get my profile
  app.get("/profiles/me", async (request) => {
    const profiles = await db.select().from(userProfiles)
      .where(eq(userProfiles.userId, request.user.id))
      .limit(1);

    if (profiles.length === 0) {
      return { profile: null };
    }

    // Redact sensitive fields
    const { passportNumber, ...safeProfile } = profiles[0];
    return { profile: safeProfile };
  });

  // Update my profile
  app.put("/profiles/me", {
    
      

  }, async (request, reply) => {
    const ctx = createRequestContext(request.user.id);
    const body = updateProfileSchema.parse(request.body);

    const existing = await db.select().from(userProfiles)
      .where(eq(userProfiles.userId, request.user.id))
      .limit(1);

    if (existing.length === 0) {
      reply.code(404).send({ statusCode: 404, error: "Not Found", message: "Profile not found" });
      return;
    }

    await db.update(userProfiles)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(userProfiles.userId, request.user.id));

    await recordAudit({
      ctx,
      action: "PROFILE_UPDATE",
      actorUserId: request.user.id,
      summary: { updatedFields: Object.keys(body) },
    });

    return { message: "Profile updated" };
  });

  // Delete my profile
  app.delete("/profiles/me", async (request) => {
    const ctx = createRequestContext(request.user.id);

    await db.delete(userProfiles).where(eq(userProfiles.userId, request.user.id));

    await recordAudit({
      ctx,
      action: "PROFILE_DELETE",
      actorUserId: request.user.id,
    });

    return { message: "Profile deleted" };
  });
}
