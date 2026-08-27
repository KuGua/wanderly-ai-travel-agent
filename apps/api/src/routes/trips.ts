import { eq, and, asc, count, desc, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { sharedTrips, tripMembers, users, itineraryPlans, memberConfirmations, consentGrants } from "../db/schema.js";
import {
  createTripSchema,
  errorResponseSchema,
  toJsonSchema,
  tripActivationRequestSchema,
  tripActivationResponseSchema,
  updateTripTitleRequestSchema,
  updateTripTitleResponseSchema,
  tripDetailsResponseSchema,
  tripsResponseSchema,
  type LatestPlan,
  type NextAction,
  type ProjectDisplayState,
} from "../types/schemas.js";
import { buildTripTitle, isValidTripDate } from "../services/trip-title-service.js";
import { createRequestContext } from "../utils/context.js";
import { recordAudit } from "../services/audit-service.js";
import { ApiError } from "../middleware/error-handler.js";
import { getOrCreateDefaultThread } from "../services/trip-invitation-service.js";
import { metrics } from "../observability/metrics.js";

const tripIdParamSchema = z.object({ tripId: z.string().uuid() }).strict();

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

type TripListRow = {
  id: string;
  name: string;
  status: "DRAFT" | "PLANNING" | "CONFIRMED" | "BOOKED" | "CANCELLED" | "STALE";
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart: string | null;
  travelDateEnd: string | null;
  role: "CREATOR" | "MEMBER";
  createdAt: Date;
  updatedAt: Date;
};

export async function tripRoutes(app: FastifyInstance) {
  // List trips visible to the authenticated member with server-derived
  // displayState, latestPlan and nextAction per docs/frontend-prototype-handoff.md §8.1.
  app.get("/trips", {
    schema: {
      description: "List trips where the authenticated user is a member, with server-derived ProjectSummary fields.",
      response: {
        200: toJsonSchema(tripsResponseSchema),
        401: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const query = (request.query ?? {}) as {
      limit?: string;
      cursor?: string;
      status?: string;
      q?: string;
    };
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const statusFilter = (typeof query.status === "string" && query.status.length > 0)
      ? query.status.toUpperCase() : undefined;
    const qFilter = (typeof query.q === "string" && query.q.trim().length > 0)
      ? query.q.trim() : undefined;

    const whereClauses: SQL[] = [];
    if (statusFilter) whereClauses.push(eq(sharedTrips.status, statusFilter as TripListRow["status"]));
    if (qFilter) whereClauses.push(sql`${sharedTrips.name} ILIKE ${`%${qFilter}%`}`);
    if (cursor) whereClauses.push(orLessThanCursor(cursor.createdAt, cursor.id));

    const rows = await db.select({
      id: sharedTrips.id,
      name: sharedTrips.name,
      status: sharedTrips.status,
      departureCities: sharedTrips.departureCities,
      destinationCandidates: sharedTrips.destinationCandidates,
      travelDateStart: sharedTrips.travelDateStart,
      travelDateEnd: sharedTrips.travelDateEnd,
      role: tripMembers.role,
      createdAt: sharedTrips.createdAt,
      updatedAt: sharedTrips.updatedAt,
    })
      .from(tripMembers)
      .innerJoin(sharedTrips, eq(sharedTrips.id, tripMembers.tripId))
      .where(whereClauses.length === 0
        ? eq(tripMembers.userId, request.user.id)
        : and(eq(tripMembers.userId, request.user.id), ...whereClauses))
      .orderBy(desc(sharedTrips.createdAt), asc(sharedTrips.id))
      .limit(limit + 1);

    const typedRows = rows.map(r => ({
      ...r,
      role: r.role as "CREATOR" | "MEMBER",
    }));

    const page = typedRows.slice(0, limit);
    const nextCursor = typedRows.length > limit
      ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id)
      : null;

    // 2. Member counts per trip.
    const tripIds = page.map(r => r.id);
    const memberCounts = tripIds.length === 0
      ? []
      : await db.select({ tripId: tripMembers.tripId, memberCount: count() })
        .from(tripMembers)
        .where(inArray(tripMembers.tripId, tripIds))
        .groupBy(tripMembers.tripId);
    const memberCountByTrip = new Map(memberCounts.map(r => [r.tripId, Number(r.memberCount)]));

    // 3. Latest plan per trip (one window query).
    const latestPlanByTrip = tripIds.length === 0
      ? new Map<string, { id: string; version: number; status: string; generatedAt: Date }>()
      : await loadLatestPlanByTrip(tripIds);

    // 4. Consent/confirmations per trip to drive displayState.
    const consentByTrip = tripIds.length === 0
      ? new Map<string, { hasAny: boolean }>()
      : await loadConsentSummaryByTrip(tripIds);
    const confirmationsByPlan = latestPlanByTrip.size === 0
      ? new Map<string, Array<{ userId: string; status: string }>>()
      : await loadConfirmationsByPlan([...latestPlanByTrip.values()].map(p => p.id));

    const trips = page.map(r => {
      const latestPlan = latestPlanByTrip.get(r.id) ?? null;
      const consent = consentByTrip.get(r.id) ?? { hasAny: false };
      const confirmations = latestPlan ? confirmationsByPlan.get(latestPlan.id) ?? [] : [];
      const displayState = deriveDisplayState({
        tripStatus: r.status,
        latestPlan,
        confirmations,
        hasAnyConsent: consent.hasAny,
      });
      const nextAction = deriveNextAction({
        displayState,
        tripId: r.id,
        latestPlan,
        hasAnyConsent: consent.hasAny,
      });

      const summary: TripListRow & {
        memberCount: number;
        displayState: ProjectDisplayState;
        latestPlan: LatestPlan | null;
        nextAction: NextAction | null;
      } = {
        ...r,
        memberCount: memberCountByTrip.get(r.id) ?? 0,
        displayState,
        latestPlan: latestPlan
          ? {
              id: latestPlan.id,
              version: latestPlan.version,
              status: latestPlan.status as LatestPlan["status"],
              generatedAt: latestPlan.generatedAt.toISOString(),
            }
          : null,
        nextAction,
      };

      return {
        id: summary.id,
        name: summary.name,
        status: summary.status,
        departureCities: summary.departureCities,
        destinationCandidates: summary.destinationCandidates,
        travelDateStart: summary.travelDateStart,
        travelDateEnd: summary.travelDateEnd,
        memberCount: summary.memberCount,
        role: summary.role,
        createdAt: summary.createdAt.toISOString(),
        updatedAt: summary.updatedAt.toISOString(),
        displayState: summary.displayState,
        latestPlan: summary.latestPlan,
        nextAction: summary.nextAction,
      };
    });

    return tripsResponseSchema.parse({ trips, nextCursor });
  });

  // Create trip
  app.post("/trips", async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = createTripSchema.parse(request.body);

    const tripId = await db.transaction(async (tx) => {
      const [trip] = await tx.insert(sharedTrips).values({
        name: body.name,
        createdBy: request.user.id,
        departureCities: body.departureCities,
        destinationCandidates: body.destinationCandidates,
        travelDateStart: body.travelDateStart,
        travelDateEnd: body.travelDateEnd,
      }).returning();

      await tx.insert(tripMembers).values({
        tripId: trip.id,
        userId: request.user.id,
        role: "CREATOR",
        isRequired: true,
      });
      const defaultThreadId = await getOrCreateDefaultThread(tx, {
        tripId: trip.id,
        ownerUserId: request.user.id,
      });

      await recordAudit({
        ctx,
        action: "TRIP_CREATE",
        actorUserId: request.user.id,
        tripId: trip.id,
        summary: { memberCount: 1 },
        tx,
      });
      await recordAudit({
        ctx,
        action: "TRIP_DEFAULT_THREAD_PROVISION",
        actorUserId: request.user.id,
        tripId: trip.id,
        summary: { threadId: defaultThreadId, source: "trip_create" },
        tx,
      });

      return trip.id;
    });

    reply.code(201).send({ id: tripId, message: "Trip created" });
  });

  // Join-by-UUID was removed when Trip invitations were introduced. Members
  // must now be added via the invitation flow: the creator calls
  // POST /trips/:tripId/invitations and the invitee redeems the token at
  // POST /trip-invitations/:inviteToken/accept.

  // Activate a DRAFT trip with a complete brief. The only path that moves
  // a Trip out of DRAFT. The database trigger permits `DRAFT → PLANNING`
  // and `DRAFT → CANCELLED` only; all other transitions throw, which is
  // the second line of defense behind this route's status check.
  app.post("/trips/:tripId/activate", {
    schema: {
      description: "Activate a DRAFT Trip by writing a complete brief and transitioning to PLANNING.",
      tags: ["trips"],
      params: toJsonSchema(tripIdParamSchema),
      body: toJsonSchema(tripActivationRequestSchema),
      response: {
        200: toJsonSchema(tripActivationResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = tripActivationRequestSchema.parse(request.body);
    if ((body.travelDateStart && !isValidTripDate(body.travelDateStart))
      || (body.travelDateEnd && !isValidTripDate(body.travelDateEnd))
      || (body.travelDateStart && body.travelDateEnd && body.travelDateEnd < body.travelDateStart)) {
      throw new ApiError(400, "Bad Request", "Travel dates must be valid calendar dates with an end date on or after the start date");
    }
    const generatedTitle = buildTripTitle({
      destinationCandidates: body.destinationCandidates,
      travelDateStart: body.travelDateStart,
      travelDateEnd: body.travelDateEnd,
      locale: body.titleLocale,
    });

    await db.transaction(async (tx) => {
      const [trip] = await tx.select().from(sharedTrips)
        .where(eq(sharedTrips.id, tripId))
        .for("update")
        .limit(1);
      if (!trip) {
        metrics.inc("trip_activation_total", { result: "error" });
        throw new ApiError(404, "Not Found", "Trip not found");
      }
      if (trip.status !== "DRAFT") {
        metrics.inc("trip_activation_total", { result: "conflict" });
        throw new ApiError(
          409,
          "Conflict",
          `TRIP_NOT_DRAFT: trip is in status ${trip.status}`,
        );
      }
      if (trip.createdBy !== request.user.id) {
        metrics.inc("trip_activation_total", { result: "forbidden" });
        throw new ApiError(403, "Forbidden", "Only the creator may activate the trip");
      }

      await tx.update(sharedTrips).set({
        name: generatedTitle,
        nameSource: "AUTO",
        titleLocale: body.titleLocale,
        departureCities: body.departureCities,
        destinationCandidates: body.destinationCandidates,
        travelDateStart: body.travelDateStart ?? null,
        travelDateEnd: body.travelDateEnd ?? null,
        status: "PLANNING",
        updatedAt: new Date(),
      }).where(eq(sharedTrips.id, tripId));

      await recordAudit({
        ctx,
        action: "TRIP_ACTIVATE",
        actorUserId: request.user.id,
        tripId,
        summary: {
          briefLength: {
            cities: body.departureCities.length,
            candidates: body.destinationCandidates.length,
          },
        },
        tx,
      });
    });

    metrics.inc("trip_activation_total", { result: "success" });

    const [trip] = await db.select().from(sharedTrips)
      .where(eq(sharedTrips.id, tripId)).limit(1);
    if (!trip) {
      throw new ApiError(500, "Internal Server Error", "Trip vanished after activate");
    }
    return reply.code(200).send(tripActivationResponseSchema.parse({
      trip: {
        id: trip.id,
        name: trip.name,
        status: "PLANNING",
        departureCities: trip.departureCities as string[],
        destinationCandidates: trip.destinationCandidates as string[],
        travelDateStart: trip.travelDateStart,
        travelDateEnd: trip.travelDateEnd,
        createdAt: trip.createdAt.toISOString(),
        updatedAt: trip.updatedAt.toISOString(),
      },
    }));
  });

  app.patch("/trips/:tripId/title", {
    schema: {
      description: "Set a creator-managed trip title. This never reads chat history or calls an LLM.",
      tags: ["trips"],
      params: toJsonSchema(tripIdParamSchema),
      body: toJsonSchema(updateTripTitleRequestSchema),
      response: {
        200: toJsonSchema(updateTripTitleResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const body = updateTripTitleRequestSchema.parse(request.body);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    const updatedAt = await db.transaction(async (tx) => {
      const [trip] = await tx.select().from(sharedTrips)
        .where(eq(sharedTrips.id, tripId)).for("update").limit(1);
      if (!trip) throw new ApiError(404, "Not Found", "Trip not found");
      if (trip.createdBy !== request.user.id) {
        throw new ApiError(403, "Forbidden", "Only the creator may rename the trip");
      }

      const now = new Date();
      await tx.update(sharedTrips).set({
        name: body.name,
        nameSource: "MANUAL",
        titleLocale: null,
        updatedAt: now,
      }).where(eq(sharedTrips.id, tripId));
      await recordAudit({
        ctx,
        action: "TRIP_TITLE_UPDATE",
        actorUserId: request.user.id,
        tripId,
        summary: { source: "manual" },
        tx,
      });
      return now;
    });

    return updateTripTitleResponseSchema.parse({
      trip: { id: tripId, name: body.name, nameSource: "MANUAL", titleLocale: null, updatedAt: updatedAt.toISOString() },
    });
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_PAGE_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(n, MAX_PAGE_LIMIT);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const [iso, id] = decoded.split("|");
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function orLessThanCursor(createdAt: Date, id: string) {
  // Returns a server-scoped predicate: rows strictly older than the cursor
  // or same createdAt but smaller id. Equivalent to row_number pagination.
  return sql`(${sharedTrips.createdAt}, ${sharedTrips.id}) < (${createdAt.toISOString()}::timestamptz, ${id}::uuid)`;
}

async function loadLatestPlanByTrip(
  tripIds: string[],
): Promise<Map<string, { id: string; version: number; status: string; generatedAt: Date }>> {
  if (tripIds.length === 0) return new Map();
  // Fetch all plans for the page, then pick the highest version per trip
  // in memory. Page sizes are bounded by MAX_PAGE_LIMIT, so this stays cheap.
  const rows = await db.select({
    tripId: itineraryPlans.tripId,
    id: itineraryPlans.id,
    version: itineraryPlans.version,
    status: itineraryPlans.status,
    createdAt: itineraryPlans.createdAt,
  })
    .from(itineraryPlans)
    .where(inArray(itineraryPlans.tripId, tripIds))
    .orderBy(desc(itineraryPlans.version));

  const map = new Map<string, { id: string; version: number; status: string; generatedAt: Date }>();
  for (const r of rows) {
    if (map.has(r.tripId)) continue;
    map.set(r.tripId, {
      id: r.id,
      version: r.version,
      status: r.status,
      generatedAt: r.createdAt,
    });
  }
  return map;
}

async function loadConsentSummaryByTrip(
  tripIds: string[],
): Promise<Map<string, { hasAny: boolean }>> {
  const rows = await db.select({
    tripId: consentGrants.tripId,
    granted: consentGrants.granted,
  })
    .from(consentGrants)
    .where(inArray(consentGrants.tripId, tripIds));
  const map = new Map<string, { hasAny: boolean }>();
  for (const r of rows) {
    if (!r.granted) continue;
    map.set(r.tripId, { hasAny: true });
  }
  return map;
}

async function loadConfirmationsByPlan(
  planIds: string[],
): Promise<Map<string, Array<{ userId: string; status: string }>>> {
  const rows = await db.select({
    planId: memberConfirmations.planId,
    userId: memberConfirmations.userId,
    status: memberConfirmations.status,
  })
    .from(memberConfirmations)
    .where(inArray(memberConfirmations.planId, planIds));
  const map = new Map<string, Array<{ userId: string; status: string }>>();
  for (const r of rows) {
    const arr = map.get(r.planId) ?? [];
    arr.push({ userId: r.userId, status: r.status });
    map.set(r.planId, arr);
  }
  return map;
}

function deriveDisplayState(params: {
  tripStatus: TripListRow["status"];
  latestPlan: { status: string } | null;
  confirmations: Array<{ userId: string; status: string }>;
  hasAnyConsent: boolean;
}): ProjectDisplayState {
  if (params.tripStatus === "DRAFT") return "DRAFT";
  if (params.tripStatus === "CANCELLED") return "CANCELLED";
  if (params.tripStatus === "STALE" || params.tripStatus === "BOOKED") {
    return params.tripStatus === "BOOKED" ? "COMPLETED" : "ARCHIVED";
  }
  if (!params.latestPlan || params.latestPlan.status === "STALE" || params.latestPlan.status === "SUPERSEDED") {
    return "ACTION_REQUIRED";
  }
  if (!params.hasAnyConsent) {
    return "ACTION_REQUIRED";
  }
  const allConfirmed = params.confirmations.length > 0
    && params.confirmations.every(c => c.status === "CONFIRMED");
  return allConfirmed ? "COMPLETED" : "IN_PROGRESS";
}

function deriveNextAction(params: {
  displayState: ProjectDisplayState;
  tripId: string;
  latestPlan: { id: string; version: number; status: string } | null;
  hasAnyConsent: boolean;
}): NextAction | null {
  if (params.displayState === "DRAFT") {
    return { type: "EDIT_DRAFT", label: "Continue exploration", href: `/trips/${params.tripId}` };
  }
  if (params.displayState === "CANCELLED" || params.displayState === "ARCHIVED") {
    return { type: "VIEW_HISTORY", label: "View history", href: `/trips/${params.tripId}` };
  }
  if (params.displayState === "ACTION_REQUIRED") {
    if (!params.hasAnyConsent) {
      return { type: "GRANT_CONSENT", label: "Grant consent", href: `/trips/${params.tripId}/consent` };
    }
    if (!params.latestPlan || params.latestPlan.status === "STALE" || params.latestPlan.status === "SUPERSEDED") {
      return {
        type: "REVIEW_PLAN",
        label: "Review plan",
        href: `/trips/${params.tripId}/replan/${params.latestPlan?.id ?? "latest"}`,
      };
    }
    return { type: "CHECK_READINESS", label: "Check readiness", href: `/trips/${params.tripId}/readiness` };
  }
  if (params.displayState === "IN_PROGRESS") {
    if (params.latestPlan) {
      return {
        type: "CONFIRM_PLAN",
        label: "Confirm plan",
        href: `/trips/${params.tripId}/confirm/${params.latestPlan.id}`,
      };
    }
    return { type: "VIEW_PROJECT", label: "Open trip", href: `/trips/${params.tripId}` };
  }
  if (params.displayState === "COMPLETED") {
    return { type: "VIEW_PROJECT", label: "Open trip", href: `/trips/${params.tripId}` };
  }
  return null;
}
