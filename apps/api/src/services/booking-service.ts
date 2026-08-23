import { db } from "../db/database.js";
import { bookingExecutions, itineraryPlans } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { checkAllConfirmed } from "./confirmation-service.js";
import { checkIdempotency, recordIdempotency } from "./idempotency-service.js";
import { recordAudit } from "./audit-service.js";
import { SANDBOX_CALLBACK_FIXTURES } from "../providers/fixtures.js";
import type { RequestContext } from "../utils/context.js";
import type { BookingExecutionResult, SandboxResult } from "../types/domain.js";

/**
 * Submit a booking request to the sandbox.
 * Only allowed if all required members have confirmed the latest active plan.
 */
export async function submitBooking(params: {
  ctx: RequestContext;
  planId: string;
  tripId: string;
  orchestrationRequestId: string;
  requestedBy: string;
}): Promise<BookingExecutionResult> {
  // Check idempotency
  const idempotencyKey = `booking:${params.orchestrationRequestId}`;
  const existing = await checkIdempotency(idempotencyKey);
  if (existing.exists) {
    return {
      orchestrationRequestId: params.orchestrationRequestId,
      results: (existing.result?.results as SandboxResult[]) ?? [],
      isDuplicate: true,
    };
  }

  // Verify plan is active
  const [plan] = await db.select().from(itineraryPlans)
    .where(eq(itineraryPlans.id, params.planId))
    .limit(1);

  if (!plan) throw new Error("Plan not found");
  if (plan.status !== "ACTIVE") throw new Error(`Cannot book plan with status ${plan.status}`);

  // Check all required members have confirmed
  const { allConfirmed } = await checkAllConfirmed({ planId: params.planId, tripId: params.tripId });
  if (!allConfirmed) throw new Error("Not all required members have confirmed this plan");

  // Create booking execution record
  const [booking] = await db.insert(bookingExecutions).values({
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
  });

  // Simulate sandbox call (demo fixture)
  const sandboxResults = SANDBOX_CALLBACK_FIXTURES.success.serviceResults;
  const results: SandboxResult[] = Object.entries(sandboxResults).map(([service, result]) => ({
    service,
    status: result.status,
    reference: result.reference,
    error: "error" in result ? String(result.error) : undefined,
  }));

  // Update booking with results
  await db.update(bookingExecutions)
    .set({
      status: results.every(r => r.status === "SUCCESS") ? "SUCCESS" : "FAILED",
      sandboxResults: sandboxResults as unknown as Record<string, unknown>,
      completedAt: new Date(),
    })
    .where(eq(bookingExecutions.id, booking.id));

  // Record idempotency
  await recordIdempotency({
    key: idempotencyKey,
    entityType: "booking",
    entityId: booking.id,
    resultPayload: { results },
  });

  await recordAudit({
    ctx: params.ctx,
    action: "BOOKING_RESULT",
    tripId: params.tripId,
    planId: params.planId,
    summary: { orchestrationRequestId: params.orchestrationRequestId, status: "SUCCESS" },
  });

  return {
    orchestrationRequestId: params.orchestrationRequestId,
    results,
    isDuplicate: false,
  };
}

/**
 * Handle sandbox callback (for async booking flows).
 * Idempotent: duplicate or out-of-order callbacks are handled gracefully.
 */
export async function handleSandboxCallback(params: {
  ctx: RequestContext;
  orchestrationRequestId: string;
  eventId: string;
  serviceResults: Record<string, { status: "SUCCESS" | "FAILED"; reference?: string; error?: string }>;
}): Promise<BookingExecutionResult> {
  // Check idempotency by eventId
  const idempotencyKey = `callback:${params.eventId}`;
  const existing = await checkIdempotency(idempotencyKey);
  if (existing.exists) {
    return {
      orchestrationRequestId: params.orchestrationRequestId,
      results: (existing.result?.results as SandboxResult[]) ?? [],
      isDuplicate: true,
    };
  }

  // Find booking by orchestrationRequestId
  const bookings = await db.select().from(bookingExecutions)
    .where(eq(bookingExecutions.orchestrationRequestId, params.orchestrationRequestId))
    .limit(1);

  if (bookings.length === 0) {
    throw new Error(`No booking found for orchestrationRequestId ${params.orchestrationRequestId}`);
  }

  const booking = bookings[0];

  // Check if booking is already completed (out-of-order callback)
  if (booking.status === "SUCCESS" || booking.status === "FAILED") {
    return {
      orchestrationRequestId: params.orchestrationRequestId,
      results: [],
      isDuplicate: true,
    };
  }

  const results: SandboxResult[] = Object.entries(params.serviceResults).map(([service, result]) => ({
    service,
    status: result.status,
    reference: result.reference,
    error: result.error,
  }));

  // Update booking
  await db.update(bookingExecutions)
    .set({
      status: results.every(r => r.status === "SUCCESS") ? "SUCCESS" : "FAILED",
      sandboxResults: params.serviceResults as unknown as Record<string, unknown>,
      completedAt: new Date(),
    })
    .where(eq(bookingExecutions.id, booking.id));

  // Record idempotency
  await recordIdempotency({
    key: idempotencyKey,
    entityType: "callback",
    entityId: booking.id,
    resultPayload: { results },
  });

  await recordAudit({
    ctx: params.ctx,
    action: "BOOKING_RESULT",
    tripId: booking.tripId,
    planId: booking.planId,
    summary: { orchestrationRequestId: params.orchestrationRequestId, eventId: params.eventId },
  });

  return {
    orchestrationRequestId: params.orchestrationRequestId,
    results,
    isDuplicate: false,
  };
}
