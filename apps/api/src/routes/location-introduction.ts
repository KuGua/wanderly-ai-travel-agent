import type { FastifyInstance } from "fastify";
import { SpanKind } from "@opentelemetry/api";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import { getTracer, safeSetAttribute } from "../observability/tracing.js";
import {
  errorResponseSchema,
  locationIntroductionRequestSchema,
  locationIntroductionGeneratingSchema,
  locationIntroductionReadySchema,
  toJsonSchema,
} from "../types/schemas.js";
import {
  LocationIntroductionUnsupportedPlaceError,
  resolveLocationIntroductionCatalogEntry,
} from "../location-introduction/location-introduction-catalog.js";
import {
  getOrStartLocationIntroduction,
  LocationIntroductionUnavailableError,
} from "../location-introduction/location-introduction-cache-service.js";
import { modelGateway } from "../providers/gateway-factory.js";
import { LocationIntroductionRateLimiter } from "./location-introduction-rate-limit.js";

/**
 * Anonymous, idempotent, read-through endpoint that returns a short,
 * non-personalized destination introduction for a server-versioned
 * stable `sourceId`.  Never creates user, Trip, thread, message, agent
 * task, or audit state.
 *
 * Mirrors `apps/api/src/routes/location-reference.ts` (rate-limiter
 * first, then parse → service → error envelope) with two small twists:
 *
 *   • 202 carries a typed `retryAfterMs` body and an HTTP `Retry-After`
 *     header so callers can rely on either.
 *   • 503 is the only "the model didn't work" failure. We never persist
 *     partial / policy-rejected / schema-invalid output (see
 *     LocationIntroductionCacheService §5.6).
 */
export async function locationIntroductionRoutes(app: FastifyInstance) {
  const rateLimiter = new LocationIntroductionRateLimiter();

  app.post("/explore/location-introductions", {
    schema: {
      description: "Return a non-personalized cached destination introduction for a stable map sourceId.",
      response: {
        200: toJsonSchema(locationIntroductionReadySchema),
        202: toJsonSchema(locationIntroductionGeneratingSchema),
        400: toJsonSchema(errorResponseSchema),
        429: toJsonSchema(errorResponseSchema),
        503: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const clientId = request.ip || "unknown";

    if (!rateLimiter.allow(clientId)) {
      metrics.inc("location_introduction_requests_total", { outcome: "rate_limited" });
      throw new ApiError(
        429,
        "Too Many Requests",
        "Too many location introduction requests. Please try again in a minute.",
        "LOCATION_INTRODUCTION_RATE_LIMITED",
      );
    }

    const input = locationIntroductionRequestSchema.parse(request.body);

    let catalogEntry;
    try {
      catalogEntry = await resolveLocationIntroductionCatalogEntry(input.sourceId);
    } catch (err) {
      if (err instanceof LocationIntroductionUnsupportedPlaceError) {
        metrics.inc("location_introduction_requests_total", { outcome: "unsupported" });
        throw new ApiError(
          400,
          "Bad Request",
          "This place is not in the active introduction catalog.",
          "LOCATION_INTRODUCTION_UNSUPPORTED_PLACE",
        );
      }
      throw err;
    }

    const contentVersion = process.env.LOCATION_INTRODUCTION_CONTENT_VERSION?.trim()
      || catalogEntry.datasetVersion;

    const span = getTracer().startSpan("catalog.resolve", {
      kind: SpanKind.INTERNAL,
      attributes: { "content.version": contentVersion },
    });
    safeSetAttribute(span, "cache.outcome", "hit");
    span.end();

    try {
      const outcome = await getOrStartLocationIntroduction({
        catalogEntry,
        locale: input.locale,
        contentVersion,
        deps: { gateway: modelGateway() },
      });

      if (outcome.status === "GENERATING") {
        reply.header("retry-after", String(Math.ceil(outcome.retryAfterMs / 1000)));
        reply.code(202);
        return locationIntroductionGeneratingSchema.parse(outcome);
      }

      const ready = locationIntroductionReadySchema.parse(outcome);
      return reply.code(200).send(ready);
    } catch (err) {
      if (err instanceof LocationIntroductionUnavailableError) {
        // The cache service has already incremented `unavailable` for the
        // normal failure path. If the catalog lookup itself misfired
        // before any DB call we may have skipped that increment; guard
        // against double counting by relying on the service's accounting.
        throw new ApiError(
          503,
          "Service Unavailable",
          "Location introduction is temporarily unavailable. Please retry shortly.",
          "LOCATION_INTRODUCTION_UNAVAILABLE",
        );
      }
      throw err;
    }
  });
}
