import { z } from "zod";

// Google Flights returns airport-local wall-clock values. Preserve the source
// semantics and do not invent a timezone during normalization.
const serpApiDateTime = z.string().regex(
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/,
  "Expected a Google Flights local date-time",
).transform((value) => value.replace(" ", "T"));

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

const itinerarySchema = z.object({
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
  best_flights: z.array(itinerarySchema).optional().default([]),
  other_flights: z.array(itinerarySchema).optional().default([]),
}).passthrough();

export type SerpApiFlightSearchResponse = z.infer<typeof serpApiFlightSearchResponseSchema>;
