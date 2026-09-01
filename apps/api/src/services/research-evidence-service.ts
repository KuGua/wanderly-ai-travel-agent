/**
 * Read-back for provider evidence gathered by a research run.
 *
 * `POST /trips/:tripId/research` runs the hotel / activity providers and
 * persists what they returned into `provider_offers`. Until now nothing
 * read those rows again: the offers were written, and the only read path
 * (`GET .../research/latest`) returned status and service gaps alone. The
 * assistant therefore could not refer to a search it had itself just run.
 *
 * This module closes that loop. It returns *normalized summaries* only —
 * never `offer_data` verbatim — because the response DTO contract for the
 * research routes forbids raw provider payloads leaving the server.
 *
 * Offers are joined through the research result's `snapshotId`, which is
 * the same key the search services wrote under, so a caller can never see
 * evidence belonging to another trip's snapshot.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../db/database.js";
import { planningResearchResults, providerOffers } from "../db/schema.js";

export type ResearchEvidenceOffer = {
  category: "activity" | "hotel";
  providerName: string;
  /** Activity title or hotel property name. */
  title: string;
  /** Null when the provider stated no denominated amount. */
  price: { amount: number; currency: string } | null;
  rating: number | null;
  /** Short human-meaningful qualifier: duration, nights, locality. */
  detail: string | null;
  capturedAt: string;
};

export type ResearchEvidence = {
  snapshotId: string;
  offers: ResearchEvidenceOffer[];
};

/** Per-category ceiling. Evidence is a prompt input, not a catalogue. */
export const RESEARCH_EVIDENCE_PER_CATEGORY = 6;

const EVIDENCE_CATEGORIES = ["activity", "hotel"] as const;

export async function loadLatestResearchEvidence(tripId: string): Promise<ResearchEvidence | null> {
  const [latest] = await db.select({
    snapshotId: planningResearchResults.snapshotId,
  }).from(planningResearchResults)
    .where(eq(planningResearchResults.tripId, tripId))
    .orderBy(desc(planningResearchResults.createdAt))
    .limit(1);

  if (!latest) return null;
  return {
    snapshotId: latest.snapshotId,
    offers: await loadOffersForSnapshot(latest.snapshotId),
  };
}

export async function loadOffersForSnapshot(snapshotId: string): Promise<ResearchEvidenceOffer[]> {
  const rows = await db.select({
    category: providerOffers.category,
    providerName: providerOffers.providerName,
    currency: providerOffers.currency,
    offerData: providerOffers.offerData,
    capturedAt: providerOffers.capturedAt,
  }).from(providerOffers)
    .where(and(
      eq(providerOffers.snapshotId, snapshotId),
      inArray(providerOffers.category, [...EVIDENCE_CATEGORIES]),
    ))
    .orderBy(desc(providerOffers.capturedAt));

  const perCategory = new Map<string, ResearchEvidenceOffer[]>();
  for (const row of rows) {
    const bucket = perCategory.get(row.category) ?? [];
    if (bucket.length >= RESEARCH_EVIDENCE_PER_CATEGORY) continue;
    const summary = summarize(row);
    // A row whose payload has drifted from the shape its provider writes is
    // skipped rather than surfaced as a nameless offer.
    if (summary === null) continue;
    bucket.push(summary);
    perCategory.set(row.category, bucket);
  }
  return [...perCategory.values()].flat();
}

type OfferRow = {
  category: string;
  providerName: string;
  currency: string | null;
  offerData: Record<string, unknown>;
  capturedAt: Date;
};

function summarize(row: OfferRow): ResearchEvidenceOffer | null {
  const data = row.offerData;
  const capturedAt = row.capturedAt.toISOString();

  if (row.category === "activity") {
    const title = str(data.title);
    if (title === null) return null;
    return {
      category: "activity",
      providerName: row.providerName,
      title,
      price: money(data.fromPrice, row.currency ?? str(data.currency)),
      rating: num(data.rating),
      detail: activityDetail(data),
      capturedAt,
    };
  }

  const title = str(data.propertyName);
  if (title === null) return null;
  return {
    category: "hotel",
    providerName: row.providerName,
    title,
    price: money(data.pricePerNight, row.currency ?? str(data.currency)),
    rating: num(data.rating),
    detail: hotelDetail(data),
    capturedAt,
  };
}

function activityDetail(data: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const category = str(data.category);
  if (category !== null) parts.push(category);
  const duration = data.durationMinutes;
  if (duration !== null && typeof duration === "object") {
    const fixed = num((duration as Record<string, unknown>).fixed);
    const from = num((duration as Record<string, unknown>).from);
    const to = num((duration as Record<string, unknown>).to);
    if (fixed !== null) parts.push(`${fixed} min`);
    else if (from !== null && to !== null) parts.push(`${from}–${to} min`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

function hotelDetail(data: Record<string, unknown>): string | null {
  const nights = num(data.nights);
  return nights === null ? null : `${nights} night${nights === 1 ? "" : "s"}`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * An amount without a currency is not a price. Rather than guess a
 * denomination, such an offer is reported as having no stated price.
 */
function money(amount: unknown, currency: string | null): { amount: number; currency: string } | null {
  const value = num(amount);
  if (value === null || currency === null || currency.length !== 3) return null;
  return { amount: value, currency };
}
