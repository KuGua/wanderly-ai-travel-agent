import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { conversationFlightSearchStates } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import type { PersonalResearchOwnerDraft } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

export type ConversationFlightSearchDraft = Extract<PersonalResearchOwnerDraft, { kind: "FLIGHT_SEARCH" }>;

export type ConversationFlightSearchState = {
  draft: ConversationFlightSearchDraft;
  confirmed: boolean;
  version: number;
};

/** Loads only server-owned typed query state for the current private thread. */
export async function loadConversationFlightSearchState(params: {
  threadId: string;
  tripId: string;
  ownerUserId: string;
}): Promise<ConversationFlightSearchState | null> {
  const [row] = await db.select().from(conversationFlightSearchStates)
    .where(eq(conversationFlightSearchStates.threadId, params.threadId)).limit(1);
  if (!row) return null;
  // A primary-key row should never point at a different owner/trip. Treat any
  // such database inconsistency as unavailable rather than leaking its state.
  if (row.tripId !== params.tripId || row.ownerUserId !== params.ownerUserId) {
    throw new Error("Conversation flight search state ownership mismatch");
  }
  return {
    draft: {
      kind: "FLIGHT_SEARCH",
      originId: row.originId,
      destinationId: row.destinationId,
      tripType: row.tripType as ConversationFlightSearchDraft["tripType"],
      departureDate: row.departureDate,
      returnDate: row.returnDate,
      adults: row.adults,
      cabin: row.cabin as ConversationFlightSearchDraft["cabin"],
      currency: row.currency,
    },
    confirmed: row.confirmedAt !== null && row.confirmedMessageId !== null,
    version: row.version,
  };
}

/**
 * Replaces the thread's complete typed query and binds an explicit owner
 * confirmation to the current USER message. The audit summary deliberately
 * records only field count/state, never route, dates or money.
 */
export async function saveConversationFlightSearchState(params: {
  ctx: RequestContext;
  threadId: string;
  tripId: string;
  ownerUserId: string;
  userMessageId: string;
  draft: ConversationFlightSearchDraft;
  confirmed: boolean;
}): Promise<ConversationFlightSearchState> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(conversationFlightSearchStates)
      .where(eq(conversationFlightSearchStates.threadId, params.threadId)).limit(1).for("update");
    if (existing && (existing.tripId !== params.tripId || existing.ownerUserId !== params.ownerUserId)) {
      throw new Error("Conversation flight search state ownership mismatch");
    }
    const nextVersion = (existing?.version ?? 0) + 1;
    const values = {
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      originId: params.draft.originId,
      destinationId: params.draft.destinationId,
      tripType: params.draft.tripType,
      departureDate: params.draft.departureDate,
      returnDate: params.draft.returnDate,
      adults: params.draft.adults,
      cabin: params.draft.cabin,
      currency: params.draft.currency,
      confirmedMessageId: params.confirmed ? params.userMessageId : null,
      confirmedAt: params.confirmed ? now : null,
      version: nextVersion,
      updatedAt: now,
    };
    await tx.insert(conversationFlightSearchStates).values({ threadId: params.threadId, ...values })
      .onConflictDoUpdate({ target: conversationFlightSearchStates.threadId, set: values });
    await recordAudit({
      ctx: params.ctx,
      action: "PERSONAL_RESEARCH_TOOL_DISPATCH",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: {
        capability: "flight.search",
        queryFieldCount: 6,
        confirmed: params.confirmed,
        stateVersion: nextVersion,
      },
      tx,
    });
    return { draft: params.draft, confirmed: params.confirmed, version: nextVersion };
  });
}
