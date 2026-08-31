import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../middleware/error-handler.js";
import {
  grantQuoteNationality,
  listStaySearchAuthorizations,
  revokeQuoteNationality,
} from "../services/stay-search-provider-authorization.js";

const tripIdParamSchema = z.object({ tripId: z.string().uuid() }).strict();
const authorizationIdParamSchema = z.object({
  tripId: z.string().uuid(),
  authorizationId: z.string().uuid(),
}).strict();

const grantBodySchema = z.object({
  provider: z.literal("nuitee_connect"),
  field: z.literal("guest_nationality"),
  value: z.string().regex(/^[A-Za-z]{2}$/),
}).strict();

const authorizationResponseSchema = z.object({
  id: z.string().uuid(),
  providerName: z.enum(["nuitee_connect", "serpapi_google_hotels"]),
  field: z.literal("guest_nationality"),
  version: z.number().int().positive(),
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
}).strict();

/**
 * Phase D — provider-only quote field authorization endpoints.
 *
 * Spec §5.1. The route is intentionally thin: the service layer holds the
 * encryption, stale-cascade, and audit invariants. The response body
 * NEVER echoes the decrypted value (nationality) — only the authorization
 * id/version so downstream code can resolve the plaintext server-side.
 */
export async function staySearchProviderAuthorizationRoutes(app: FastifyInstance): Promise<void> {
  app.put("/trips/:tripId/stay-search-provider-authorizations", async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const body = grantBodySchema.parse(request.body);
    await assertTripMembership(tripId, request.user.id);
    const granted = await grantQuoteNationality({
      tripId,
      memberId: request.user.id,
      value: body.value,
    });
    const [listed] = await listStaySearchAuthorizations({ tripId, memberId: request.user.id });
    return reply.code(201).send(authorizationResponseSchema.parse({
      id: granted.id,
      providerName: listed.providerName,
      field: listed.field,
      version: granted.version,
      grantedAt: listed.grantedAt.toISOString(),
      expiresAt: listed.expiresAt?.toISOString() ?? null,
    }));
  });

  app.get("/trips/:tripId/stay-search-provider-authorizations", async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    await assertTripMembership(tripId, request.user.id);
    const rows = await listStaySearchAuthorizations({ tripId, memberId: request.user.id });
    return reply.code(200).send(z.array(authorizationResponseSchema).parse(rows.map((row) => ({
      id: row.id,
      providerName: row.providerName,
      field: row.field,
      version: row.version,
      grantedAt: row.grantedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }))));
  });

  app.delete("/trips/:tripId/stay-search-provider-authorizations/:authorizationId", async (request, reply) => {
    const { tripId, authorizationId } = authorizationIdParamSchema.parse(request.params);
    await assertTripMembership(tripId, request.user.id);
    await revokeQuoteNationality({ tripId, memberId: request.user.id, authorizationId });
    return reply.code(204).send();
  });
}

async function assertTripMembership(tripId: string, userId: string): Promise<void> {
  const [member] = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)))
    .limit(1);
  if (!member) throw new ApiError(403, "Forbidden", "Not a member of this trip");
}
