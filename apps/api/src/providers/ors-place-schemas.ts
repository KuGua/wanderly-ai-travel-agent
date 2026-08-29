import { z } from "zod";

/**
 * Spec §5.1 — ORS Geocoding / POI response shapes.
 *
 * Only the fields the product actually uses are modelled. The full payload is
 * validated via `passthrough()` so that upstream schema drift does not blow
 * up callers, but `safeParse` failures are mapped to
 * `INVALID_PROVIDER_RESPONSE` and never silently coerced.
 *
 * ORS Attribution metadata is required in any UI surface that displays
 * `place_provider_results_total`. The constant `ORS_ATTRIBUTION` lives in
 * `ors-place-provider.ts`; both adapters (place + directions) share it.
 */
export const orsFeaturePropertiesSchema = z.object({
  // ORS Geocoding returns a varying feature shape; only the fields below
  // survive normalization. Unknown upstream fields are ignored here.
  layer: z.string().optional(),
  name: z.string().optional(),
  country_a: z.string().length(2).optional(),
  region_a: z.string().optional(),
  locality: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  match_type: z.string().optional(),
}).passthrough();

export const orsFeatureGeometrySchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
}).passthrough();

export const orsFeatureSchema = z.object({
  type: z.literal("Feature"),
  geometry: orsFeatureGeometrySchema,
  properties: orsFeaturePropertiesSchema,
}).passthrough();

export const orsGeocodingResponseSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(orsFeatureSchema),
}).passthrough();

export type OrsFeature = z.infer<typeof orsFeatureSchema>;
export type OrsGeocodingResponse = z.infer<typeof orsGeocodingResponseSchema>;
export type OrsFeatureProperties = z.infer<typeof orsFeaturePropertiesSchema>;

export const ORS_PLACE_CATEGORY_KIND: Record<string, "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER"> = {
  attraction: "ATTRACTION",
  hotel: "HOTEL",
  restaurant: "RESTAURANT",
  transport_hub: "TRANSPORT_HUB",
};
