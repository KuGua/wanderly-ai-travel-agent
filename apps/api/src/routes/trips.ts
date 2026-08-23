import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { createTripSchema } from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";
import { recordAudit } from "../services/audit-service.js";

export async function tripRoutes(app: FastifyInstance) {
  // Create trip
  app.post("/trips", {
    
      

  }, async (request, reply) => {
    const ctx = createRequestContext(request.user.id);
    const body = createTripSchema.parse(request.body);

    const [trip] = await db.insert(sharedTrips).values({
      name: body.name,
      createdBy: request.user.id,
      departureCities: body.departureCities,
      destinationCandidates: body.destinationCandidates,
      travelDateStart: body.travelDateStart,
      travelDateEnd: body.travelDateEnd,
    }).returning();

    // Add creator as member
    await db.insert(tripMembers).values({
      tripId: trip.id,
      userId: request.user.id,
      role: "CREATOR",
      isRequired: true,
    });

    // Add other members
    for (const userId of body.memberUserIds) {
      if (userId !== request.user.id) {
        await db.insert(tripMembers).values({
          tripId: trip.id,
          userId,
          role: "MEMBER",
          isRequired: true,
        });
      }
    }

    await recordAudit({
      ctx,
      action: "TRIP_CREATE",
      actorUserId: request.user.id,
      tripId: trip.id,
      summary: { name: body.name, memberCount: body.memberUserIds.length + 1 },
    });

    reply.code(201).send({ id: trip.id, message: "Trip created" });
  });

  // Join trip
  app.post("/trips/:tripId/join", async (request, reply) => {
    const ctx = createRequestContext(request.user.id);
    const { tripId } = request.params as { tripId: string };

    // Check trip exists
    const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    if (!trip) {
      reply.code(404).send({ statusCode: 404, error: "Not Found", message: "Trip not found" });
      return;
    }

    // Check if already member
    const existing = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (existing.length > 0) {
      reply.code(409).send({ statusCode: 409, error: "Conflict", message: "Already a member" });
      return;
    }

    await db.insert(tripMembers).values({
      tripId,
      userId: request.user.id,
      role: "MEMBER",
      isRequired: true,
    });

    await recordAudit({
      ctx,
      action: "TRIP_JOIN",
      actorUserId: request.user.id,
      tripId,
    });

    return { message: "Joined trip" };
  });

  // Get trip details
  app.get("/trips/:tripId", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };

    // Check membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Not a member of this trip" });
      return;
    }

    const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    const members = await db.select().from(tripMembers).where(eq(tripMembers.tripId, tripId));

    return { trip, members };
  });
}
