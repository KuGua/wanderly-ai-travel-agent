import type { FastifyInstance } from "fastify";
import { ApiError } from "../middleware/error-handler.js";
import { requireAdmin } from "../middleware/admin-guard.js";
import { metrics } from "../observability/metrics.js";
import {
  adminLocationIntroductionEntryInputSchema,
  adminLocationIntroductionEntryResultSchema,
  errorResponseSchema,
  toJsonSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";
import {
  LocationIntroductionDuplicateEntryError,
  registerLocationIntroductionEntry,
} from "../location-introduction/location-introduction-registry.js";

/**
 * Operator-only endpoint to register a new `sourceId` in the
 * location-introduction catalog. The route:
 *
 *   • Requires a valid bearer token (`authMiddleware` runs first;
 *     this route is NOT in `isAuthenticationExempt`).
 *   • Requires the caller to be in the env-bound operator allow-list
 *     (`LOCATION_INTRODUCTION_ADMIN_USER_IDS` or
 *     `LOCATION_INTRODUCTION_ADMIN_SUBJECTS`).
 *   • Writes the DB row + rewrites `catalog.json` atomically.
 *   • Returns the persisted summary; never returns secrets or the
 *     file path.
 */
export async function adminLocationIntroductionRoutes(app: FastifyInstance) {
  app.post("/admin/location-introduction/entries", {
    schema: {
      description: "Register a new stable map place for the cached location-introduction feature.",
      response: {
        201: toJsonSchema(adminLocationIntroductionEntryResultSchema),
        400: toJsonSchema(errorResponseSchema),
        401: toJsonSchema(errorResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    await requireAdmin(request);

    const input = adminLocationIntroductionEntryInputSchema.parse(request.body);

    const ctx = createRequestContext(request.user?.id);
    try {
      const result = await registerLocationIntroductionEntry(input, { ctx });
      return reply.code(201).send(adminLocationIntroductionEntryResultSchema.parse(result));
    } catch (err) {
      if (err instanceof LocationIntroductionDuplicateEntryError) {
        throw new ApiError(
          409,
          "Conflict",
          "An entry with this sourceId is already registered.",
          "LOCATION_INTRODUCTION_DUPLICATE",
        );
      }
      // Validation errors from the service are surfaced as 400 (e.g.
      // `sourceId` failed the safe-id regex). The Zod schema above
      // already enforces the same lengths, so reaching here implies a
      // future drift; surface as a 400 with the message verbatim
      // (operator endpoint, no PII risk).
      if (err instanceof Error && err.message && !err.message.startsWith("UNHANDLED")) {
        throw new ApiError(400, "Bad Request", err.message);
      }
      metrics.inc("location_introduction_registry_total", { outcome: "error" });
      throw err;
    }
  });
}