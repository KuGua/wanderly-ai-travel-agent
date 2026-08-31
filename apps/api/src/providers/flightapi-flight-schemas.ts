import { z } from "zod";

/**
 * FlightAPI documents flight times as airport-local ISO-8601 wall-clock
 * values (for example `2024-04-02T14:19:00`), without a UTC offset. Preserve
 * that value rather than guessing an offset. Other providers may include an
 * offset, which is also accepted.
 */
const flightApiDateTime = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/,
  "Expected an ISO-8601 local or offset date-time",
);

const priceAmountSchema = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number),
  z.null().transform(() => undefined),
]);

const placeSchema = z.object({
  id: z.union([z.string(), z.number()]),
  // The documented response uses `iata_code`; the current live feed uses
  // `display_code`.  Accept either wire spelling, but never infer a code from
  // a name or other provider field.
  iata_code: z.string().regex(/^[A-Z]{3}$/).optional(),
  display_code: z.string().regex(/^[A-Z]{3}$/).optional(),
}).passthrough().superRefine((place, ctx) => {
  if (!place.iata_code && !place.display_code) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["iata_code"], message: "Expected an IATA airport code" });
  }
}).transform((place) => ({ ...place, iata_code: place.iata_code ?? place.display_code! }));

const legSchema = z.object({
  id: z.string().min(1),
  origin_place_id: z.union([z.string(), z.number()]),
  destination_place_id: z.union([z.string(), z.number()]),
  departure: flightApiDateTime,
  arrival: flightApiDateTime,
  duration: z.number().int().nonnegative(),
  segment_ids: z.array(z.string().min(1)).min(1),
}).passthrough();

const segmentSchema = z.object({
  id: z.string().min(1),
  origin_place_id: z.union([z.string(), z.number()]),
  destination_place_id: z.union([z.string(), z.number()]),
  departure: flightApiDateTime,
  arrival: flightApiDateTime,
  duration: z.number().int().nonnegative(),
  marketing_flight_number: z.union([z.string(), z.number()]),
  marketing_carrier_id: z.union([z.string(), z.number()]),
  // The documented response uses `mode`; the current live feed uses
  // `transport_mode`. Normalize spelling and casing, but still reject any
  // non-flight transport segment.
  mode: z.string().optional(),
  transport_mode: z.string().optional(),
}).passthrough().superRefine((segment, ctx) => {
  const mode = segment.mode ?? segment.transport_mode;
  if (!mode || mode.toLowerCase() !== "flight") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: "Expected flight transport mode" });
  }
}).transform((segment) => ({ ...segment, mode: (segment.mode ?? segment.transport_mode)!.toLowerCase() as "flight" }));

const pricedOptionSchema = z.object({
  id: z.string().min(1),
  // A response may include an unpriced OTA option beside otherwise usable
  // offers. Its missing/unusable amount must not invalidate a separate,
  // priced itinerary; normalization selects only usable price values.
  price: z.object({ amount: priceAmountSchema.optional() }).passthrough().optional(),
}).passthrough();

export const flightApiFlightSearchResponseSchema = z.object({
  itineraries: z.array(z.object({
    id: z.string().min(1),
    leg_ids: z.array(z.string().min(1)).min(1),
    cheapest_price: z.object({ amount: priceAmountSchema.optional() }).passthrough().optional(),
    pricing_options: z.array(pricedOptionSchema).optional(),
  }).passthrough()),
  legs: z.array(legSchema),
  segments: z.array(segmentSchema),
  places: z.array(placeSchema),
}).passthrough();

export type FlightApiFlightSearchResponse = z.infer<typeof flightApiFlightSearchResponseSchema>;
