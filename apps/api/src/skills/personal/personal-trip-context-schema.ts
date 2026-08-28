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
  destinationCandidates: z.array(z.string().min(1).max(128)).max(20),
}).strict();

export type PersonalTripContext = z.infer<typeof personalTripContextSchema>;
