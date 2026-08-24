import { z } from "zod";
import type { ConstraintSnapshotData, FlightOffer, GroundOffer, StayOffer } from "../types/domain.js";
import type { SkillViolation } from "../agents/errors.js";

/**
 * Canonical schema for a validated Shared Trip plan output. The shape mirrors
 * the keys historically written into itinerary_plans.plan_data by MockModelGateway
 * and is what the Responses API's structured output must conform to.
 */

const flightOfferSchema = z.object({
  id: z.string(),
  origin: z.string(),
  destination: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  priceUsd: z.number(),
  isRedEye: z.boolean(),
  airline: z.string(),
  source: z.string().min(1),
  capturedAt: z.string().min(1),
  fixtureVersion: z.string(),
  isDemo: z.boolean(),
});

const stayOfferSchema = z.object({
  id: z.string(),
  destination: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  pricePerNightUsd: z.number(),
  style: z.string(),
  location: z.string(),
  source: z.string().min(1),
  capturedAt: z.string().min(1),
  fixtureVersion: z.string(),
  isDemo: z.boolean(),
});

const groundOfferSchema = z.object({
  id: z.string(),
  destination: z.string(),
  type: z.enum(["airport_transfer", "local_transport"]),
  priceUsd: z.number(),
  provider: z.string(),
  source: z.string().min(1),
  capturedAt: z.string().min(1),
  fixtureVersion: z.string(),
  isDemo: z.boolean(),
});

export const planOutputSchema = z.object({
  destination: z.string(),
  flights: z.array(flightOfferSchema),
  stays: z.array(stayOfferSchema),
  ground: z.array(groundOfferSchema),
  generatedAt: z.string().optional(),
});

export type PlanOutput = z.infer<typeof planOutputSchema>;

export interface AuthorizedMemberData {
  fields?: Record<string, unknown>;
  noRedEye?: boolean;
  accommodationStyle?: "city_center" | "budget" | "luxury" | string;
  budgetMaxUsd?: number;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** Keys we will not allow in plan output (sensitive field names). */
const PII_KEY_PATTERN = /(?:^|[^A-Za-z])(passportNumber|dateOfBirth|nationality)(?:$|[^A-Za-z])/i;
/** Loose regex for passport-like identifiers (e.g. AB1234567) appearing in values. */
const PASSPORT_VALUE_PATTERN = /\b[A-Z]{1,2}\d{6,9}\b/;

export type ValidatePlanOutputResult =
  | { ok: true }
  | { ok: false; violations: SkillViolation[] };

/**
 * Validate the structured output returned by the plan.comparison Skill. Enforces:
 *   - every offer's origin/destination is grounded in the snapshot;
 *   - noRedEye preference (when present) filters out red-eye flights;
 *   - accommodationStyle preference is honoured;
 *   - PII (passport, dob, nationality) never appears in the output;
 *   - every offer carries `source` and `capturedAt` provenance.
 */
export function validatePlanOutput(
  planData: Record<string, unknown>,
  snapshot: ConstraintSnapshotData,
  authorizedByUserId: Record<string, AuthorizedMemberData>,
): ValidatePlanOutputResult {
  const violations: SkillViolation[] = [];

  const flights = (planData.flights ?? []) as FlightOffer[];
  const stays = (planData.stays ?? []) as StayOffer[];
  const ground = (planData.ground ?? []) as GroundOffer[];

  flights.forEach((flight, i) => {
    if (!snapshot.departureCities.includes(flight.origin)) {
      violations.push({ path: `flights[${i}].origin`, reason: `Origin ${flight.origin} not in snapshot.departureCities` });
    }
    if (!snapshot.destinationCandidates.includes(flight.destination)) {
      violations.push({ path: `flights[${i}].destination`, reason: `Destination ${flight.destination} not in snapshot.destinationCandidates` });
    }
    if (!flight.source) {
      violations.push({ path: `flights[${i}].source`, reason: "Missing provider source" });
    }
    if (!flight.capturedAt) {
      violations.push({ path: `flights[${i}].capturedAt`, reason: "Missing capturedAt" });
    }
  });

  const anyNoRedEye = Object.values(authorizedByUserId).some(m => m.noRedEye === true);
  if (anyNoRedEye) {
    flights.forEach((flight, i) => {
      if (flight.isRedEye) {
        violations.push({ path: `flights[${i}].isRedEye`, reason: "Authorized member forbids red-eye flights" });
      }
    });
  }

  const preferredStyles = new Set(
    Object.values(authorizedByUserId)
      .map(m => m.accommodationStyle)
      .filter((s): s is string => typeof s === "string"),
  );

  stays.forEach((stay, i) => {
    if (!snapshot.destinationCandidates.includes(stay.destination)) {
      violations.push({ path: `stays[${i}].destination`, reason: `Stay destination ${stay.destination} not in snapshot.destinationCandidates` });
    }
    if (!stay.source) {
      violations.push({ path: `stays[${i}].source`, reason: "Missing provider source" });
    }
    if (!stay.capturedAt) {
      violations.push({ path: `stays[${i}].capturedAt`, reason: "Missing capturedAt" });
    }
    if (preferredStyles.size > 0 && !preferredStyles.has(stay.style)) {
      violations.push({ path: `stays[${i}].style`, reason: `Stay style ${stay.style} not in authorized styles ${[...preferredStyles].join(",")}` });
    }
  });

  ground.forEach((transfer, i) => {
    if (!snapshot.destinationCandidates.includes(transfer.destination)) {
      violations.push({ path: `ground[${i}].destination`, reason: `Ground destination ${transfer.destination} not in snapshot.destinationCandidates` });
    }
    if (!transfer.source) {
      violations.push({ path: `ground[${i}].source`, reason: "Missing provider source" });
    }
    if (!transfer.capturedAt) {
      violations.push({ path: `ground[${i}].capturedAt`, reason: "Missing capturedAt" });
    }
  });

  // PII gate: scan canonical-JSON of the planData for sensitive key names and
  // passport-shaped values. We intentionally scan values too — a model that
  // echoes a real passport number is worse than one that just uses a field
  // name (the latter would already be blocked by the FlightOffer Zod schema).
  const canonical = canonicalize(planData);
  if (PII_KEY_PATTERN.test(canonical)) {
    violations.push({ path: "$", reason: "Plan output references sensitive keys (passportNumber / dateOfBirth / nationality)" });
  }
  if (PASSPORT_VALUE_PATTERN.test(canonical)) {
    violations.push({ path: "$", reason: "Plan output appears to contain a passport-shaped value" });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}