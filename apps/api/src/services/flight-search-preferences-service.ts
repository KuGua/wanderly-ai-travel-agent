import { desc, eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { tripSearchPreferences } from "../db/schema.js";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import type { TripSearchPreferencesRequest } from "../types/schemas.js";

export class SearchPreferencesStaleError extends Error {
  constructor() {
    super("Confirmed flight search preferences are missing or stale");
    this.name = "SearchPreferencesStaleError";
  }
}

export async function loadCurrentConfirmedSearchPreferences(params: {
  tripId: string;
  version: number;
}) {
  const [latest] = await db.select().from(tripSearchPreferences)
    .where(eq(tripSearchPreferences.tripId, params.tripId))
    .orderBy(desc(tripSearchPreferences.version))
    .limit(1);
  if (!latest || latest.version !== params.version) throw new SearchPreferencesStaleError();
  return latest;
}

export async function saveConfirmedSearchPreferences(params: {
  ctx: RequestContext;
  tripId: string;
  confirmedBy: string;
  input: TripSearchPreferencesRequest;
}) {
  return db.transaction(async (tx) => {
    const [latest] = await tx.select({ version: tripSearchPreferences.version })
      .from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, params.tripId))
      .orderBy(desc(tripSearchPreferences.version))
      .limit(1);
    const [created] = await tx.insert(tripSearchPreferences).values({
      tripId: params.tripId,
      version: (latest?.version ?? 0) + 1,
      ...params.input,
      confirmedBy: params.confirmedBy,
    }).returning();
    await stalePlansAndConfirmationsForTrip(tx, { tripId: params.tripId, reason: "search_preferences_updated" });
    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_STALE",
      actorUserId: params.confirmedBy,
      tripId: params.tripId,
      summary: { preferenceVersion: created.version, operation: "search_preferences_confirmed" },
      tx,
    });
    return created;
  });
}
