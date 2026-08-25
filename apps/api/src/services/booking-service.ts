import { eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { bookingExecutions, idempotencyRecords, itineraryPlans } from "../db/schema.js";
import { checkAllConfirmed } from "./confirmation-service.js";
import { claimIdempotency } from "./idempotency-service.js";
import { recordAudit } from "./audit-service.js";
import { SANDBOX_CALLBACK_FIXTURES } from "../providers/fixtures.js";
import type { RequestContext } from "../utils/context.js";
import type { BookingExecutionResult, SandboxResult } from "../types/domain.js";

/**
 * Submit a booking request to the sandbox. Only allowed when all required
 * members have confirmed the latest ACTIVE plan. Atomic via a single
 * transaction so idempotency claim, booking row, audit, and result
 * update commit together.
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

    if (!plan) throw new Error("Plan not found");
    if (plan.status !== "ACTIVE") {
      throw new Error(`Cannot book plan with status ${plan.status}`);
    }

    const { allConfirmed } = await checkAllConfirmed({
      planId: params.planId,
      tripId: params.tripId,
    });
    if (!allConfirmed) {
      throw new Error("Not all required members have confirmed this plan");
    }

    const [booking] = await tx.insert(bookingExecutions).values({
      planId: params.planId,
      tripId: params.tripId,
      orchestrationRequestId: params.orchestrationRequestId,
      status: "PENDING",
      requestedBy: params.requestedBy,
    }).returning();

    await recordAudit({
      ctx: params.ctx,
      action: "BOOKING_SUBMIT",
      actorUserId: params.requestedBy,
      tripId: params.tripId,
      planId: params.planId,
      summary: { orchestrationRequestId: params.orchestrationRequestId },
      tx,
    });

    // Demo behavior: the sandbox call is simulated against the success
    // fixture (see apps/api/src/providers/fixtures.ts). Real sandbox
    // integration is deferred per docs/mvp-readiness-review.md.
    const sandboxResults = SANDBOX_CALLBACK_FIXTURES.success.serviceResults;
    const results: SandboxResult[] = Object.entries(sandboxResults).map(([service, result]) => ({
      service,
      status: result.status,
      reference: result.reference,
      error: "error" in result ? String(result.error) : undefined,
    }));

    const finalStatus = results.every(r => r.status === "SUCCESS") ? "SUCCESS" : "FAILED";
    await tx.update(bookingExecutions)
      .set({
        status: finalStatus,
        sandboxResults: sandboxResults as unknown as Record<string, unknown>,
        completedAt: new Date(),
      })
      .where(eq(bookingExecutions.id, booking.id));

    // Persist the cached result under the same idempotency key so a retry
    // returns the same payload.
    await tx.update(idempotencyRecords)
      .set({ resultPayload: { results, status: finalStatus } })
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

    await recordAudit({
      ctx: params.ctx,
      action: "BOOKING_RESULT",
      tripId: params.tripId,
      planId: params.planId,
      summary: { orchestrationRequestId: params.orchestrationRequestId, status: finalStatus },
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
