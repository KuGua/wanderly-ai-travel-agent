import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { airportServesCity, resolveAirportReference } from "../location-reference/airport-reference.js";
import { preflightCategorySlots } from "../services/plan-evidence-binding.js";
import type {
  AccommodationEvidence,
  ConstraintSnapshotData,
  ActivityEvidence,
  FlightOffer,
  HotelOffer,
  StayOffer,
} from "../types/domain.js";
import { assertFieldAllowed, assertFieldAllowedV2, SnapshotFieldNotAllowedError } from "./snapshot-policy.js";
import { CONSTRAINT_FIELD_CATALOG, type ConstraintFieldKey } from "./constraint-field-catalog.js";
import { evaluateHardConstraints } from "./hard-constraint-evaluator.js";
import { readMemoryProjection } from "../skills/shared/memory-projection-input.js";

const provenanceFields = {
  source: z.string(),
  capturedAt: z.string(),
};

const flightOfferSchema = z.object({
  id: z.string().min(1),
  providerOfferId: z.string().min(1),
  providerName: z.string().min(1),
  queryId: z.string().uuid(),
  origin: z.string().min(1),
  destination: z.string().min(1),
  segments: z.array(z.object({
    carrierCode: z.string().min(1),
    flightNumber: z.string().min(1),
    origin: z.string().min(1),
    destination: z.string().min(1),
    departureAt: z.string().min(1),
    arrivalAt: z.string().min(1),
    duration: z.string().min(1),
  }).strict()).min(1),
  totalDuration: z.string().min(1),
  totalPrice: z.number().nonnegative().finite(),
  currency: z.string().length(3),
  cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
  adults: z.number().int().min(1).max(9),
  baggageSummary: z.string().nullable(),
  changeSummary: z.string().nullable(),
  ...provenanceFields,
  expiresAt: z.string().datetime(),
  expiryProvenance: z.enum(["PROVIDER_VERIFIED", "SYNTHETIC"]),
}).strict();

const stayOfferSchema = z.object({
  id: z.string().min(1),
  destination: z.string().min(1),
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
  pricePerNightUsd: z.number().nonnegative().finite(),
  style: z.string().min(1),
  location: z.string().min(1),
  ...provenanceFields,
}).strict();

const activityEvidenceSchema = z.object({
  id: z.string().uuid(),
  providerOfferId: z.string().min(1),
  providerName: z.literal("viator"),
  queryId: z.string().uuid(),
  destination: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string().url(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  freeCancellation: z.boolean(),
  durationMinutes: z.object({
    fixed: z.number().int().nonnegative().nullable(),
    from: z.number().int().nonnegative().nullable(),
    to: z.number().int().nonnegative().nullable(),
  }).strict(),
  category: z.string().min(1).nullable(),
  fromPrice: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.string().min(1),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const hotelOfferSchema = z.object({
  id: z.string().uuid(), providerOfferId: z.string().min(1), queryId: z.string().uuid(),
  providerName: z.enum(["nuitee_connect", "serpapi_google_hotels"]), destinationId: z.string().min(1),
  propertyId: z.string().min(1), propertyName: z.string().min(1), checkIn: z.string(), checkOut: z.string(),
  nights: z.number().int().positive(), roomCount: z.number().int().positive(), adultsPerRoom: z.array(z.number().int().positive()),
  totalPrice: z.number().nonnegative(), pricePerNight: z.number().nonnegative(), currency: z.string().length(3),
  taxesAndFees: z.object({ status: z.enum(["INCLUDED", "PARTIAL", "UNKNOWN"]), amount: z.number().nonnegative().optional() }).strict(),
  cancellationSummary: z.string().nullable(), roomSummary: z.string().nullable(),
  source: z.string().min(1), capturedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const itineraryItemSchema = z.object({
  kind: z.enum(["FLIGHT", "BOOKED_ACTIVITY", "SUGGESTED_STOP", "FREE_TIME", "RETURN_TO_HOTEL"]),
  startTimeLocal: localTimeSchema,
  endTimeLocal: localTimeSchema,
  title: z.string().min(1).max(160),
  verification: z.enum(["PROVIDER_BACKED", "SUGGESTED"]),
  evidenceRef: z.object({ category: z.enum(["flights", "activities"]), id: z.string().min(1) }).strict().optional(),
}).strict();
const dailyItinerarySchema = z.array(z.object({
  date: z.string().date(),
  // We intentionally do not let the model assert an IANA zone. The card says
  // destination-local time; a future server-owned place-timezone resolver can
  // replace this closed value without trusting model geography.
  timeZone: z.literal("destination_local"),
  items: z.array(itineraryItemSchema).max(12),
}).strict()).max(31);

export const dailyItineraryUnavailableReasonSchema = z.enum([
  "MODEL_CONTRACT_REJECTED",
  "MODEL_TEMPORARILY_UNAVAILABLE",
  "CONTENT_REPAIR_EXHAUSTED",
  "CAPABILITY_NOT_CONFIGURED",
  "INTERNAL_ERROR",
  "LEGACY_UNKNOWN",
]);

export const dailyItineraryOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("READY"),
    days: dailyItinerarySchema,
    attempts: z.number().int().positive().max(3),
    checkedAt: z.string().datetime(),
  }).strict(),
  z.object({
    status: z.literal("UNAVAILABLE"),
    reason: dailyItineraryUnavailableReasonSchema,
    retryable: z.boolean(),
    attempts: z.number().int().nonnegative().max(3),
    checkedAt: z.string().datetime(),
  }).strict(),
]);

export type DailyItineraryOutcome = z.infer<typeof dailyItineraryOutcomeSchema>;

export const planOutputSchema = z.object({
  destination: z.string().min(1),
  // Optional for legacy plans. New planners (Team Agent 协作编排 Phase 3) emit
  // the full candidate set explicitly. When absent, the validator derives a
  // single-element set from `destination` so pre-Phase 3 plans still pass.
  destinationCandidatesEvaluated: z.array(z.string().min(1)).min(1).optional(),
  // May be empty. A flight provider that fails or refuses the request is a
  // capability gap, not grounds for withholding the whole plan: the other
  // capabilities' live evidence is still worth showing, and the missing one
  // renders as an explicit UNAVAILABLE row on the proposal card. What is
  // never permitted is inventing a flight to satisfy a schema — the offers
  // here are cross-checked against run-scoped provider evidence below.
  flights: z.array(flightOfferSchema),
  // Legacy-only compatibility for callers that still construct the old
  // in-memory shape. New model output is rejected at the gateway contract.
  stays: z.array(stayOfferSchema).optional(),
  activities: z.array(activityEvidenceSchema).optional(),
  hotels: z.array(hotelOfferSchema).optional(),
  /** A non-bookable LLM schedule; provider-backed entries must reference a selected offer. */
  dailyItinerary: dailyItinerarySchema.optional(),
  /** Legacy server-owned presentation state; new plans use the discriminated outcome. */
  dailyItineraryStatus: z.enum(["READY", "UNAVAILABLE"]).optional(),
  /** Server-owned result. New model output cannot set this field. */
  dailyItineraryOutcome: dailyItineraryOutcomeSchema.optional(),
  generatedAt: z.string().min(1),
  constraintReferences: z.array(z.string().min(1)).optional(),
  publicExplanationTokens: z.array(z.string().min(1)).optional(),
}).strict();

export type ValidatedPlanOutput = z.infer<typeof planOutputSchema>;

export type PlanViolationCode =
  | "STRUCTURE_INVALID"
  | "FIELD_NOT_AUTHORIZED"
  | "ORIGIN_NOT_ALLOWED"
  | "ORIGIN_MISSING"
  | "DESTINATION_NOT_ALLOWED"
  | "DESTINATION_MISMATCH"
  | "DESTINATION_CANDIDATES_INCOMPLETE"
  | "SOURCE_REQUIRED"
  | "PROVENANCE_REQUIRED"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_MISMATCH"
  | "EVIDENCE_SLOT_MISMATCH"
  | "DAILY_ITINERARY_DATE_COVERAGE"
  | "DAILY_ITINERARY_TIME_ORDER"
  | "DAILY_ITINERARY_EVIDENCE_REFERENCE"
  | "GENERATED_AT_MISMATCH"
  | "CONFIDENTIAL_VALUE_LEAK"
  | "EXPLANATION_TOKEN_NOT_ALLOWED"
  | "HARD_CONSTRAINT_UNSATISFIED";

export interface PlanValidationViolation {
  code: PlanViolationCode;
  fieldPath: string;
  reason: string;
}

export interface PlanProviderEvidence {
  flights: FlightOffer[];
  stays: StayOffer[];
  activities?: ActivityEvidence[];
  hotels?: HotelOffer[];
  accommodations?: AccommodationEvidence[];
}

export class PlanValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "PLAN_VALIDATION_FAILED";

  constructor(readonly violations: PlanValidationViolation[]) {
    super("Plan output failed deterministic validation");
    this.name = "PlanValidationError";
  }
}

/**
 * Does this flight endpoint name the same place as this snapshot city?
 *
 * A flight offer records controlled airport ids (`SIN`, `PVG`) because that is
 * what the suppliers take; the snapshot records the traveller's own words
 * (`Singapore`, `Shanghai`, `上海`). Comparing the two as strings meant no
 * offer could ever match its own plan: every flight would be both an origin
 * the snapshot did not allow and a destination that did not match. The route
 * identity used here is the one the rest of the system already uses —
 * `airportServesCity`, which normalises case, spacing, punctuation and
 * diacritics and passes CJK through (§#22).
 */
function routeEndpointMatches(endpoint: string, city: string): boolean {
  if (endpoint === city) return true;
  const airport = resolveAirportReference(endpoint);
  return airport !== null && airportServesCity(airport, city);
}

function addViolation(
  violations: PlanValidationViolation[],
  code: PlanViolationCode,
  fieldPath: string,
  reason: string,
): void {
  violations.push({ code, fieldPath, reason });
}

function dateRange(start: string, end: string): string[] {
  const days: string[] = [];
  // Trip dates are inclusive: travelDateEnd is the return day. Hotel search
  // may use it as a checkout boundary, but it remains a real travel day and
  // must be represented in the user-facing schedule.
  for (let cursor = new Date(`${start}T00:00:00.000Z`); cursor <= new Date(`${end}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function validateDailyItinerary(params: {
  plan: ValidatedPlanOutput;
  snapshot: ConstraintSnapshotData;
  required: boolean;
  violations: PlanValidationViolation[];
}): void {
  const outcome = params.plan.dailyItineraryOutcome;
  const hasLegacyState = params.plan.dailyItinerary !== undefined || params.plan.dailyItineraryStatus !== undefined;
  if (outcome && hasLegacyState) {
    addViolation(params.violations, "STRUCTURE_INVALID", "dailyItineraryOutcome", "New and legacy daily itinerary states cannot coexist");
  }
  const itinerary = outcome?.status === "READY" ? outcome.days : params.plan.dailyItinerary;
  if (!itinerary) {
    if (params.required) addViolation(params.violations, "STRUCTURE_INVALID", "dailyItinerary", "A daily itinerary is required for dated trips");
    if (params.plan.dailyItineraryStatus === "READY") {
      addViolation(params.violations, "STRUCTURE_INVALID", "dailyItineraryStatus", "A ready daily itinerary must contain days");
    }
    return;
  }
  if (outcome?.status === "UNAVAILABLE") {
    addViolation(params.violations, "STRUCTURE_INVALID", "dailyItineraryOutcome", "An unavailable daily itinerary must not contain days");
  }
  if (params.plan.dailyItineraryStatus === "UNAVAILABLE") {
    addViolation(params.violations, "STRUCTURE_INVALID", "dailyItineraryStatus", "An unavailable daily itinerary must not contain days");
  }
  const expectedDates = params.snapshot.travelDateStart && params.snapshot.travelDateEnd
    ? dateRange(params.snapshot.travelDateStart, params.snapshot.travelDateEnd) : [];
  if (expectedDates.length > 0 && itinerary.map((day) => day.date).join(",") !== expectedDates.join(",")) {
    addViolation(params.violations, "DAILY_ITINERARY_DATE_COVERAGE", "dailyItinerary", "Daily itinerary dates must cover the trip date range exactly");
  }
  const flightIds = new Set(params.plan.flights.map((offer) => offer.id));
  const activityIds = new Set((params.plan.activities ?? []).map((offer) => offer.id));
  itinerary.forEach((day, dayIndex) => {
    let previousEnd = "00:00";
    day.items.forEach((item, itemIndex) => {
      const path = `dailyItinerary.${dayIndex}.items.${itemIndex}`;
      if (item.endTimeLocal <= item.startTimeLocal || item.startTimeLocal < previousEnd) {
        addViolation(params.violations, "DAILY_ITINERARY_TIME_ORDER", path, "Daily itinerary items must be ordered and non-overlapping");
      }
      previousEnd = item.endTimeLocal;
      const requiresEvidence = item.kind === "FLIGHT" || item.kind === "BOOKED_ACTIVITY";
      if (requiresEvidence && (item.verification !== "PROVIDER_BACKED" || !item.evidenceRef)) {
        addViolation(params.violations, "DAILY_ITINERARY_EVIDENCE_REFERENCE", path, "Provider-backed itinerary items must reference selected evidence");
      }
      if (!requiresEvidence && (item.verification !== "SUGGESTED" || item.evidenceRef)) {
        addViolation(params.violations, "DAILY_ITINERARY_EVIDENCE_REFERENCE", path, "Suggested itinerary items must not claim provider evidence");
      }
      if (item.evidenceRef?.category === "flights" && (!requiresEvidence || !flightIds.has(item.evidenceRef.id))) {
        addViolation(params.violations, "DAILY_ITINERARY_EVIDENCE_REFERENCE", `${path}.evidenceRef`, "Flight itinerary reference is not selected evidence");
      }
      if (item.evidenceRef?.category === "activities" && (item.kind !== "BOOKED_ACTIVITY" || !activityIds.has(item.evidenceRef.id))) {
        addViolation(params.violations, "DAILY_ITINERARY_EVIDENCE_REFERENCE", `${path}.evidenceRef`, "Activity itinerary reference is not selected evidence");
      }
    });
  });
}

function validateOfferEvidence<T extends {
  id: string;
  source: string;
  capturedAt: string;
}>(params: {
  category: "flights" | "stays" | "ground" | "activities" | "hotels";
  offers: T[];
  evidence: T[];
  violations: PlanValidationViolation[];
}): void {
  params.offers.forEach((offer, index) => {
    const fieldPath = `${params.category}.${index}`;
    if (offer.source.trim().length === 0) {
      addViolation(params.violations, "SOURCE_REQUIRED", `${fieldPath}.source`, "Offer source is required");
    }
    if (
      offer.capturedAt.trim().length === 0
      || Number.isNaN(Date.parse(offer.capturedAt))
    ) {
      addViolation(params.violations, "PROVENANCE_REQUIRED", fieldPath, "Offer provenance is incomplete");
    }

    const knownOffer = params.evidence.find(candidate => candidate.id === offer.id);
    if (!knownOffer) {
      addViolation(params.violations, "EVIDENCE_NOT_FOUND", fieldPath, "Offer is not present in provider evidence");
    } else if (!isDeepStrictEqual(offer, knownOffer)) {
      addViolation(params.violations, "EVIDENCE_MISMATCH", fieldPath, "Offer does not exactly match provider evidence");
    }
  });
}

/**
 * Validate untrusted model output before it can become authoritative plan state.
 * Provider evidence is supplied separately because it is run-scoped data and is
 * intentionally not part of the immutable member-authorization snapshot.
 */
export function validatePlanOutput(params: {
  planData: unknown;
  snapshot: ConstraintSnapshotData;
  evidence: PlanProviderEvidence;
  requireActivities?: boolean;
  requireHotels?: boolean;
  requireDailyItinerary?: boolean;
}): ValidatedPlanOutput {
  // Preflight the original candidate, before either schema parsing or
  // evidence binding. A compact `{id}` in the wrong category deliberately
  // lacks the target slot's full fields, so waiting for the strict schema
  // would reduce the actionable mismatch to generic STRUCTURE_INVALID.
  if (typeof params.planData === "object" && params.planData !== null && !Array.isArray(params.planData)) {
    const preflight = preflightCategorySlots({
      candidate: params.planData as Record<string, unknown>,
      flights: params.evidence.flights,
      stays: params.evidence.stays,
      activities: params.evidence.activities ?? [],
      hotels: params.evidence.hotels,
      accommodations: params.evidence.accommodations,
    });
    if (preflight.length > 0) throw new PlanValidationError(preflight);
  }
  const parsed = planOutputSchema.safeParse(params.planData);
  if (!parsed.success) {
    throw new PlanValidationError(parsed.error.issues.map(issue => ({
      code: "STRUCTURE_INVALID",
      fieldPath: issue.path.join(".") || "planData",
      reason: "Plan output does not match the required structure",
    })));
  }

  const plan = parsed.data;
  const violations: PlanValidationViolation[] = [];

  validateDailyItinerary({ plan, snapshot: params.snapshot, required: params.requireDailyItinerary ?? false, violations });

  (plan.constraintReferences ?? []).forEach((fieldPath, index) => {
    try {
      if (fieldPath.startsWith("teamVisible.") || fieldPath.startsWith("orchestratorConfidential.")) {
        assertFieldAllowedV2(params.snapshot, fieldPath);
      } else {
        assertFieldAllowed(params.snapshot, fieldPath);
      }
    } catch (error) {
      if (error instanceof SnapshotFieldNotAllowedError) {
        addViolation(violations, "FIELD_NOT_AUTHORIZED", `constraintReferences.${index}`, "Snapshot field is not authorized");
      } else {
        throw error;
      }
    }
  });

  if (!params.snapshot.destinationCandidates.includes(plan.destination)) {
    addViolation(violations, "DESTINATION_NOT_ALLOWED", "destination", "Destination is not allowed by the snapshot");
  }

  // Spec §6.1: every configured destination candidate must be represented.
  // When `destinationCandidatesEvaluated` is absent (legacy plans), the
  // validator synthesizes a single-entry set from `destination` and lets
  // the destination-set assertion pass. New planners must supply the full
  // set explicitly.
  const evaluatedSet = plan.destinationCandidatesEvaluated ?? [plan.destination];
  const expectedCandidates = new Set(params.snapshot.destinationCandidates);
  const evaluated = new Set(evaluatedSet);
  const missingCandidates = params.snapshot.destinationCandidates.filter(c => !evaluated.has(c));
  if (missingCandidates.length > 0) {
    addViolation(
      violations,
      "DESTINATION_CANDIDATES_INCOMPLETE",
      "destinationCandidatesEvaluated",
      `Missing destination candidates in research coverage: ${missingCandidates.join(", ")}`,
    );
  }
  const extraCandidates = evaluatedSet.filter(c => !expectedCandidates.has(c));
  if (extraCandidates.length > 0) {
    addViolation(
      violations,
      "DESTINATION_CANDIDATES_INCOMPLETE",
      "destinationCandidatesEvaluated",
      `Plan lists destinations not in snapshot: ${extraCandidates.join(", ")}`,
    );
  }

  plan.flights.forEach((flight, index) => {
    if (!params.snapshot.departureCities.some((city) => routeEndpointMatches(flight.origin, city))) {
      addViolation(violations, "ORIGIN_NOT_ALLOWED", `flights.${index}.origin`, "Origin is not allowed by the snapshot");
    }
    if (!routeEndpointMatches(flight.destination, plan.destination)) {
      addViolation(violations, "DESTINATION_MISMATCH", `flights.${index}.destination`, "Offer destination does not match the plan");
    }
  });

  // Only meaningful once the capability produced anything at all. With some
  // flights but not all origins covered, a member genuinely cannot reach the
  // destination and the plan is wrong — that stays a hard violation. With no
  // flights whatsoever the capability is simply unavailable, which the gap
  // list already states; repeating it once per origin here would block the
  // plan the caller has decided to produce anyway.
  if (plan.flights.length > 0) {
    for (const origin of params.snapshot.departureCities) {
      if (!plan.flights.some(flight => routeEndpointMatches(flight.origin, origin))) {
        addViolation(violations, "ORIGIN_MISSING", "flights", "A required snapshot origin has no selected flight");
      }
    }
  }

  (plan.stays ?? []).forEach((stay, index) => {
    if (stay.destination !== plan.destination) {
      addViolation(violations, "DESTINATION_MISMATCH", `stays.${index}.destination`, "Offer destination does not match the plan");
    }
  });
  (plan.activities ?? []).forEach((activity, index) => {
    if (activity.destination !== plan.destination) {
      addViolation(violations, "DESTINATION_MISMATCH", `activities.${index}.destination`, "Activity destination does not match the plan");
    }
    if (Date.parse(activity.expiresAt) <= Date.now()) {
      addViolation(violations, "PROVENANCE_REQUIRED", `activities.${index}.expiresAt`, "Activity evidence has expired");
    }
  });
  (plan.hotels ?? []).forEach((hotel, index) => {
    if (hotel.destinationId !== plan.destination) addViolation(violations, "DESTINATION_MISMATCH", `hotels.${index}.destinationId`, "Hotel destination does not match the plan");
    if (Date.parse(hotel.expiresAt) <= Date.now()) addViolation(violations, "PROVENANCE_REQUIRED", `hotels.${index}.expiresAt`, "Hotel evidence has expired");
  });
  if (params.requireActivities && (plan.activities?.length ?? 0) === 0) {
    addViolation(violations, "EVIDENCE_NOT_FOUND", "activities", "A provider-backed activity is required for the selected destination");
  }
  if (params.requireHotels && (plan.hotels?.length ?? 0) === 0) {
    addViolation(violations, "EVIDENCE_NOT_FOUND", "hotels", "A provider-backed hotel is required for the selected destination");
  }

  validateOfferEvidence({ category: "flights", offers: plan.flights, evidence: params.evidence.flights, violations });
  validateOfferEvidence({ category: "stays", offers: plan.stays ?? [], evidence: params.evidence.stays, violations });
  validateOfferEvidence({ category: "activities", offers: plan.activities ?? [], evidence: params.evidence.activities ?? [], violations });
  validateOfferEvidence({ category: "hotels", offers: plan.hotels ?? [], evidence: params.evidence.hotels ?? [], violations });

  for (const hardViolation of evaluateHardConstraints({ snapshot: params.snapshot, flights: plan.flights })) {
    addViolation(violations, hardViolation.code, "constraints", hardViolation.publicReason);
  }

  // Deterministic confidentiality check (spec §6.1):
  //   - confidential values from the snapshot must NEVER appear in the plan JSON;
  //   - publicExplanationTokens, when supplied, must come from the snapshot's
  //     allow-list of safe tokens; free-form explanations are blocked.
  assertConfidentialFree({
    plan,
    snapshot: params.snapshot,
    violations,
  });

  // `generatedAt` must be the capture time of the freshest thing the plan
  // actually cites, so a reader can date the plan by its own evidence. A plan
  // that cites nothing has no such time and must not be persisted at all —
  // that is a distinct violation from a wrong one, and saying so is what keeps
  // an evidence-free shell from passing as a plan.
  const citedOffers = [...plan.flights, ...(plan.stays ?? []), ...(plan.activities ?? []), ...(plan.hotels ?? [])];
  if (citedOffers.length === 0) {
    addViolation(violations, "EVIDENCE_NOT_FOUND", "generatedAt", "A plan must cite at least one piece of provider evidence");
  } else {
    const expectedGeneratedAt = citedOffers.map(offer => offer.capturedAt).sort().at(-1);
    if (plan.generatedAt !== expectedGeneratedAt) {
      addViolation(violations, "GENERATED_AT_MISMATCH", "generatedAt", "Generation time does not match selected evidence");
    }
  }

  if (violations.length > 0) {
    throw new PlanValidationError(violations);
  }

  return plan;
}

/**
 * Spec §6.1 deterministic check.
 *
 * Walks the plan JSON for any byte-substring match against confidential values
 * from `snapshot.orchestratorConfidential` (v2). Also enforces that every
 * `publicExplanationToken` is on the allow-list derived from the field catalog
 * (defaulting to `SATISFIES_ALL_PRIVATE_CONSTRAINTS` / `OPTIMIZED_FOR_BUDGET` /
 * etc. white-listed by spec).
 *
 * Conservative by design — false positives are preferable to confidential leaks.
 */
export function assertConfidentialFree(params: {
  plan: ValidatedPlanOutput;
  snapshot: ConstraintSnapshotData;
  violations: PlanValidationViolation[];
}): void {
  const confidentialValues: string[] = [];
  const confidentialFieldKeys: string[] = [];
  const meta = readSnapshotV2MetaAuthorized(params.snapshot.authorizedData);
  if (meta) {
    for (const list of Object.values(meta.orchestratorConfidential ?? {})) {
      for (const item of list) {
        confidentialFieldKeys.push(item.fieldKey ?? "");
        const serialized = serializeForLeakCheck((item as { valueJson?: unknown }).valueJson);
        if (serialized) confidentialValues.push(serialized);
      }
    }
  }
  if (params.snapshot.orchestratorConfidential) {
    for (const list of Object.values(params.snapshot.orchestratorConfidential)) {
      for (const item of list) {
        if (item.visibility !== "ORCHESTRATOR_CONFIDENTIAL") continue;
        confidentialFieldKeys.push(item.fieldKey);
        const serialized = serializeForLeakCheck(item.valueJson);
        if (serialized) confidentialValues.push(serialized);
      }
    }
  }

  // Long-term memory keeps planning-only overrides in a separate namespace.
  // It is deliberately parsed by the same boundary used for planning: a
  // malformed namespace must not be treated as a reason to skip leak checks.
  try {
    const memory = readMemoryProjection(params.snapshot.authorizedData);
    for (const member of Object.values(memory.members)) {
      for (const [fieldKey, value] of Object.entries(member.confidentialOverrides)) {
        confidentialFieldKeys.push(fieldKey);
        const serialized = serializeForLeakCheck(value);
        if (serialized) confidentialValues.push(serialized);
      }
    }
  } catch {
    addViolation(
      params.violations,
      "CONFIDENTIAL_VALUE_LEAK",
      "authorizedData._meta.memory",
      "Memory projection is malformed and cannot be safely checked",
    );
    return;
  }

  const planString = serializeForLeakCheck(params.plan);
  if (!planString) return;

  for (const value of confidentialValues) {
    if (value.length >= 3 && planString.includes(value)) {
      addViolation(
        params.violations,
        "CONFIDENTIAL_VALUE_LEAK",
        "planData",
        `Plan output contains confidential value from a snapshot projection`,
      );
      return;
    }
  }
  for (const fieldKey of confidentialFieldKeys) {
    if (planString.includes(fieldKey)) {
      addViolation(
        params.violations,
        "CONFIDENTIAL_VALUE_LEAK",
        "planData",
        `Plan output references confidential field key "${fieldKey}"`,
      );
      return;
    }
  }

  if (params.plan.publicExplanationTokens && params.plan.publicExplanationTokens.length > 0) {
    const meta = readSnapshotV2MetaAuthorized(params.snapshot.authorizedData);
    const allowed = new Set<string>();
    if (meta) {
      for (const list of Object.values(meta.orchestratorConfidential ?? {})) {
        for (const item of list) {
          const descriptor = CONSTRAINT_FIELD_CATALOG[item.fieldKey as ConstraintFieldKey];
          if (descriptor) {
            for (const token of descriptor.safePublicExplanationTokens) allowed.add(token);
          }
        }
      }
      for (const list of Object.values(meta.teamVisible ?? {})) {
        for (const item of list) {
          const descriptor = CONSTRAINT_FIELD_CATALOG[(item as { fieldKey?: string }).fieldKey as ConstraintFieldKey];
          if (descriptor) {
            for (const token of descriptor.safePublicExplanationTokens) allowed.add(token);
          }
        }
      }
    }
    const fallback = params.snapshot.safePublicExplanationTokens;
    if (fallback) {
      for (const token of fallback) allowed.add(token);
    }
    if (allowed.size === 0) {
      addViolation(
        params.violations,
        "EXPLANATION_TOKEN_NOT_ALLOWED",
        "publicExplanationTokens",
        "Snapshot does not expose an explanation token allow-list",
      );
      return;
    }
    for (const token of params.plan.publicExplanationTokens) {
      if (!allowed.has(token)) {
        addViolation(
          params.violations,
          "EXPLANATION_TOKEN_NOT_ALLOWED",
          "publicExplanationTokens",
          `Token "${token}" is not on the safe allow-list`,
        );
        return;
      }
    }
  }
}

function readSnapshotV2MetaAuthorized(authorizedData: unknown): {
  schemaVersion: 2;
  teamVisible: Record<string, Array<{ fieldKey?: string }>>;
  orchestratorConfidential: Record<string, Array<{ fieldKey?: string }>>;
} | null {
  if (typeof authorizedData !== "object" || authorizedData === null) return null;
  const root = authorizedData as Record<string, unknown>;
  const meta = root._meta;
  if (!meta || typeof meta !== "object") return null;
  if ((meta as Record<string, unknown>).schemaVersion !== 2) return null;
  return meta as never;
}

function serializeForLeakCheck(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
