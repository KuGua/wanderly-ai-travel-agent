import { z } from "zod";

/**
 * Server-derived minimal readonly Trip context that the Personal Agent
 * is permitted to see when answering the owner's private conversation
 * turn.  Compiled as a closed zod object so it is a compile-time error
 * to add member fields (snapshots, profile, other messages, etc.).
 *
 * Per docs/trip-scoped-private-threads-implementation.md §7, this is
 * the entire allow-list; any other field MUST be loaded through a
 * different Skill and never threaded into the conversation input.
 */
export const personalTripContextSchema = z.object({
  tripId: z.string().uuid(),
  tripName: z.string().min(1).max(256),
  tripStatus: z.enum(["DRAFT", "PLANNING", "STALE", "CONFIRMED", "BOOKED", "CANCELLED"]),
  travelDateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  travelDateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  travelDays: z.number().int().nullable(),
  departureCities: z.array(z.string().min(1).max(128)).max(20),
  destinationCandidates: z.array(z.string().min(1).max(128)).max(20),
  /**
   * Server-derived readiness for the Shared activation boundary. Mirrors
   * the web client's `canStartSharedPlanning` predicate so the conversation
   * prompt can authoritatively distinguish "ready" from "still missing
   * fields". The Personal Agent must NEVER cause a transition out of DRAFT
   * based on natural language alone — this flag controls *only* how the
   * prompt frames its reply; the DRAFT→PLANNING write is still gated on
   * `POST /trips/:tripId/activate`, which is owned by the UI CTA.
   */
  canStartSharedPlanning: z.boolean(),
  /**
   * Closed enum of fields that are still required before Shared planning
   * can be activated. Free-text brief contents are NEVER threaded here;
   * only the existence of each required field is communicated, so the
   * model can tell the user which slot is empty without seeing their
   * private conversation history.
   */
  missingFields: z.array(
    z.enum(["departure_city", "destination_city", "travel_dates"]),
  ).max(3),
  /**
   * Server-derived: whether another planning run can be offered right now.
   * Same value the trip DTO carries, from the same derivation, so the prompt
   * and the on-screen CTA cannot disagree.
   *
   * `canStartSharedPlanning` above answers only "is the DRAFT brief complete".
   * It goes false the instant a trip is activated, and until this field
   * existed there was nothing left to tell the model what had happened: the
   * handoff block went empty for every non-DRAFT trip, and the assistant kept
   * directing the traveller to a button that had disappeared. Carries no
   * member data — it is a four-valued server judgement, like the flag above.
   */
  sharedPlanningState: z.enum(["NOT_STARTED", "IN_PROGRESS", "NO_PLAN_YET", "PLAN_AVAILABLE"]),
}).strict();

export type PersonalTripContext = z.infer<typeof personalTripContextSchema>;
