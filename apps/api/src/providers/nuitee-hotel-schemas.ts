import { z } from "zod";

/**
 * Permissive Zod schemas for the Nuitee Connect / LiteAPI Rates response.
 *
 * Spec: docs/nuitee-serpapi-hotel-provider-switching-implementation.md §4.2
 *
 * The contract evolves; the adapter validates only the fields it consumes
 * and lets unknown top-level keys pass through so a schema drift on
 * cosmetic fields does not fail closed. Adapter failures are
 * `INVALID_PROVIDER_RESPONSE` — never a synthesized empty result.
 */

const moneyAmountSchema = z.number().finite().nonnegative();

/**
 * Nuitee `error` envelope. The MVP cares only about `code === "2001"`
 * (no rates available), which the adapter maps to `NO_RESULTS`. Any
 * other error code or message becomes `UPSTREAM_FAILURE`.
 */
export const nuiteeErrorSchema = z.object({
  code: z.union([z.string(), z.number()]),
  message: z.string().optional(),
}).strict();

const nuiteeCancellationPolicySchema = z.object({
  type: z.string().optional(),
  description: z.string().max(2_000).nullable().optional(),
  cancelDeadlineIso: z.string().datetime({ offset: true }).nullable().optional(),
}).passthrough();

const nuiteeRoomSchema = z.object({
  roomType: z.string().max(256).nullable().optional(),
  description: z.string().max(2_000).nullable().optional(),
  adults: z.number().int().positive().optional(),
  children: z.number().int().nonnegative().optional(),
}).passthrough();

const nuiteeRateSchema = z.object({
  rateId: z.string().min(1).max(256),
  roomTypes: z.array(nuiteeRoomSchema).max(20).optional(),
  retailRate: z.object({
    totalAmount: moneyAmountSchema,
    currency: z.string().length(3),
    taxesAndFeesAmount: moneyAmountSchema.optional(),
    taxesAndFeesIncluded: z.boolean().optional(),
  }).strict(),
  cancellationPolicies: z.object({
    cancellationPolicy: z.array(nuiteeCancellationPolicySchema).max(20).nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const nuiteeHotelSchema = z.object({
  hotelId: z.string().min(1).max(256),
  name: z.string().min(1).max(512),
  city: z.string().max(256).nullable().optional(),
  countryCode: z.string().length(2).nullable().optional(),
  address: z.string().max(2_000).nullable().optional(),
  starRating: z.number().min(0).max(5).nullable().optional(),
  thumbnailUrl: z.string().url().max(2_048).nullable().optional(),
  rates: z.array(nuiteeRateSchema).max(50),
}).passthrough();

export const nuiteeHotelRatesResponseSchema = z.object({
  data: z.array(nuiteeHotelSchema).max(200).optional(),
  error: nuiteeErrorSchema.optional(),
}).passthrough();

export type NuiteeHotelRatesResponse = z.infer<typeof nuiteeHotelRatesResponseSchema>;
export type NuiteeHotel = z.infer<typeof nuiteeHotelSchema>;
export type NuiteeRate = z.infer<typeof nuiteeRateSchema>;
