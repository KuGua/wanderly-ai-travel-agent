import { z } from "zod";

/**
 * Spec §5.2 — ORS Directions v2 response shapes.
 *
 * The full Directions v2 payload is large; only the fields the product uses
 * survive normalization. `passthrough()` keeps unknown upstream fields
 * observable in tests without poisoning `safeParse` failures into
 * `INVALID_PROVIDER_RESPONSE` (handled by the adapter).
 *
 * `summary` is required and carries the route distance/duration. `segments`
 * is the canonical step array. The geometry is delivered as an encoded
 * polyline (`encoded_polyline`) or GeoJSON LineString — both are accepted
 * but only one is required.
 */

const isoDateTime = z.string().datetime({ offset: true });

export const orsRouteSummarySchema = z.object({
  distance: z.number().min(0),
  duration: z.number().min(0),
}).passthrough();

export const orsRouteStepSchema = z.object({
  distance: z.number().min(0),
  duration: z.number().min(0),
  instruction: z.string().min(1).optional(),
  name: z.string().optional(),
  way_points: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  type: z.number().int().optional(),
}).passthrough();

export const orsRouteSegmentSchema = z.object({
  distance: z.number().min(0),
  duration: z.number().min(0),
  steps: z.array(orsRouteStepSchema).default([]),
}).passthrough();

export const orsRouteGeometrySchema = z.union([
  z.object({
    type: z.literal("LineString"),
    coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  }).passthrough(),
  z.object({
    type: z.literal("encoded_polyline"),
    // Polyline algorithm produces base64-looking strings; we accept any
    // non-empty string and let the adapter sanitize further if needed.
    coordinates: z.string().min(1),
  }).passthrough(),
]);

export const orsFeatureSchema = z.object({
  type: z.literal("Feature"),
  properties: z.object({
    summary: orsRouteSummarySchema,
    segments: z.array(orsRouteSegmentSchema).default([]),
  }).passthrough(),
  geometry: orsRouteGeometrySchema,
}).passthrough();

export const orsDirectionsResponseSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(orsFeatureSchema).min(1),
  metadata: z.object({
    query: z.unknown().optional(),
    attribution: z.string().optional(),
    service: z.string().optional(),
    timestamp: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

export type OrsDirectionsResponse = z.infer<typeof orsDirectionsResponseSchema>;
export type OrsFeature = z.infer<typeof orsFeatureSchema>;
export type OrsRouteStep = z.infer<typeof orsRouteStepSchema>;
export type OrsRouteSegment = z.infer<typeof orsRouteSegmentSchema>;
export type OrsRouteGeometry = z.infer<typeof orsRouteGeometrySchema>;

export const ORS_DIRECTIONS_PROFILE: Record<"WALK" | "DRIVE" | "CYCLE", string> = {
  WALK: "foot-walking",
  DRIVE: "driving-car",
  CYCLE: "cycling-regular",
};
