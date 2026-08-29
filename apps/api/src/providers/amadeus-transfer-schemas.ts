import { z } from "zod";

/**
 * Spec §5.3 — Amadeus Transfer Search response shapes.
 *
 * Only fields the product uses survive normalization. `passthrough()`
 * keeps unknown upstream fields observable for tests but `safeParse`
 * failures are mapped to `INVALID_PROVIDER_RESPONSE` by the adapter.
 *
 * The adapter MUST strip any `bookingUrl` / booking link before this
 * schema runs — the product never carries booking links through.
 */

const isoDateTime = z.string().datetime({ offset: true });

export const amadeusTransferServiceTypeSchema = z.enum(["TAXI", "TRANSFER", "CHARTER", "RENTAL"]);

export const amadeusTransferOfferSchema = z.object({
  id: z.string().min(1),
  serviceType: amadeusTransferServiceTypeSchema,
  passengers: z.number().int().min(1).max(9),
  departureAt: isoDateTime,
  estimatedPrice: z.number().nonnegative().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  vehicleClass: z.string().min(1).max(64),
  estimated: z.literal(true),
  expiresAt: isoDateTime.nullable(),
}).passthrough();

export const amadeusTransferResponseSchema = z.object({
  data: z.array(amadeusTransferOfferSchema).max(64),
}).passthrough();

export type AmadeusTransferResponse = z.infer<typeof amadeusTransferResponseSchema>;
export type AmadeusTransferOffer = z.infer<typeof amadeusTransferOfferSchema>;
