/**
 * Personal Research Setup Sessions — service layer.
 *
 * Drives the conversational completion flow for Personal Research intent
 * drafts. The session is a per-intent-run, owner-only scratchpad that
 * collects structured answers (trip-level dates, departure city; per-cap
 * stay/flight preferences) and is committed atomically into the
 * authoritative trip-level / preferences tables at confirm time.
 *
 * Spec: docs/personal-research-intent-routing-implementation.md §9.
 *
 * Privacy contract:
 *   * No raw chat text, original question, free-text extraction, profile
 *     values, snapshot content, or provider raw data is stored here.
 *   * The audit summary only carries `{ sessionVersion, fieldsFilled }`
 *     (keys pass `whitelistSummary` — no PII keys).
 *   * The owner DTO carries only structured slot values.
 */

import { and, desc, eq, ne } from "drizzle-orm";

import { db } from "../db/database.js";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import {
  agentTaskRuns,
  personalResearchSetupSessions,
  sharedTrips,
  tripSearchPreferences,
  tripStaySearchPreferences,
  type personalResearchSetupStatusEnum,
} from "../db/schema.js";
import { requireResearchEligible } from "./trip-status-guard.js";
import { resolvePersistedHotelProviderName } from "../providers/live-provider-factory.js";
import { loadActiveQuoteNationality } from "./stay-search-provider-authorization.js";
import { saveConfirmedSearchPreferences } from "./flight-search-preferences-service.js";
import { saveConfirmedStaySearchPreferences } from "./stay-search-preferences-service.js";
import { createConstraintSnapshot } from "./planning-service.js";
import { recordAudit } from "./audit-service.js";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";
import {
  acceptResearchTask,
  findResearchTaskByRequestId,
  transitionResearchIntentState,
} from "../tasks/task-repository.js";
import { publishAgentStreamEvent } from "../tasks/task-stream-publisher.js";
import {
  personalResearchSetupAnswerSchema,
  personalResearchSetupSessionResponseSchema,
  tripSearchPreferencesRequestSchema,
  tripStaySearchPreferencesRequestSchema,
  type PersonalResearchSetupAnswer,
  type PersonalResearchSetupSessionResponse,
} from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";

// Inline structural type for the underlying Drizzle row. No `Tx` alias is
// needed here because every public function delegates to `db.transaction`,
// which infers the tx handle from the callback signature.

const SETUP_SESSION_TTL_MS = 15 * 60 * 1000;
const PERSONAL_RESEARCH_INTENT_STATE_PROPOSED = "PROPOSED" as const;
const PERSONAL_RESEARCH_INTENT_STATE_CONFIRMED = "CONFIRMED" as const;
const SETUP_SESSION_STATUS_OPEN = "OPEN" as const;
const SETUP_SESSION_STATUS_CONFIRMED = "CONFIRMED" as const;
const SETUP_SESSION_STATUS_EXPIRED = "EXPIRED" as const;
const SETUP_SESSION_STATUS_CANCELLED = "CANCELLED" as const;

type SetupStatus = (typeof personalResearchSetupStatusEnum)["enumValues"][number];

export type ResearchMissingCode =
  | "TRIP_NOT_ACTIVE"
  | "DESTINATION_NOT_CONFIGURED"
  | "DATES_MISSING"
  | "FLIGHT_PREFERENCES_MISSING"
  | "STAY_PREFERENCES_MISSING"
  | "HOTEL_PROVIDER_NOT_APPROVED"
  | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING"
  | "ROUTE_ENDPOINTS_UNCONFIRMED"
  | "MODE_NOT_CHOSEN";

type SetupRow = typeof personalResearchSetupSessions.$inferSelect;

interface SessionPatchInput {
  field: PersonalResearchSetupAnswer["field"];
  value: unknown;
}

interface OpenSessionInput {
  runId: string;
  ownerUserId: string;
  tripId: string;
}

interface ApplyAnswerInput {
  ctx: RequestContext;
  runId: string;
  ownerUserId: string;
  expectedVersion: number;
  patch: SessionPatchInput;
}

interface ConfirmAndSearchInput {
  ctx: RequestContext;
  runId: string;
  ownerUserId: string;
  tripId: string;
  requestId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function projectSetupRow(row: SetupRow): PersonalResearchSetupSessionResponse {
  return personalResearchSetupSessionResponseSchema.parse({
    intentRunId: row.intentRunId,
    tripId: row.tripId,
    ownerUserId: row.ownerUserId,
    departureCity: row.departureCity,
    travelDateStart: row.travelDateStart
      ? toIsoDate(row.travelDateStart)
      : null,
    travelDateEnd: row.travelDateEnd
      ? toIsoDate(row.travelDateEnd)
      : null,
    stayPreferences: row.stayPreferences,
    flightPreferences: row.flightPreferences,
    missing: row.missing as ResearchMissingCode[],
    version: row.version,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
  });
}

/**
 * Postgres `date` columns arrive as `string` (`YYYY-MM-DD`) or `Date`
 * depending on driver; normalize to the wire shape `YYYY-MM-DD`.
 */
function toIsoDate(value: string | Date): string {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    return parsed.toISOString().slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

function nextExpiry(): Date {
  return new Date(Date.now() + SETUP_SESSION_TTL_MS);
}

/**
 * Pure derivation of the still-missing codes for a given owner + trip +
 * requested capabilities, given the in-flight slot values. Mirrors
 * `personal-research-readiness-service#evaluateReadiness` for the codes
 * the conversational setup card can resolve; codes outside that set
 * (HOTEL_PROVIDER_NOT_APPROVED, QUOTE_NATIONALITY_AUTHORIZATION_MISSING,
 * TRIP_NOT_ACTIVE, DESTINATION_NOT_CONFIGURED, ROUTE_ENDPOINTS_UNCONFIRMED,
 * MODE_NOT_CHOSEN) are surfaced only through the read-only fallback card.
 */
export function computeMissingForSetup(params: {
  trip: Pick<typeof sharedTrips.$inferSelect, "travelDateStart" | "travelDateEnd" | "departureCities">;
  stayPreferences: SetupRow["stayPreferences"];
  flightPreferences: SetupRow["flightPreferences"];
  departureCity: string | null;
  travelDateStart: string | null;
  travelDateEnd: string | null;
  requestedCapabilities: ReadonlyArray<
    "flight" | "accommodation" | "hotel" | "activities" | "places" | "navigation" | "mobility" | "readiness"
  >;
}): ResearchMissingCode[] {
  const missing = new Set<ResearchMissingCode>();
  const needs = new Set(params.requestedCapabilities);

  const start = params.travelDateStart;
  const end = params.travelDateEnd;
  const tripHasDates = Boolean(params.trip.travelDateStart && params.trip.travelDateEnd);
  const sessionHasDates = Boolean(start && end && end > start);
  if (!tripHasDates && !sessionHasDates) missing.add("DATES_MISSING");

  if (
    (needs.has("flight") || needs.has("activities") || needs.has("mobility"))
    && params.flightPreferences === null
  ) {
    missing.add("FLIGHT_PREFERENCES_MISSING");
  }
  if (needs.has("hotel") && params.stayPreferences === null) {
    missing.add("STAY_PREFERENCES_MISSING");
  }
  return Array.from(missing);
}

function uniqueSlots<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Open a setup session for the given intent run, or return the existing
 * OPEN one. Closes older `OPEN` siblings via the partial unique
 * index `(trip_id, owner_user_id) WHERE status = 'OPEN'` and writes the
 * freshly computed `missing[]` so the owner always sees a consistent view.
 */
export async function getOrOpenSession(params: OpenSessionInput & {
  requestedCapabilities: ReadonlyArray<
    "flight" | "accommodation" | "hotel" | "activities" | "places" | "navigation" | "mobility" | "readiness"
  >;
  ctx: RequestContext;
}): Promise<PersonalResearchSetupSessionResponse> {
  const [trip] = await db.select().from(sharedTrips).where(eq(sharedTrips.id, params.tripId)).limit(1);
  if (!trip) throw new ApiError(404, "Not Found", "Trip not found while opening setup session");

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(personalResearchSetupSessions)
      .where(eq(personalResearchSetupSessions.intentRunId, params.runId))
      .for("update")
      .limit(1);

    if (existing) {
      if (existing.ownerUserId !== params.ownerUserId) {
        throw new ApiError(403, "Forbidden", "Setup session is owned by a different user");
      }
      if (existing.tripId !== params.tripId) {
        throw new ApiError(409, "Conflict", "Setup session is bound to a different trip");
      }
      if (existing.status !== SETUP_SESSION_STATUS_OPEN) {
        throw new ApiError(409, "Conflict", `Setup session is ${existing.status}`);
      }
      // Refresh expiry + missing list so a stale OPEN row stays useful.
      const missing = computeMissingForSetup({
        trip,
        stayPreferences: existing.stayPreferences,
        flightPreferences: existing.flightPreferences,
        departureCity: existing.departureCity,
        travelDateStart: existing.travelDateStart ? toIsoDate(existing.travelDateStart) : null,
        travelDateEnd: existing.travelDateEnd ? toIsoDate(existing.travelDateEnd) : null,
        requestedCapabilities: params.requestedCapabilities,
      });
      const [refreshed] = await tx.update(personalResearchSetupSessions)
        .set({
          expiresAt: nextExpiry(),
          missing,
          updatedAt: new Date(),
        })
        .where(eq(personalResearchSetupSessions.intentRunId, params.runId))
        .returning();
      return projectSetupRow(refreshed!);
    }

    // This is a new intent run. It replaces only another active setup for
    // this owner/trip; terminal rows are retained as an audit trail.
    await tx.update(personalResearchSetupSessions)
      .set({
        status: "SUPERSEDED" satisfies SetupStatus,
        updatedAt: new Date(),
      })
      .where(and(
        eq(personalResearchSetupSessions.tripId, params.tripId),
        eq(personalResearchSetupSessions.ownerUserId, params.ownerUserId),
        eq(personalResearchSetupSessions.status, SETUP_SESSION_STATUS_OPEN),
        ne(personalResearchSetupSessions.intentRunId, params.runId),
      ));

    const missing = computeMissingForSetup({
      trip,
      stayPreferences: null,
      flightPreferences: null,
      departureCity: null,
      travelDateStart: null,
      travelDateEnd: null,
      requestedCapabilities: params.requestedCapabilities,
    });

    const [created] = await tx.insert(personalResearchSetupSessions).values({
      intentRunId: params.runId,
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      missing,
      version: 1,
      status: SETUP_SESSION_STATUS_OPEN,
      expiresAt: nextExpiry(),
    }).returning();
    await recordAudit({
      ctx: params.ctx,
      action: "PERSONAL_RESEARCH_SETUP_OPENED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: { sessionVersion: created!.version, fieldsFilled: [] },
      tx,
    });
    return projectSetupRow(created!);
  });
}

export async function loadSessionForOwner(params: {
  runId: string;
  ownerUserId: string;
}): Promise<PersonalResearchSetupSessionResponse | null> {
  const [row] = await db.select().from(personalResearchSetupSessions)
    .where(eq(personalResearchSetupSessions.intentRunId, params.runId))
    .limit(1);
  if (!row || row.ownerUserId !== params.ownerUserId) return null;
  if (row.status !== SETUP_SESSION_STATUS_OPEN) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return projectSetupRow(row);
}

/**
 * Apply a single-field patch under optimistic-version concurrency.
 * Refuses non-OPEN, expired, or version-mismatched rows with a 409/410.
 */
export async function applyAnswer(input: ApplyAnswerInput): Promise<PersonalResearchSetupSessionResponse> {
  const parsedPatch = personalResearchSetupAnswerSchema.parse(input.patch);

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(personalResearchSetupSessions)
      .where(eq(personalResearchSetupSessions.intentRunId, input.runId))
      .for("update")
      .limit(1);
    if (!row) throw new ApiError(404, "Not Found", "Setup session not found");
    if (row.ownerUserId !== input.ownerUserId) {
      throw new ApiError(403, "Forbidden", "Setup session is owned by a different user");
    }
    if (row.status !== SETUP_SESSION_STATUS_OPEN) {
      throw new ApiError(409, "Conflict", `Setup session is ${row.status}`);
    }
    if (row.version !== input.expectedVersion) {
      throw new ApiError(409, "Conflict", "Setup session version mismatch");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      // Opportunistic expiry mark.
      await tx.update(personalResearchSetupSessions)
        .set({ status: SETUP_SESSION_STATUS_EXPIRED, updatedAt: new Date() })
        .where(eq(personalResearchSetupSessions.intentRunId, input.runId));
      await recordAudit({
        ctx: input.ctx,
        action: "PERSONAL_RESEARCH_SETUP_EXPIRED",
        actorUserId: input.ownerUserId,
        tripId: row.tripId,
        summary: { sessionVersion: row.version },
        tx,
      });
      throw new ApiError(410, "Gone", "Setup session has expired");
    }

    const nextDepartureCity = parsedPatch.field === "departureCity" ? parsedPatch.value : row.departureCity;
    const nextTravelDateStart = parsedPatch.field === "travelDates"
      ? parsedPatch.value.start
      : (row.travelDateStart ? toIsoDate(row.travelDateStart) : null);
    const nextTravelDateEnd = parsedPatch.field === "travelDates"
      ? parsedPatch.value.end
      : (row.travelDateEnd ? toIsoDate(row.travelDateEnd) : null);
    const nextStay = parsedPatch.field === "stayPreferences" ? parsedPatch.value : row.stayPreferences;
    const nextFlight = parsedPatch.field === "flightPreferences" ? parsedPatch.value : row.flightPreferences;

    // Cross-field validation: dates must be a valid pair (server-side mirror
    // of `routes/trips.ts#isValidTripDate`).
    if (nextTravelDateStart && nextTravelDateEnd && nextTravelDateEnd <= nextTravelDateStart) {
      throw new ApiError(422, "Unprocessable Entity", "travelDateEnd must be after travelDateStart");
    }

    const [trip] = await tx.select().from(sharedTrips).where(eq(sharedTrips.id, row.tripId)).limit(1);
    if (!trip) throw new ApiError(404, "Not Found", "Trip not found while applying setup answer");
    const [intentRun] = await tx.select({ researchIntentDraft: agentTaskRuns.researchIntentDraft })
      .from(agentTaskRuns)
      .where(eq(agentTaskRuns.id, row.intentRunId))
      .limit(1);
    if (!intentRun?.researchIntentDraft) {
      throw new ApiError(409, "Conflict", "Research intent is no longer available");
    }

    const missing = computeMissingForSetup({
      trip,
      stayPreferences: nextStay,
      flightPreferences: nextFlight,
      departureCity: nextDepartureCity,
      travelDateStart: nextTravelDateStart,
      travelDateEnd: nextTravelDateEnd,
      requestedCapabilities: intentRun.researchIntentDraft.requestedCapabilities,
    });

    const [updated] = await tx.update(personalResearchSetupSessions)
      .set({
        departureCity: nextDepartureCity,
        travelDateStart: nextTravelDateStart ?? null,
        travelDateEnd: nextTravelDateEnd ?? null,
        stayPreferences: nextStay,
        flightPreferences: nextFlight,
        missing: uniqueSlots(missing),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(personalResearchSetupSessions.intentRunId, input.runId))
      .returning();

    await recordAudit({
      ctx: input.ctx,
      action: "PERSONAL_RESEARCH_SETUP_UPDATED",
      actorUserId: input.ownerUserId,
      tripId: row.tripId,
      summary: {
        sessionVersion: updated!.version,
        fieldsFilled: [parsedPatch.field],
      },
      tx,
    });
    return projectSetupRow(updated!);
  });
}

export async function cancelSession(input: {
  ctx: RequestContext;
  runId: string;
  ownerUserId: string;
}): Promise<{ status: "CANCELLED" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(personalResearchSetupSessions)
      .where(eq(personalResearchSetupSessions.intentRunId, input.runId))
      .for("update")
      .limit(1);
    if (!row || row.ownerUserId !== input.ownerUserId) {
      throw new ApiError(404, "Not Found", "Setup session not found");
    }
    if (row.status === SETUP_SESSION_STATUS_CANCELLED) {
      return { status: "CANCELLED" };
    }
    if (row.status === SETUP_SESSION_STATUS_CONFIRMED) {
      throw new ApiError(409, "Conflict", "Setup session is already confirmed");
    }
    await tx.update(personalResearchSetupSessions)
      .set({ status: SETUP_SESSION_STATUS_CANCELLED, updatedAt: new Date() })
      .where(eq(personalResearchSetupSessions.intentRunId, input.runId));
    await recordAudit({
      ctx: input.ctx,
      action: "PERSONAL_RESEARCH_SETUP_CANCELLED",
      actorUserId: input.ownerUserId,
      tripId: row.tripId,
      summary: { sessionVersion: row.version },
      tx,
    });
    return { status: "CANCELLED" };
  });
}

/**
 * Atomic confirm: re-validate everything, write trip-level fields, save
 * preference-table slots, stale-cascade, audit, transition intent,
 * accept RESEARCH task, publish SNAPSHOT_CREATED.
 */
export async function confirmAndSearch(input: ConfirmAndSearchInput): Promise<{
  runId: string;
  snapshotId: string;
  status: "QUEUED";
}> {
  return db.transaction(async (tx) => {
    const session = await tx.select().from(personalResearchSetupSessions)
      .where(eq(personalResearchSetupSessions.intentRunId, input.runId))
      .for("update")
      .limit(1);
    const sessionRow = session[0];

    // Idempotency short-circuit: if the same requestId already produced a
    // RESEARCH task for this trip, mark the session CONFIRMED and return
    // the existing envelope without re-running any state mutation.
    const preExisting = await findResearchTaskByRequestId({
      tripId: input.tripId,
      requestId: input.requestId,
      tx,
    });
    if (preExisting) {
      if (sessionRow && sessionRow.status !== SETUP_SESSION_STATUS_CONFIRMED) {
        await tx.update(personalResearchSetupSessions)
          .set({ status: SETUP_SESSION_STATUS_CONFIRMED, updatedAt: new Date() })
          .where(eq(personalResearchSetupSessions.intentRunId, input.runId));
      }
      return {
        runId: preExisting.runId,
        snapshotId: preExisting.snapshotId,
        status: "QUEUED" as const,
      };
    }
    if (!sessionRow) throw new ApiError(404, "Not Found", "Setup session not found");
    const row = sessionRow;
    if (row.ownerUserId !== input.ownerUserId) {
      throw new ApiError(403, "Forbidden", "Setup session is owned by a different user");
    }
    if (row.tripId !== input.tripId) {
      throw new ApiError(409, "Conflict", "Setup session trip mismatch");
    }
    if (row.status === SETUP_SESSION_STATUS_CONFIRMED) {
      const existing = await findResearchTaskByRequestId({
        tripId: input.tripId,
        requestId: input.requestId,
        tx,
      });
      if (existing) {
        return { runId: existing.runId, snapshotId: existing.snapshotId, status: "QUEUED" as const };
      }
      throw new ApiError(409, "Conflict", "Setup session is already confirmed");
    }
    if (row.status !== SETUP_SESSION_STATUS_OPEN) {
      throw new ApiError(410, "Gone", `Setup session is ${row.status}`);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await tx.update(personalResearchSetupSessions)
        .set({ status: SETUP_SESSION_STATUS_EXPIRED, updatedAt: new Date() })
        .where(eq(personalResearchSetupSessions.intentRunId, input.runId));
      await recordAudit({
        ctx: input.ctx,
        action: "PERSONAL_RESEARCH_SETUP_EXPIRED",
        actorUserId: input.ownerUserId,
        tripId: row.tripId,
        summary: { sessionVersion: row.version },
        tx,
      });
      throw new ApiError(410, "Gone", "Setup session has expired");
    }
    const fieldsFilled = collectFilledFields(row);
    if (fieldsFilled.length === 0) {
      throw new ApiError(422, "Unprocessable Entity", "Setup session is empty");
    }

    // ─── Re-validate the intent run + trip ────────────────────────────────
    const intentRunRows = await tx.select().from(agentTaskRuns)
      .where(eq(agentTaskRuns.id, input.runId))
      .for("update")
      .limit(1);
    const intentRun = intentRunRows[0];
    if (!intentRun || intentRun.operation !== "CONVERSATION") {
      throw new ApiError(409, "Conflict", "Research intent run is no longer available");
    }
    if (intentRun.researchIntentState !== PERSONAL_RESEARCH_INTENT_STATE_PROPOSED) {
      throw new ApiError(409, "Conflict", "Research intent is no longer available for confirmation");
    }
    const draftCapabilities = (intentRun.researchIntentDraft?.requestedCapabilities ?? []) as Array<
      "flight" | "accommodation" | "hotel" | "activities" | "places" | "navigation" | "mobility" | "readiness"
    >;
    if (draftCapabilities.includes("hotel") && process.env.PLAN_ENABLE_HOTEL !== "true") {
      throw new ApiError(422, "Unprocessable Entity", "Hotel research is not enabled for this environment");
    }

    const tripRows = await tx.select().from(sharedTrips).where(eq(sharedTrips.id, input.tripId)).limit(1);
    const trip = tripRows[0];
    if (!trip) throw new ApiError(404, "Not Found", "Trip not found");
    if (trip.status !== "PLANNING" && trip.status !== "STALE") {
      throw new ApiError(409, "Conflict", "Trip is not research-eligible");
    }

    const unresolved = computeMissingForSetup({
      trip,
      stayPreferences: row.stayPreferences,
      flightPreferences: row.flightPreferences,
      departureCity: row.departureCity,
      travelDateStart: row.travelDateStart ? toIsoDate(row.travelDateStart) : null,
      travelDateEnd: row.travelDateEnd ? toIsoDate(row.travelDateEnd) : null,
      requestedCapabilities: draftCapabilities,
    });
    if (unresolved.length > 0) {
      throw new ApiError(422, "Unprocessable Entity", "Setup session still has required fields missing");
    }

    await requireResearchEligible(input.tripId, input.ownerUserId, trip.destinationCandidates, tx);

    const provider = resolvePersistedHotelProviderName();
    if (provider === "nuitee_connect") {
      const authz = await loadActiveQuoteNationality({
        tripId: input.tripId,
        memberId: input.ownerUserId,
      });
      if (!authz) {
        throw new ApiError(422, "Unprocessable Entity", "A confirmed Nuitee hotel quote nationality is required");
      }
    }

    // ─── Write trip-level fields (if changed) ─────────────────────────────
    const tripUpdate: Partial<typeof sharedTrips.$inferInsert> = {};
    if (
      row.departureCity
      && !trip.departureCities.includes(row.departureCity)
    ) {
      tripUpdate.departureCities = [...trip.departureCities, row.departureCity];
    }
    if (row.travelDateStart && toIsoDate(row.travelDateStart) !== trip.travelDateStart) {
      tripUpdate.travelDateStart = toIsoDate(row.travelDateStart);
    }
    if (row.travelDateEnd && toIsoDate(row.travelDateEnd) !== trip.travelDateEnd) {
      tripUpdate.travelDateEnd = toIsoDate(row.travelDateEnd);
    }
    if (Object.keys(tripUpdate).length > 0) {
      tripUpdate.updatedAt = new Date();
      await tx.update(sharedTrips)
        .set(tripUpdate)
        .where(eq(sharedTrips.id, input.tripId));
    }

    // ─── Write preference-table slots (in the same tx) ────────────────────
    if (row.flightPreferences) {
      const flightInput = tripSearchPreferencesRequestSchema.parse(row.flightPreferences);
      await saveConfirmedSearchPreferences({
        ctx: input.ctx,
        tripId: input.tripId,
        confirmedBy: input.ownerUserId,
        input: flightInput,
        tx,
      });
    }
    if (row.stayPreferences) {
      const stayInput = tripStaySearchPreferencesRequestSchema.parse(row.stayPreferences);
      await saveConfirmedStaySearchPreferences({
        ctx: input.ctx,
        tripId: input.tripId,
        confirmedBy: input.ownerUserId,
        input: stayInput,
        tx,
      });
    }

    // Re-read the latest pref versions so the bound RESEARCH task sees the
    // post-write rows (handles the case where the trip already had older
    // flight prefs but no stay prefs, etc.).
    const latestFlightRows = await tx.select().from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, input.tripId))
      .orderBy(desc(tripSearchPreferences.version)).limit(1);
    const latestStayRows = await tx.select().from(tripStaySearchPreferences)
      .where(eq(tripStaySearchPreferences.tripId, input.tripId))
      .orderBy(desc(tripStaySearchPreferences.version)).limit(1);

    // ─── Stale-cascade BEFORE acceptResearchTask ───────────────────────────
    // `agent_task_runs_one_active_planning` partial unique index frees its
    // slot only after the prior run is marked STALE. The order is fixed:
    // stale → accept.
    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: input.tripId,
      reason: "personal_research_setup_confirmed",
    });

    const snapshotId = await createConstraintSnapshot({
      tripId: input.tripId,
      memberIds: [],
      departureCities: tripUpdate.departureCities ?? trip.departureCities,
      destinationCandidates: trip.destinationCandidates,
      ...((tripUpdate.travelDateStart ?? trip.travelDateStart)
        ? { travelDateStart: (tripUpdate.travelDateStart ?? trip.travelDateStart)! }
        : {}),
      ...((tripUpdate.travelDateEnd ?? trip.travelDateEnd)
        ? { travelDateEnd: (tripUpdate.travelDateEnd ?? trip.travelDateEnd)! }
        : {}),
      tx,
    });

    await recordAudit({
      ctx: input.ctx,
      action: "PERSONAL_RESEARCH_SETUP_CONFIRMED",
      actorUserId: input.ownerUserId,
      tripId: input.tripId,
      summary: {
        sessionVersion: row.version,
        fieldsFilled,
      },
      tx,
    });

    await tx.update(personalResearchSetupSessions)
      .set({ status: SETUP_SESSION_STATUS_CONFIRMED, updatedAt: new Date() })
      .where(eq(personalResearchSetupSessions.intentRunId, input.runId));

    const transitioned = await transitionResearchIntentState({
      runId: input.runId,
      fromState: PERSONAL_RESEARCH_INTENT_STATE_PROPOSED,
      toState: PERSONAL_RESEARCH_INTENT_STATE_CONFIRMED,
      tx,
    });
    if (!transitioned) {
      throw new ApiError(409, "Conflict", "Research intent is no longer available for confirmation");
    }

    const accepted = await acceptResearchTask({
      ctx: input.ctx,
      tripId: input.tripId,
      userId: input.ownerUserId,
      snapshotId,
      flightSearchPreferencesVersion: latestFlightRows[0]?.version,
      staySearchPreferencesVersion: latestStayRows[0]?.version,
      outputMode: intentRun.researchIntentDraft?.kind ?? "RESEARCH_ONLY",
      requestedCapabilities: draftCapabilities,
      originatingIntentRunId: input.runId,
      hotelProvider: draftCapabilities.includes("hotel") ? undefined : null,
      requestId: input.requestId,
      tx,
    });

    metrics.inc("personal_research_setup_session_total", {
      outcome: "confirmed",
    });

    // Fire SSE after the tx commits — see below.
    queueMicrotask(() => {
      void publishAgentStreamEvent({
        event: "research.stage",
        runId: accepted.runId,
        generationAttempt: 0,
        stage: "SNAPSHOT_CREATED",
        traceparent: input.ctx.traceparent,
      });
    });

    return {
      runId: accepted.runId,
      snapshotId: accepted.snapshotId,
      status: "QUEUED" as const,
    };
  });
}

function collectFilledFields(session: SetupRow): string[] {
  const filled: string[] = [];
  if (session.departureCity) filled.push("departureCity");
  if (session.travelDateStart && session.travelDateEnd) {
    filled.push("travelDateStart", "travelDateEnd");
  }
  if (session.stayPreferences) filled.push("stayPreferences");
  if (session.flightPreferences) filled.push("flightPreferences");
  return filled;
}
