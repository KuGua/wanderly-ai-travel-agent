import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers, users } from "../db/schema.js";
import { eq, and, asc, count, desc, inArray } from "drizzle-orm";
import {
  createTripSchema,
  errorResponseSchema,
  toJsonSchema,
  tripDetailsResponseSchema,
  tripsResponseSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";
import { recordAudit } from "../services/audit-service.js";
import { ApiError } from "../middleware/error-handler.js";

export async function tripRoutes(app: FastifyInstance) {
  // List only trips visible to the authenticated member.
  app.get("/trips", {
    schema: {
      description: "List trips where the authenticated user is a member.",
      response: {
        200: toJsonSchema(tripsResponseSchema),
        401: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const memberships = await db.select({
      id: sharedTrips.id,
      name: sharedTrips.name,
      status: sharedTrips.status,
      departureCities: sharedTrips.departureCities,
      destinationCandidates: sharedTrips.destinationCandidates,
      travelDateStart: sharedTrips.travelDateStart,
      travelDateEnd: sharedTrips.travelDateEnd,
      role: tripMembers.role,
      createdAt: sharedTrips.createdAt,
    })
      .from(tripMembers)
      .innerJoin(sharedTrips, eq(sharedTrips.id, tripMembers.tripId))
      .where(eq(tripMembers.userId, request.user.id))
      .orderBy(desc(sharedTrips.createdAt), asc(sharedTrips.id));

    const tripIds = memberships.map(membership => membership.id);
    const memberCounts = tripIds.length === 0
      ? []
      : await db.select({
        tripId: tripMembers.tripId,
        memberCount: count(),
      })
        .from(tripMembers)
        .where(inArray(tripMembers.tripId, tripIds))
        .groupBy(tripMembers.tripId);
    const memberCountByTrip = new Map(memberCounts.map(row => [row.tripId, Number(row.memberCount)]));

    return tripsResponseSchema.parse({
      trips: memberships.map(membership => ({
        ...membership,
        memberCount: memberCountByTrip.get(membership.id) ?? 0,
        createdAt: membership.createdAt.toISOString(),
      })),
    });
  });

  // Create trip
  app.post("/trips", {
    
      

  }, async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId);
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
  app.post("/trips/:tripId/join", async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId);
    const { tripId } = request.params as { tripId: string };

    // Check trip exists
    const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    if (!trip) {
      throw new ApiError(404, "Not Found", "Trip not found");
    }

    // Check if already member
    const existing = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (existing.length > 0) {
      throw new ApiError(409, "Conflict", "Already a member");
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
  app.get("/trips/:tripId", {
    schema: {
      description: "Return trip details and safe member presentation data to a trip member.",
      response: {
        200: toJsonSchema(tripDetailsResponseSchema),
        401: toJsonSchema(errorResponseSchema),
        403: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { tripId } = request.params as { tripId: string };

    // Check membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    const members = await db.select({
      userId: tripMembers.userId,
      displayName: users.displayName,
      role: tripMembers.role,
      isRequired: tripMembers.isRequired,
      joinedAt: tripMembers.joinedAt,
    })
      .from(tripMembers)
      .innerJoin(users, eq(users.id, tripMembers.userId))
      .where(eq(tripMembers.tripId, tripId))
      .orderBy(asc(tripMembers.joinedAt), asc(tripMembers.userId));

    return tripDetailsResponseSchema.parse({
      trip: {
        ...trip,
        createdAt: trip.createdAt.toISOString(),
        updatedAt: trip.updatedAt.toISOString(),
      },
      members: members.map(member => ({
        ...member,
        joinedAt: member.joinedAt.toISOString(),
      })),
    });
  });
}
