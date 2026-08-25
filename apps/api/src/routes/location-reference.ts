import type { FastifyInstance } from "fastify";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import { getLocationReferenceResolver } from "../location-reference/location-reference-resolver.js";
import { errorResponseSchema, locationReferenceRequestSchema, locationReferenceResponseSchema, toJsonSchema } from "../types/schemas.js";

export async function locationReferenceRoutes(app: FastifyInstance) {
  app.post("/explore/location-reference", {
    schema: {
      description: "Resolve an explicitly selected map coordinate to an offline, non-authoritative location reference.",
      response: {
        200: toJsonSchema(locationReferenceResponseSchema),
        400: toJsonSchema(errorResponseSchema),
        503: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request) => {
    const { latitude, longitude } = locationReferenceRequestSchema.parse(request.body);
    try {
      const reference = getLocationReferenceResolver().resolve(latitude, longitude);
      metrics.inc("location_reference_requests_total", { outcome: reference.outcome === "REFERENCE" ? "reference" : "no_reference" });
      return locationReferenceResponseSchema.parse(reference);
    } catch {
      metrics.inc("location_reference_requests_total", { outcome: "unavailable" });
      throw new ApiError(503, "Service Unavailable", "Location reference data is unavailable", "LOCATION_REFERENCE_UNAVAILABLE");
    }
  });
}
