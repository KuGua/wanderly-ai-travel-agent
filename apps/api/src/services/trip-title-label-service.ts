import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { sharedTrips } from "../db/schema.js";
import { recordAudit } from "../services/audit-service.js";
import { metrics } from "../observability/metrics.js";
import type { RequestContext } from "../utils/context.js";

import { buildTripTitle } from "./trip-title-service.js";

/**
 * Display-only destination-label persistence (docs/trip-title-destination-label-implementation.md §6.4).
 *
 * Source-of-truth priority (D4): explicit `destinationCandidates` >
 * existing `REFERENCE` label > `LLM` label. This service is the single
 * write path for both sources; both routes and the conversation handler
 * call `applyTitleDestinationLabel`.
 *
 * Audit summary holds only `{ source }` — the label text is never written
 * to the audit log, the gateway log, the metric label, or the span
 * attribute. Privacy follows AGENTS.md and the existing thread-title
 * practice.
 */

export type ApplyTitleLabelReason =
  | "MANUAL_LOCKED"
  | "NOT_DRAFT"
  | "UNCHANGED"
  | "SUPERSEDED";

export type ApplyTitleLabelResult =
  | { applied: true; reason?: undefined }
  | { applied: false; reason: ApplyTitleLabelReason };

/**
 * Write the destination label and recompute `name` under a short transaction
 * with `FOR UPDATE` on the trip row. Returns one of four bounded reasons on
 * the no-op path; `applied: true` carries no reason.
 *
 * Important: this function is the only writer of `title_destination_label`,
 * `title_label_source`, and `title_label_updated_at`. The two existing
 * brief-write paths in `destination-cue-service.ts` and
 * `routes/trips.ts` use `clearTitleLabelFields` (below) to keep the columns
 * consistent when a real city takes over.
 */
export async function applyTitleDestinationLabel(params: {
  ctx: RequestContext;
  tripId: string;
  label: string;
  source: "REFERENCE" | "LLM";
  locale: "en" | "zh";
}): Promise<ApplyTitleLabelResult> {
  const { ctx, tripId, label, source, locale } = params;
  return db.transaction(async (tx) => {
    const [trip] = await tx.select().from(sharedTrips)
      .where(eq(sharedTrips.id, tripId))
      .for("update")
      .limit(1);
    if (!trip) {
      // Trip gone is a programming error from the caller's point of view —
      // the route's pre-check would have returned 404 already. We surface
      // it as SUPERSEDED rather than throwing so the caller's metric and
      // audit shape stay uniform.
      return { applied: false, reason: "SUPERSEDED" } satisfies ApplyTitleLabelResult;
    }
    if (trip.status !== "DRAFT") {
      return { applied: false, reason: "NOT_DRAFT" } satisfies ApplyTitleLabelResult;
    }
    if (trip.nameSource !== "AUTO") {
      return { applied: false, reason: "MANUAL_LOCKED" } satisfies ApplyTitleLabelResult;
    }
    // Explicit city facts win. The label is a presentation fallback only.
    if ((trip.destinationCandidates ?? []).length > 0) {
      return { applied: false, reason: "SUPERSEDED" } satisfies ApplyTitleLabelResult;
    }
    // Deterministic reference labels outrank LLM labels (D4).
    if (trip.titleLabelSource === "REFERENCE" && source === "LLM") {
      return { applied: false, reason: "SUPERSEDED" } satisfies ApplyTitleLabelResult;
    }
    // Idempotent: nothing to do when the value is unchanged.
    if (trip.titleDestinationLabel === label && trip.titleLabelSource === source) {
      return { applied: false, reason: "UNCHANGED" } satisfies ApplyTitleLabelResult;
    }

    const title = buildTripTitle({
      destinationCandidates: [],
      titleDestinationLabel: label,
      travelDateStart: trip.travelDateStart,
      travelDateEnd: trip.travelDateEnd,
      travelDays: trip.travelDays,
      locale,
    });
    const now = new Date();
    await tx.update(sharedTrips).set({
      titleDestinationLabel: label,
      titleLabelSource: source,
      titleLabelUpdatedAt: now,
      name: title,
      titleLocale: locale,
      updatedAt: now,
    }).where(eq(sharedTrips.id, tripId));

    await recordAudit({
      ctx,
      action: "TRIP_TITLE_LABEL_UPDATE",
      tripId,
      summary: { source }, // D9 — label text intentionally absent
      tx,
    });
    return { applied: true } satisfies ApplyTitleLabelResult;
  }).then(async (result) => {
    // Metric fires after the transaction commits so a rolled-back write
    // never inflates the success counter. Audit is inside the transaction
    // so it is atomic with the title write.
    metrics.inc("trip_title_writes_total", {
      source: source === "REFERENCE" ? "reference" : "llm",
      result: result.applied
        ? "applied"
        : reasonToMetricResult(result.reason),
    });
    return result;
  });
}

function reasonToMetricResult(reason: ApplyTitleLabelReason): "manual_locked" | "not_draft" | "superseded" {
  switch (reason) {
    case "MANUAL_LOCKED": return "manual_locked";
    case "NOT_DRAFT": return "not_draft";
    case "SUPERSEDED": return "superseded";
    case "UNCHANGED": return "superseded"; // UNCHANGED is rare; map to superseded
  }
}

/**
 * Spread into the brief-write `update` payload when a real city takes over
 * from a label. Clears all three label columns atomically with the city
 * write so an old label cannot resurrect after the user clears
 * `destinationCandidates`.
 */
export function clearTitleLabelFields<T extends Record<string, unknown>>(
  payload: T,
): T & { titleDestinationLabel: null; titleLabelSource: null; titleLabelUpdatedAt: null } {
  return {
    ...payload,
    titleDestinationLabel: null,
    titleLabelSource: null,
    titleLabelUpdatedAt: null,
  };
}
