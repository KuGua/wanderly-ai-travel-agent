/**
 * Personal Offer Selection service — owner-only write paths for the
 * Flight / Hotel Offer Cue's accepted selections
 * (docs/flight-offer-cue-model-draft.md §6, docs/hotel-offer-cue-model-draft.md §6).
 *
 * Acceptance writes a row here and supersedes any prior ACTIVE row in the
 * same (trip, owner, capability, scopeKey). NEVER touches
 * shared_trips.constraint_snapshot; NEVER consumed by Shared agent or
 * booking authority.
 *
 * The route layer and the `actOnOfferCueCandidate` state machine are the
 * only callers. Direct INSERT into `personal_offer_selections` from
 * anywhere else is a code-review red flag.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  offerCueCapabilityEnum,
  personalOfferSelections,
} from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { requireOwnedTripThread } from "./chat-thread-service.js";
import {
  personalOfferSelectionResponseSchema,
  type PersonalOfferSelectionResponse,
} from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

export type PersonalOfferSelectionCapability = "flight" | "hotel";

export interface PersonalOfferSelectionCreated {
  id: string;
  selectedAt: Date;
  supersededIds: string[];
}

export async function createPersonalOfferSelection(params: {
  tx: Tx;
  ownerUserId: string;
  threadId: string;
  tripId: string;
  capability: PersonalOfferSelectionCapability;
  personalOfferCandidateId: string;
  scopeKey: string;
  now: Date;
}): Promise<PersonalOfferSelectionCreated> {
  if (params.capability !== "flight" && params.capability !== "hotel") {
    throw new Error(`Unsupported capability ${params.capability}`);
  }
  const [row] = await params.tx.insert(personalOfferSelections).values({
    ownerUserId: params.ownerUserId,
    threadId: params.threadId,
    tripId: params.tripId,
    capability: params.capability,
    personalOfferCandidateId: params.personalOfferCandidateId,
    scopeKey: params.scopeKey,
    status: "ACTIVE",
    selectedAt: params.now,
    updatedAt: params.now,
  }).returning({
    id: personalOfferSelections.id,
    selectedAt: personalOfferSelections.selectedAt,
  });
  return { id: row.id, selectedAt: row.selectedAt, supersededIds: [] };
}

export async function supersedeScopeSelections(params: {
  tx: Tx;
  ownerUserId: string;
  tripId: string;
  capability: PersonalOfferSelectionCapability;
  scopeKey: string;
}): Promise<{ supersededIds: string[] }> {
  const active = await params.tx.select({ id: personalOfferSelections.id })
    .from(personalOfferSelections)
    .where(and(
      eq(personalOfferSelections.ownerUserId, params.ownerUserId),
      eq(personalOfferSelections.tripId, params.tripId),
      eq(personalOfferSelections.capability, params.capability),
      eq(personalOfferSelections.scopeKey, params.scopeKey),
      eq(personalOfferSelections.status, "ACTIVE"),
    ))
    .for("update");
  if (active.length === 0) return { supersededIds: [] };
  const ids = active.map((row) => row.id);
  await params.tx.update(personalOfferSelections).set({
    status: "SUPERSEDED",
    updatedAt: new Date(),
    version: sql`${personalOfferSelections.version} + 1`,
  }).where(and(
    eq(personalOfferSelections.ownerUserId, params.ownerUserId),
    eq(personalOfferSelections.tripId, params.tripId),
    eq(personalOfferSelections.capability, params.capability),
    eq(personalOfferSelections.scopeKey, params.scopeKey),
    eq(personalOfferSelections.status, "ACTIVE"),
  ));
  return { supersededIds: ids };
}

export async function listPersonalOfferSelectionsForTrip(params: {
  threadId?: string;
  ownerUserId: string;
  capability?: PersonalOfferSelectionCapability;
  tx?: DbOrTx;
}): Promise<PersonalOfferSelectionResponse[]> {
  const target = params.tx ?? db;
  const rows = await target.select({
    id: personalOfferSelections.id,
    capability: personalOfferSelections.capability,
    status: personalOfferSelections.status,
    personalOfferCandidateId: personalOfferSelections.personalOfferCandidateId,
    scopeKey: personalOfferSelections.scopeKey,
    selectedAt: personalOfferSelections.selectedAt,
    version: personalOfferSelections.version,
  })
    .from(personalOfferSelections)
    .where(and(
      eq(personalOfferSelections.ownerUserId, params.ownerUserId),
      eq(personalOfferSelections.status, "ACTIVE"),
      params.threadId ? eq(personalOfferSelections.threadId, params.threadId) : sql`TRUE`,
      params.capability ? eq(personalOfferSelections.capability, params.capability) : sql`TRUE`,
    ))
    .orderBy(desc(personalOfferSelections.selectedAt));

  const ids = rows.map((row) => row.personalOfferCandidateId);
  let candidates: Array<{ id: string; normalizedOfferJson: unknown }> = [];
  if (ids.length > 0) {
    candidates = await target.select({
      id: sql<string>`personal_research_offer_candidates.id`,
      normalizedOfferJson: sql<unknown>`personal_research_offer_candidates.normalized_offer_json`,
    }).from(sql`personal_research_offer_candidates`)
      .where(sql`personal_research_offer_candidates.id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i.replace(/'/g, "''")}'::uuid`).join(",")}]`)})`)
      .limit(ids.length);
  }
  const byId = new Map(candidates.map((row) => [row.id, row.normalizedOfferJson]));

  return rows.map((row) => {
    const display = projectDisplay(row.capability, byId.get(row.id));
    return personalOfferSelectionResponseSchema.parse({
      id: row.id,
      capability: row.capability,
      status: row.status,
      display,
      candidateRef: row.personalOfferCandidateId,
      scopeKey: row.scopeKey,
      selectedAt: row.selectedAt.toISOString(),
      version: row.version,
    });
  });
}

function projectDisplay(capability: "flight" | "hotel", json: unknown) {
  const normalized = (json ?? {}) as Record<string, unknown>;
  if (capability === "flight") {
    const carrier = typeof normalized.carrierCode === "string" ? normalized.carrierCode : "";
    const number = typeof normalized.flightNumber === "string" ? normalized.flightNumber : "";
    const departureAt = typeof normalized.departureAt === "string" ? normalized.departureAt.slice(11, 16) : "";
    const arrivalAt = typeof normalized.arrivalAt === "string" ? normalized.arrivalAt.slice(11, 16) : "";
    const totalPrice = typeof normalized.totalPrice === "number" ? normalized.totalPrice : null;
    const currency = typeof normalized.currency === "string" ? normalized.currency : null;
    const headline = [carrier, number].filter(Boolean).join(" ").trim() || "Flight option";
    const subline = [departureAt && arrivalAt ? `${departureAt} → ${arrivalAt}` : null]
      .filter(Boolean).join("") || null;
    const priceLabel = totalPrice !== null && currency
      ? `${currency} ${totalPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : null;
    return { capability, headline, subline, priceLabel };
  }
  const propertyName = typeof normalized.propertyName === "string" ? normalized.propertyName : "Hotel option";
  const pricePerNight = typeof normalized.pricePerNight === "number" ? normalized.pricePerNight : null;
  const currency = typeof normalized.currency === "string" ? normalized.currency : null;
  const cancellationSummary = typeof normalized.cancellationSummary === "string" ? normalized.cancellationSummary : null;
  const priceLabel = pricePerNight !== null && currency
    ? `${currency} ${pricePerNight.toLocaleString("en-US", { maximumFractionDigits: 0 })} / night`
    : null;
  return {
    capability,
    headline: propertyName,
    subline: cancellationSummary,
    priceLabel,
  };
}

void offerCueCapabilityEnum;

export async function deletePersonalOfferSelection(params: {
  ctx: RequestContext;
  threadId: string;
  ownerUserId: string;
  selectionId: string;
  requestId: string;
  expectedVersion: number;
  now?: Date;
}): Promise<PersonalOfferSelectionResponse | null> {
  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    const thread = await requireOwnedTripThread(tx, params.threadId, params.ownerUserId);
    const [row] = await tx.select().from(personalOfferSelections)
      .where(eq(personalOfferSelections.id, params.selectionId))
      .for("update").limit(1);
    if (!row || row.threadId !== thread.id || row.ownerUserId !== params.ownerUserId) {
      throw new ApiError(404, "Not Found", "Offer selection not found");
    }
    if (row.version !== params.expectedVersion) {
      throw new ApiError(409, "Conflict", "Offer selection has changed", "OFFER_CUE_VERSION_CONFLICT");
    }
    if (row.status !== "ACTIVE") {
      return null;
    }
    await tx.update(personalOfferSelections).set({
      status: "REMOVED",
      updatedAt: now,
      version: sql`${personalOfferSelections.version} + 1`,
    }).where(eq(personalOfferSelections.id, row.id));
    await recordAudit({
      ctx: params.ctx,
      action: row.capability === "flight" ? "FLIGHT_OFFER_CUE_DISMISS" : "HOTEL_OFFER_CUE_DISMISS",
      actorUserId: params.ownerUserId,
      tripId: row.tripId,
      summary: { selectionId: row.id, capability: row.capability, action: "remove" },
      tx,
    });
    return personalOfferSelectionResponseSchema.parse({
      id: row.id,
      capability: row.capability,
      status: "REMOVED",
      display: projectDisplay(row.capability, undefined),
      candidateRef: row.personalOfferCandidateId,
      scopeKey: row.scopeKey,
      selectedAt: row.selectedAt.toISOString(),
      version: row.version + 1,
    });
  });
}
