/**
 * Standalone Fastify entrypoint for the location-reference resolver.
 *
 * This is the dev-only sidecar container described in
 * `apps/api/src/location-reference/SIDECAR.md`. It binds to `127.0.0.1`,
 * warms the resolver at startup so the first request does not pay the
 * 70 MB JSON.parse cost, and exposes exactly two routes:
 *
 *   POST /resolve  — body `locationReferenceRequestSchema`, response
 *                    `locationReferenceResponseSchema`. Contract-identical
 *                    to the in-process implementation; the API's source
 *                    abstraction validates the response via the same Zod
 *                    schema, so any drift fails closed.
 *   GET  /health   — `{ status: "ok", dataLoaded: <bool> }`. Reports the
 *                    resolver warm-up state honestly.
 *
 * The sidecar does NOT emit OpenTelemetry spans. See SIDECAR.md §"Observability
 * gap" for the rationale.
 */

import Fastify from "fastify";
import "dotenv/config";
import { locationReferenceRequestSchema, locationReferenceResponseSchema } from "../types/schemas.js";
import { getLocationReferenceResolver } from "./location-reference-resolver.js";
import { logger } from "../utils/logger.js";

const PORT = Number.parseInt(process.env.PORT ?? "3002", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error(`PORT must be an integer 1..65535, got ${process.env.PORT}`);
}

// Warm the resolver at boot — by the time `/health` reports `dataLoaded: true`
// the 70 MB GeoJSON is already in heap. This makes the first real request
// deterministic instead of paying the cost on the click path.
let dataLoaded = false;
let dataError: Error | undefined;
function warm(): void {
  try {
    getLocationReferenceResolver();
    dataLoaded = true;
  } catch (error) {
    dataError = error as Error;
    logger.error({ component: "location-reference-sidecar", err: dataError.message }, "warm-up failed");
  }
}

async function main(): Promise<void> {
  warm();
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024, // requests are { latitude, longitude } only
  });

  app.get("/health", async () => ({
    status: dataLoaded ? "ok" : "warming",
    dataLoaded,
    ...(dataError ? { error: dataError.message } : {}),
  }));

  app.post("/resolve", async (request) => {
    const { latitude, longitude } = locationReferenceRequestSchema.parse(request.body);
    if (!dataLoaded) {
      throw new Error(`Sidecar not warmed: ${dataError?.message ?? "unknown"}`);
    }
    const reference = getLocationReferenceResolver().resolve(latitude, longitude);
    return locationReferenceResponseSchema.parse(reference);
  });

  app.setErrorHandler((error, _request, reply) => {
    logger.error({ component: "location-reference-sidecar", err: (error as Error).message }, "request failed");
    if ((error as { name?: string }).name === "ZodError") {
      return reply.code(400).send({ error: "Bad Request", message: (error as Error).message });
    }
    return reply.code(500).send({ error: "Internal Server Error", message: (error as Error).message });
  });

  await app.listen({ port: PORT, host: HOST });
  logger.info(
    { component: "location-reference-sidecar", port: PORT, host: HOST, dataLoaded },
    "sidecar listening",
  );

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ component: "location-reference-sidecar", signal }, "sidecar shutdown initiated");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  logger.error(
    { component: "location-reference-sidecar", err: (error as Error).message },
    "sidecar failed to start",
  );
  process.exitCode = 1;
});