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
}).strict();

export type PersonalTripContext = z.infer<typeof personalTripContextSchema>;
