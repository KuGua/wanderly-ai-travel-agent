import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

export const amadeusTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
}).passthrough();

const amadeusSegmentSchema = z.object({
  departure: z.object({ iataCode: z.string().length(3), at: isoDateTime }).passthrough(),
  arrival: z.object({ iataCode: z.string().length(3), at: isoDateTime }).passthrough(),
  carrierCode: z.string().min(1),
  number: z.string().min(1),
  duration: z.string().min(1),
}).passthrough();

const amadeusItinerarySchema = z.object({
  duration: z.string().min(1),
  segments: z.array(amadeusSegmentSchema).min(1),
}).passthrough();

const amadeusTravelerPricingSchema = z.object({
  fareDetailsBySegment: z.array(z.object({
    cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
    includedCheckedBags: z.object({ quantity: z.number().int().nonnegative() }).optional(),
  }).passthrough()).min(1),
}).passthrough();

const amadeusOfferSchema = z.object({
  id: z.string().min(1),
  itineraries: z.array(amadeusItinerarySchema).min(1),
  price: z.object({ total: z.string().regex(/^\d+(?:\.\d+)?$/), currency: z.string().length(3) }).passthrough(),
  travelerPricings: z.array(amadeusTravelerPricingSchema).min(1),
  lastTicketingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).passthrough();

export const amadeusFlightOffersResponseSchema = z.object({
  data: z.array(amadeusOfferSchema),
}).passthrough();

export type AmadeusFlightOffersResponse = z.infer<typeof amadeusFlightOffersResponseSchema>;
