import { desc, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { tripStaySearchPreferences } from "../db/schema.js";
import type { TripStaySearchPreferencesRequest } from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";

export class StaySearchPreferencesStaleError extends Error {
  constructor() {
    super("Confirmed stay search preferences are missing or stale");
    this.name = "StaySearchPreferencesStaleError";
  }
}

export async function loadLatestStaySearchPreferences(tripId: string) {
  const [latest] = await db.select().from(tripStaySearchPreferences)
    .where(eq(tripStaySearchPreferences.tripId, tripId))
    .orderBy(desc(tripStaySearchPreferences.version)).limit(1);
  return latest ?? null;
}

export async function loadCurrentStaySearchPreferences(params: { tripId: string; version: number }) {
  const latest = await loadLatestStaySearchPreferences(params.tripId);
  if (!latest || latest.version !== params.version) throw new StaySearchPreferencesStaleError();
  return latest;
}

export async function saveConfirmedStaySearchPreferences(params: {
  ctx: RequestContext;
  tripId: string;
  confirmedBy: string;
  input: TripStaySearchPreferencesRequest;
}) {
  return db.transaction(async (tx) => {
    const [latest] = await tx.select({ version: tripStaySearchPreferences.version })
      .from(tripStaySearchPreferences).where(eq(tripStaySearchPreferences.tripId, params.tripId))
      .orderBy(desc(tripStaySearchPreferences.version)).limit(1);
    const [created] = await tx.insert(tripStaySearchPreferences).values({
      tripId: params.tripId,
      version: (latest?.version ?? 0) + 1,
      roomCount: params.input.roomCount,
      adultsPerRoom: params.input.adultsPerRoom,
      currency: params.input.currency,
      confirmedBy: params.confirmedBy,
    }).returning();
    await stalePlansAndConfirmationsForTrip(tx, { tripId: params.tripId, reason: "stay_search_preferences_updated" });
    await recordAudit({
      ctx: params.ctx,
      action: "STAY_SEARCH_PREFERENCES_CONFIRMED",
      actorUserId: params.confirmedBy,
      tripId: params.tripId,
      summary: { preferenceVersion: created.version },
      tx,
    });
    return created;
  });
}
