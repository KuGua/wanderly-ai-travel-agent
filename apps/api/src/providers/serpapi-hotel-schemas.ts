import { z } from "zod";

const moneySchema = z.object({
  extracted_lowest: z.number().finite().nonnegative(),
  extracted_before_taxes_fees: z.number().finite().nonnegative().optional(),
}).passthrough();

export const serpApiHotelResponseSchema = z.object({
  search_metadata: z.object({
    id: z.string().min(1).max(256),
    status: z.enum(["Success", "Processing", "Error"]),
  }).passthrough(),
  error: z.string().max(2_000).optional(),
  properties: z.array(z.object({
    type: z.string().max(128).optional(),
    name: z.string().min(1).max(512),
    property_token: z.string().min(1).max(2_048),
    rate_per_night: moneySchema.optional(),
    total_rate: moneySchema.optional(),
    free_cancellation: z.boolean().optional(),
    hotel_class: z.union([z.number().int().min(1).max(5), z.string().max(64)]).optional(),
    extracted_hotel_class: z.number().int().min(1).max(5).optional(),
    amenities: z.array(z.string().min(1).max(256)).max(100).optional(),
    gps_coordinates: z.object({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
    }).strict().optional(),
  }).passthrough()).max(100).optional(),
}).passthrough();

export type SerpApiHotelResponse = z.infer<typeof serpApiHotelResponseSchema>;
