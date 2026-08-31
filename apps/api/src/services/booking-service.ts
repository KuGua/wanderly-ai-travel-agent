import { eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { bookingExecutions, idempotencyRecords, itineraryPlans } from "../db/schema.js";
import { checkAllConfirmed } from "./confirmation-service.js";
import { claimIdempotency } from "./idempotency-service.js";
import { recordAudit } from "./audit-service.js";
import { validateSelectedFlightOffersFresh, FlightOfferStaleError } from "./flight-offer-freshness-service.js";
import type { RequestContext } from "../utils/context.js";
import type { BookingExecutionResult, SandboxResult } from "../types/domain.js";

/**
 * Spec §10.8 — booking sandbox must refuse PROPOSED / STALE / SUPERSEDED /
 * non-unanimous-vote plans. The gate error carries a stable category so the
 * route layer can map it to a metric label without leaking the underlying
 * status value.
 */
export type BookingGateCategory =
  | "plan_state"
  | "plan_unavailable"
  | "quorum"
  | "non_unanimous"
  | "snapshot_stale"
  | "offer_stale";

export class BookingGateError extends Error {
  readonly statusCode: 409 | 422 = 422;
  readonly code = "BOOKING_GATE_DENIED";
  readonly category: BookingGateCategory;

  constructor(category: BookingGateCategory, message: string) {
    super(message);
    this.name = "BookingGateError";
    this.category = category;
  }
}

/**
 * Submit a booking request to the sandbox. Only allowed when:
 *  - the plan is `ACTIVE` (post-adoption-vote ACTIVATE — spec §1.8, §6.2);
 *  - all required members' `member_confirmations` are `CONFIRMED`;
 *  - the underlying snapshot is not STALE (defense-in-depth for late mutations
 *    that haven't yet hit the staleness cascade).
 *
 * Atomic via a single transaction so idempotency claim, plan-gate check,
 * booking row, audit, and result update commit together.
 */
export async function submitBooking(params: {
  ctx: RequestContext;
  planId: string;
  tripId: string;
  orchestrationRequestId: string;
  requestedBy: string;
}): Promise<BookingExecutionResult> {
  const idempotencyKey = `booking:${params.orchestrationRequestId}`;

  return await db.transaction(async (tx) => {
    const claimed = await claimIdempotency(tx, {
      key: idempotencyKey,
      entityType: "booking",
    });
    if (!claimed) {
      // Replay — return the previously cached result.
      const replay = await tx.select().from(bookingExecutions)
        .where(eq(bookingExecutions.orchestrationRequestId, params.orchestrationRequestId))
        .limit(1);
      const cached = replay[0];
      return {
        orchestrationRequestId: params.orchestrationRequestId,
        results: bookingResultsFromRow(cached),
        isDuplicate: true,
        isStale: cached?.status === "SUCCESS" || cached?.status === "FAILED",
      };
    }

    const [plan] = await tx.select().from(itineraryPlans)
      .where(eq(itineraryPlans.id, params.planId))
      .limit(1);

    if (!plan) {
      throw new BookingGateError("plan_unavailable", "Plan not found");
    }
    // Spec §10.8 — reject anything but ACTIVE; the only path to ACTIVE is the
    // unanimous adoption vote (Phase 4's `activateProposedPlan`), so this
    // implicitly guarantees unanimity.
    if (plan.status !== "ACTIVE") {
      throw new BookingGateError(
        "plan_state",
        `Cannot book plan with status ${plan.status}; only ACTIVE plans are eligible`,
      );
    }
    if (plan.status === "ACTIVE" && plan.staleReason === "snapshot_manifest_superseded") {
      throw new BookingGateError(
        "snapshot_stale",
        "Plan was approved but its source snapshot has since been superseded",
      );
    }

    const { allConfirmed } = await checkAllConfirmed({
      planId: params.planId,
      tripId: params.tripId,
    });
    if (!allConfirmed) {
      throw new BookingGateError(
        "quorum",
        "Not all required members have confirmed this plan",
      );
    }

    // Spec §6.2 — confirmation-time freshness (checked at adoption, in
    // `activateProposedPlan`) is not sufficient on its own: time can pass
    // between adoption and this booking attempt, so the offer must be
    // independently revalidated again here, inside this same transaction,
    // immediately before the booking-execution row is written.
    try {
      await validateSelectedFlightOffersFresh({
        ctx: params.ctx,
        planId: params.planId,
        tripId: params.tripId,
        tx,
      });
    } catch (err) {
      if (err instanceof FlightOfferStaleError) {
        throw new BookingGateError("offer_stale", err.message);
      }
      throw err;
    }

    await tx.insert(bookingExecutions).values({
      planId: params.planId,
      tripId: params.tripId,
      orchestrationRequestId: params.orchestrationRequestId,
      status: "PENDING",
      requestedBy: params.requestedBy,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "BOOKING_SUBMIT",
      actorUserId: params.requestedBy,
      tripId: params.tripId,
      planId: params.planId,
      summary: { orchestrationRequestId: params.orchestrationRequestId },
      tx,
    });

    // A real sandbox callback is the sole authority that can complete a
    // booking. Do not synthesize references or terminal outcomes here.
    const results: SandboxResult[] = [];

    // Persist the cached result under the same idempotency key so a retry
    // returns the same payload.
    await tx.update(idempotencyRecords)
      .set({ resultPayload: { results, status: "PENDING" } })
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

    await recordAudit({
      ctx: params.ctx,
      action: "BOOKING_RESULT",
      tripId: params.tripId,
      planId: params.planId,
      summary: { orchestrationRequestId: params.orchestrationRequestId, status: "PENDING" },
      tx,
    });

    return {
      orchestrationRequestId: params.orchestrationRequestId,
      results,
      isDuplicate: false,
      isStale: false,
    };
  });
}

/**
 * Handle a sandbox callback. The callback is idempotent on `eventId` and
 * returns `isStale: true` when the booking has already reached a terminal
 * state; the route layer translates that into HTTP 409 STALE_CALLBACK.
 */
export async function handleSandboxCallback(params: {
  ctx: RequestContext;
  orchestrationRequestId: string;
  eventId: string;
  serviceResults: Record<string, { status: "SUCCESS" | "FAILED"; reference?: string; error?: string }>;
}): Promise<BookingExecutionResult> {
  const idempotencyKey = `callback:${params.eventId}`;

  return await db.transaction(async (tx) => {
    const claimed = await claimIdempotency(tx, {
      key: idempotencyKey,
      entityType: "callback",
    });
    if (!claimed) {
      const replay = await tx.select().from(bookingExecutions)
        .where(eq(bookingExecutions.orchestrationRequestId, params.orchestrationRequestId))
        .limit(1);
      const cached = replay[0];
      return {
        orchestrationRequestId: params.orchestrationRequestId,
        results: bookingResultsFromRow(cached),
        isDuplicate: true,
        isStale: cached?.status === "SUCCESS" || cached?.status === "FAILED",
      };
    }

    const bookings = await tx.select().from(bookingExecutions)
      .where(eq(bookingExecutions.orchestrationRequestId, params.orchestrationRequestId))
      .limit(1);

    if (bookings.length === 0) {
      throw new Error(
        `No booking found for orchestrationRequestId ${params.orchestrationRequestId}`,
      );
    }

    const booking = bookings[0];

    if (booking.status === "SUCCESS" || booking.status === "FAILED") {
      // Late callback for an already-finalized booking — surface as stale
      // so the route layer can return 409 instead of silently ignoring it.
      return {
        orchestrationRequestId: params.orchestrationRequestId,
        results: bookingResultsFromRow(booking),
        isDuplicate: true,
        isStale: true,
      };
    }

    const results: SandboxResult[] = Object.entries(params.serviceResults).map(([service, result]) => ({
      service,
      status: result.status,
      reference: result.reference,
      error: result.error,
    }));

    const finalStatus = results.every(r => r.status === "SUCCESS") ? "SUCCESS" : "FAILED";
    await tx.update(bookingExecutions)
      .set({
        status: finalStatus,
        sandboxResults: params.serviceResults as unknown as Record<string, unknown>,
        completedAt: new Date(),
      })
      .where(eq(bookingExecutions.id, booking.id));

    await recordAudit({
      ctx: params.ctx,
      action: "BOOKING_RESULT",
      tripId: booking.tripId,
      planId: booking.planId,
      summary: {
        orchestrationRequestId: params.orchestrationRequestId,
        eventId: params.eventId,
        status: finalStatus,
      },
      tx,
    });

    return {
      orchestrationRequestId: params.orchestrationRequestId,
      results,
      isDuplicate: false,
      isStale: false,
    };
  });
}

function bookingResultsFromRow(row: { sandboxResults: Record<string, unknown> | null } | undefined): SandboxResult[] {
  if (!row?.sandboxResults) return [];
  return Object.entries(row.sandboxResults).map(([service, raw]) => {
    const r = raw as { status: "SUCCESS" | "FAILED"; reference?: string; error?: string };
    return {
      service,
      status: r.status,
      reference: r.reference,
      error: r.error,
    };
  });
}
