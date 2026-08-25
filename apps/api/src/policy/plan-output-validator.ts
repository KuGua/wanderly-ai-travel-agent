import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  ConstraintSnapshotData,
  FlightOffer,
  GroundOffer,
  StayOffer,
} from "../types/domain.js";
import { assertFieldAllowed, SnapshotFieldNotAllowedError } from "./snapshot-policy.js";

const provenanceFields = {
  source: z.string(),
  capturedAt: z.string(),
};

const flightOfferSchema = z.object({
  id: z.string().min(1),
  origin: z.string().min(1),
  destination: z.string().min(1),
  departureTime: z.string().min(1),
  arrivalTime: z.string().min(1),
  priceUsd: z.number().nonnegative().finite(),
  isRedEye: z.boolean(),
  airline: z.string().min(1),
  ...provenanceFields,
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

const groundOfferSchema = z.object({
  id: z.string().min(1),
  destination: z.string().min(1),
  type: z.enum(["airport_transfer", "local_transport"]),
  priceUsd: z.number().nonnegative().finite(),
  provider: z.string().min(1),
  ...provenanceFields,
}).strict();

export const planOutputSchema = z.object({
  destination: z.string().min(1),
  flights: z.array(flightOfferSchema).min(1),
  stays: z.array(stayOfferSchema).min(1),
  ground: z.array(groundOfferSchema).min(1),
  generatedAt: z.string().min(1),
  constraintReferences: z.array(z.string().min(1)).optional(),
}).strict();

export type ValidatedPlanOutput = z.infer<typeof planOutputSchema>;

export type PlanViolationCode =
  | "STRUCTURE_INVALID"
  | "FIELD_NOT_AUTHORIZED"
  | "ORIGIN_NOT_ALLOWED"
  | "ORIGIN_MISSING"
  | "DESTINATION_NOT_ALLOWED"
  | "DESTINATION_MISMATCH"
  | "SOURCE_REQUIRED"
  | "PROVENANCE_REQUIRED"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_MISMATCH"
  | "GENERATED_AT_MISMATCH";

export interface PlanValidationViolation {
  code: PlanViolationCode;
  fieldPath: string;
  reason: string;
}

export interface PlanProviderEvidence {
  flights: FlightOffer[];
  stays: StayOffer[];
  ground: GroundOffer[];
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
  category: "flights" | "stays" | "ground";
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
      assertFieldAllowed(params.snapshot, fieldPath);
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
  plan.ground.forEach((ground, index) => {
    if (ground.destination !== plan.destination) {
      addViolation(violations, "DESTINATION_MISMATCH", `ground.${index}.destination`, "Offer destination does not match the plan");
    }
  });

  validateOfferEvidence({ category: "flights", offers: plan.flights, evidence: params.evidence.flights, violations });
  validateOfferEvidence({ category: "stays", offers: plan.stays, evidence: params.evidence.stays, violations });
  validateOfferEvidence({ category: "ground", offers: plan.ground, evidence: params.evidence.ground, violations });

  const expectedGeneratedAt = [...plan.flights, ...plan.stays, ...plan.ground]
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
