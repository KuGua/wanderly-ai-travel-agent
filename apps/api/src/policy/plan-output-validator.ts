import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
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

export const planOutputSchema = z.object({
  destination: z.string().min(1),
  // Optional for legacy plans. New planners (Team Agent 协作编排 Phase 3) emit
  // the full candidate set explicitly. When absent, the validator derives a
  // single-element set from `destination` so pre-Phase 3 plans still pass.
  destinationCandidatesEvaluated: z.array(z.string().min(1)).min(1).optional(),
  flights: z.array(flightOfferSchema).min(1),
  // A missing stay provider/result is persisted as a Phase 4 service gap; it
  // must not force the LLM to invent a hotel offer.
  stays: z.array(stayOfferSchema),
  activities: z.array(activityEvidenceSchema).optional(),
  hotels: z.array(hotelOfferSchema).optional(),
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
}

export class PlanValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "PLAN_VALIDATION_FAILED";

  constructor(readonly violations: PlanValidationViolation[]) {
    super("Plan output failed deterministic validation");
    this.name = "PlanValidationError";
  }
}

function addViolation(
  violations: PlanValidationViolation[],
  code: PlanViolationCode,
  fieldPath: string,
  reason: string,
): void {
  violations.push({ code, fieldPath, reason });
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
}): ValidatedPlanOutput {
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
    if (!params.snapshot.departureCities.includes(flight.origin)) {
      addViolation(violations, "ORIGIN_NOT_ALLOWED", `flights.${index}.origin`, "Origin is not allowed by the snapshot");
    }
    if (flight.destination !== plan.destination) {
      addViolation(violations, "DESTINATION_MISMATCH", `flights.${index}.destination`, "Offer destination does not match the plan");
    }
  });

  for (const origin of params.snapshot.departureCities) {
    if (!plan.flights.some(flight => flight.origin === origin)) {
      addViolation(violations, "ORIGIN_MISSING", "flights", "A required snapshot origin has no selected flight");
    }
  }

  plan.stays.forEach((stay, index) => {
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
  validateOfferEvidence({ category: "stays", offers: plan.stays, evidence: params.evidence.stays, violations });
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

  const expectedGeneratedAt = [...plan.flights, ...plan.stays, ...(plan.activities ?? []), ...(plan.hotels ?? [])]
    .map(offer => offer.capturedAt)
    .sort()
    .at(-1);
  if (plan.generatedAt !== expectedGeneratedAt) {
    addViolation(violations, "GENERATED_AT_MISMATCH", "generatedAt", "Generation time does not match selected evidence");
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
