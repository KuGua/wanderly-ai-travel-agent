import { z } from "zod";

// Google Flights returns airport-local wall-clock values. Preserve the source
// semantics and do not invent a timezone during normalization.
const serpApiDateTime = z.string().regex(
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/,
  "Expected a Google Flights local date-time",
).transform((value) => {
  const normalized = value.replace(" ", "T");
  // Google Flights commonly returns airport-local wall-clock values at
  // minute precision.  The shared normalized FlightOffer contract requires
  // seconds, so add only the missing precision; do not invent a UTC offset.
  return normalized.length === 16 ? `${normalized}:00` : normalized;
});

const airportSchema = z.object({
  id: z.string().regex(/^[A-Z]{3}$/),
  time: serpApiDateTime,
}).passthrough();

const flightSegmentSchema = z.object({
  departure_airport: airportSchema,
  arrival_airport: airportSchema,
  duration: z.number().int().positive(),
  airline: z.string().min(1),
  flight_number: z.string().min(1),
  travel_class: z.string().min(1).optional(),
  extensions: z.array(z.string().min(1)).optional(),
}).passthrough();

/**
 * Validated per itinerary rather than as part of the response array, so a
 * single unpriced leg cannot discard the priced ones alongside it. Google
 * Flights omits `price` on some round-trip itineraries; as a required field
 * inside `z.array(itinerarySchema)` that turned a page with 10 usable
 * offers into `INVALID_PROVIDER_RESPONSE`.
 */
export const serpApiItinerarySchema = z.object({
  flights: z.array(flightSegmentSchema).min(1),
  total_duration: z.number().int().positive(),
  price: z.number().finite().nonnegative(),
  type: z.string().min(1).optional(),
}).passthrough();

/**
 * Strictly validate every field that enters normalized evidence, while
 * tolerating unrelated supplier additions. Provider metadata and supplier
 * links intentionally remain outside this contract and are never persisted.
 */
export const serpApiFlightSearchResponseSchema = z.object({
  search_metadata: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
  }).passthrough(),
  // Elements stay unparsed here; the provider validates each one with
  // `serpApiItinerarySchema` and keeps what passes.
  best_flights: z.array(z.unknown()).optional().default([]),
  other_flights: z.array(z.unknown()).optional().default([]),
}).passthrough();

export type SerpApiFlightSearchResponse = z.infer<typeof serpApiFlightSearchResponseSchema>;
export type SerpApiItinerary = z.infer<typeof serpApiItinerarySchema>;
