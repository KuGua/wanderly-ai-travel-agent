import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { conversationHotelSearchStates } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import type { PersonalResearchOwnerDraft } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

export type ConversationHotelSearchDraft = Extract<PersonalResearchOwnerDraft, { kind: "HOTEL_SEARCH" }>;

export type ConversationHotelSearchState = {
  draft: ConversationHotelSearchDraft;
  confirmed: boolean;
  version: number;
};

/** Loads only server-owned typed query state for the current private thread. */
export async function loadConversationHotelSearchState(params: {
  threadId: string;
  tripId: string;
  ownerUserId: string;
}): Promise<ConversationHotelSearchState | null> {
  const [row] = await db.select().from(conversationHotelSearchStates)
    .where(eq(conversationHotelSearchStates.threadId, params.threadId)).limit(1);
  if (!row) return null;
  // A primary-key row should never point at a different owner/trip. Treat any
  // such database inconsistency as unavailable rather than leaking its state.
  if (row.tripId !== params.tripId || row.ownerUserId !== params.ownerUserId) {
    throw new Error("Conversation hotel search state ownership mismatch");
  }
  return {
    draft: {
      kind: "HOTEL_SEARCH",
      cityCode: row.cityCode,
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      occupancy: { adults: row.adults, rooms: row.rooms },
      currency: row.currency,
    },
    confirmed: row.confirmedAt !== null && row.confirmedMessageId !== null,
    version: row.version,
  };
}

/**
 * Replaces the thread's complete typed query. The legacy confirmation fields
 * remain for backward-compatible rows, but sandbox hotel lookup does not set
 * them because no per-call owner confirmation occurs. The audit summary
 * deliberately records only field count/state, never hotel dates, city,
 * occupancy or money.
 */
export async function saveConversationHotelSearchState(params: {
  ctx: RequestContext;
  threadId: string;
  tripId: string;
  ownerUserId: string;
  userMessageId: string;
  draft: ConversationHotelSearchDraft;
  confirmed: boolean;
}): Promise<ConversationHotelSearchState> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(conversationHotelSearchStates)
      .where(eq(conversationHotelSearchStates.threadId, params.threadId)).limit(1).for("update");
    if (existing && (existing.tripId !== params.tripId || existing.ownerUserId !== params.ownerUserId)) {
      throw new Error("Conversation hotel search state ownership mismatch");
    }
    const nextVersion = (existing?.version ?? 0) + 1;
    const values = {
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      cityCode: params.draft.cityCode,
      checkIn: params.draft.checkIn,
      checkOut: params.draft.checkOut,
      adults: params.draft.occupancy.adults,
      rooms: params.draft.occupancy.rooms,
      currency: params.draft.currency,
      confirmedMessageId: params.confirmed ? params.userMessageId : null,
      confirmedAt: params.confirmed ? now : null,
      version: nextVersion,
      updatedAt: now,
    };
    await tx.insert(conversationHotelSearchStates).values({ threadId: params.threadId, ...values })
      .onConflictDoUpdate({ target: conversationHotelSearchStates.threadId, set: values });
    await recordAudit({
      ctx: params.ctx,
      action: "PERSONAL_RESEARCH_TOOL_DISPATCH",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: {
        capability: "hotel.search",
        queryFieldCount: 5,
        confirmed: params.confirmed,
        stateVersion: nextVersion,
      },
      tx,
    });
    return { draft: params.draft, confirmed: params.confirmed, version: nextVersion };
  });
}
