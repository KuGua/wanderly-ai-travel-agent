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

const nuiteeMoneySchema = z.object({
  amount: moneyAmountSchema,
  currency: z.string().length(3),
}).passthrough();

/**
 * A single tax or fee line. `included` distinguishes amounts already inside
 * `retailRate.total` from ones the guest settles at the property, which is
 * what separates an INCLUDED total from a PARTIAL one.
 */
const nuiteeTaxOrFeeSchema = z.object({
  included: z.boolean(),
  description: z.string().max(256).optional(),
  amount: moneyAmountSchema,
  currency: z.string().length(3).optional(),
}).passthrough();

const nuiteeRateSchema = z.object({
  // Opaque supplier tokens, observed at 472–1631 characters. The bound is a
  // sanity ceiling, not a contract: the value only ever enters `stableOfferId`
  // as hash input and is never persisted or returned.
  rateId: z.string().min(1).max(8_192),
  name: z.string().max(256).nullable().optional(),
  boardName: z.string().max(256).nullable().optional(),
  adultCount: z.number().int().nonnegative().optional(),
  maxOccupancy: z.number().int().nonnegative().optional(),
  // `total` is an array because a rate can be quoted in several currencies;
  // the adapter takes the entry matching the requested currency.
  retailRate: z.object({
    total: z.array(nuiteeMoneySchema).min(1),
    taxesAndFees: z.array(nuiteeTaxOrFeeSchema).max(20).nullable().optional(),
  }).passthrough(),
  cancellationPolicies: z.object({
    refundableTag: z.string().max(32).nullable().optional(),
    cancelPolicyInfos: z.array(z.object({
      cancelTime: z.string().max(64).nullable().optional(),
      amount: moneyAmountSchema.optional(),
      type: z.string().max(64).nullable().optional(),
    }).passthrough()).max(20).nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const nuiteeRoomTypeSchema = z.object({
  roomTypeId: z.string().min(1).max(1_024).optional(),
  offerId: z.string().max(8_192).optional(),
  rates: z.array(nuiteeRateSchema).max(50),
}).passthrough();

/**
 * An entry in `data[]`. Rates hang off room types, and the entry carries no
 * hotel name — names live in the sibling `hotels[]` directory and are joined
 * by id.
 */
const nuiteeRatedHotelSchema = z.object({
  hotelId: z.string().min(1).max(256),
  roomTypes: z.array(nuiteeRoomTypeSchema).max(50),
}).passthrough();

/**
 * An entry in the top-level `hotels[]` directory. Field names here are
 * snake_case, unlike the camelCase used throughout `data[]`.
 */
const nuiteeHotelDirectoryEntrySchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(512),
  address: z.string().max(2_000).nullable().optional(),
  city_name: z.string().max(256).nullable().optional(),
  country_code: z.string().max(8).nullable().optional(),
  stars: z.number().min(0).max(5).nullable().optional(),
  thumbnail: z.string().max(2_048).nullable().optional(),
}).passthrough();

export const nuiteeHotelRatesResponseSchema = z.object({
  // Elements stay unparsed: the adapter validates each hotel on its own so
  // one malformed entry cannot discard a page of usable rates.
  data: z.array(z.unknown()).max(500).optional(),
  hotels: z.array(z.unknown()).max(500).optional(),
  /** True when the key is a sandbox credential and the rates are test data. */
  sandbox: z.boolean().optional(),
  error: nuiteeErrorSchema.optional(),
}).passthrough();

export const nuiteeRatedHotelEntrySchema = nuiteeRatedHotelSchema;
export const nuiteeHotelDirectorySchema = nuiteeHotelDirectoryEntrySchema;

export type NuiteeHotelRatesResponse = z.infer<typeof nuiteeHotelRatesResponseSchema>;
export type NuiteeRatedHotel = z.infer<typeof nuiteeRatedHotelSchema>;
export type NuiteeHotelDirectoryEntry = z.infer<typeof nuiteeHotelDirectoryEntrySchema>;
export type NuiteeRate = z.infer<typeof nuiteeRateSchema>;
