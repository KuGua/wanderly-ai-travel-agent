import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { userProfiles } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import type { QuoteNationalityDecision } from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { syncProfileFormToMemory } from "./profile-form-memory.js";
import { grantQuoteNationality } from "./stay-search-provider-authorization.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Resolve one explicit nationality decision without ever returning the value.
 * PROFILE confirms use of an existing private field. INPUT may additionally
 * persist that field. Both paths create a trip-scoped encrypted grant.
 */
export async function applyQuoteNationalityDecision(params: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  decision: QuoteNationalityDecision;
  tx: Tx;
}): Promise<{ authorizationId: string; version: number }> {
  const [existingProfile] = await params.tx.select({
    id: userProfiles.id,
    nationality: userProfiles.nationality,
  }).from(userProfiles).where(eq(userProfiles.userId, params.userId)).limit(1);

  let value: string;
  if (params.decision.source === "PROFILE") {
    if (!existingProfile?.nationality) {
      throw new ApiError(422, "Unprocessable Entity", "Profile nationality is required");
    }
    value = existingProfile.nationality;
  } else {
    value = params.decision.value.toUpperCase();
    if (params.decision.saveToProfile) {
      const [profile] = existingProfile
        ? await params.tx.update(userProfiles).set({
          nationality: value,
          updatedAt: new Date(),
        }).where(eq(userProfiles.userId, params.userId)).returning()
        : await params.tx.insert(userProfiles).values({
          userId: params.userId,
          nationality: value,
        }).returning();
      if (!profile) throw new ApiError(500, "Internal Server Error", "Failed to save Profile nationality");

      await syncProfileFormToMemory({
        ctx: params.ctx,
        userId: params.userId,
        profileId: profile.id,
        body: { nationality: value },
        tx: params.tx,
      });
      await recordAudit({
        ctx: params.ctx,
        action: existingProfile ? "PROFILE_UPDATE" : "PROFILE_CREATE",
        actorUserId: params.userId,
        tripId: params.tripId,
        summary: existingProfile
          ? { updatedFields: ["nationality"] }
          : { profileId: profile.id },
        tx: params.tx,
      });
    }
  }

  const authorization = await grantQuoteNationality({
    tripId: params.tripId,
    memberId: params.userId,
    value,
    tx: params.tx,
  });
  return { authorizationId: authorization.id, version: authorization.version };
}
