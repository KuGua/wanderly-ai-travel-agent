import type { FastifyInstance } from "fastify";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import { getLocationReferenceSource, LocationReferenceSourceError } from "../location-reference/location-reference-source.js";
import { errorResponseSchema, locationReferenceRequestSchema, locationReferenceResponseSchema, toJsonSchema } from "../types/schemas.js";
import { LocationReferenceRateLimiter } from "./location-reference-rate-limit.js";

export async function locationReferenceRoutes(app: FastifyInstance) {
  const rateLimiter = new LocationReferenceRateLimiter();
  const source = getLocationReferenceSource();
  app.post("/explore/location-reference", {
    schema: {
      description: "Resolve an explicitly selected map coordinate to an offline, non-authoritative location reference.",
      response: {
        200: toJsonSchema(locationReferenceResponseSchema),
        400: toJsonSchema(errorResponseSchema),
        429: toJsonSchema(errorResponseSchema),
        503: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    if (!rateLimiter.allow(request.ip)) {
      metrics.inc("location_reference_requests_total", { outcome: "rate_limited" });
      throw new ApiError(429, "Too Many Requests", "Too many location reference requests. Please try again in a minute.", "LOCATION_REFERENCE_RATE_LIMITED");
    }
    const { latitude, longitude } = locationReferenceRequestSchema.parse(request.body);
    try {
      const reference = await source.resolve(latitude, longitude);
      metrics.inc("location_reference_requests_total", { outcome: reference.outcome === "REFERENCE" ? "reference" : "no_reference" });
      return locationReferenceResponseSchema.parse(reference);
    } catch (error) {
      if (error instanceof LocationReferenceSourceError) {
        metrics.inc("location_reference_requests_total", { outcome: "unavailable" });
        throw new ApiError(503, "Service Unavailable", "Location reference data is unavailable", "LOCATION_REFERENCE_UNAVAILABLE");
      }
      metrics.inc("location_reference_requests_total", { outcome: "unavailable" });
      throw new ApiError(503, "Service Unavailable", "Location reference data is unavailable", "LOCATION_REFERENCE_UNAVAILABLE");
    }
  });
}
