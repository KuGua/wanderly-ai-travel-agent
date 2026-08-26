import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { createAuthMiddleware, type VerifyAccessToken } from "./middleware/auth.js";
import { errorHandler, ApiError } from "./middleware/error-handler.js";
import { profileRoutes } from "./routes/profiles.js";
import { tripRoutes } from "./routes/trips.js";
import { consentRoutes } from "./routes/consent.js";
import { planningRoutes } from "./routes/planning.js";
import { confirmationRoutes } from "./routes/confirmations.js";
import { bookingRoutes } from "./routes/bookings.js";
import { changeEventRoutes } from "./routes/change-events.js";
import { chatThreadRoutes } from "./routes/chat-threads.js";
import { locationReferenceRoutes } from "./routes/location-reference.js";
import { agentRunRoutes } from "./routes/agent-runs.js";
import { AgentStreamRelay } from "./tasks/agent-stream-relay.js";
import { pinoInstance, correlationChild } from "./observability/telemetry.js";
import { metrics } from "./observability/metrics.js";
import { personalTravelAgent } from "./agents/personal-travel-agent.js";
import { sharedTripAgent } from "./agents/shared-trip-agent.js";

export interface BuildAppOptions {
  verifyAccessToken?: VerifyAccessToken;
  agentStreamRelay?: AgentStreamRelay;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    loggerInstance: pinoInstance,
    genReqId: () => randomUUID(),
  });
  const agentStreamRelay = options.agentStreamRelay ?? new AgentStreamRelay();
  if (!options.agentStreamRelay) {
    await agentStreamRelay.start();
    app.addHook("onClose", async () => {
      await agentStreamRelay.stop();
    });
  }

  await app.register(fastifyCors, { origin: true });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "AI Travel Agent API",
        description: "Hackathon MVP — collaborative international trip planning with consent-based data sharing",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:3000" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.setErrorHandler(errorHandler);
  const authMiddleware = createAuthMiddleware(options.verifyAccessToken);

  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  });

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = request.id ?? randomUUID();
    request.traceId = request.correlationId;
    request.clientRequestId = readClientRequestId(request);
    reply.header("x-correlation-id", request.correlationId);
    if (request.clientRequestId) {
      reply.header("x-request-id", request.clientRequestId);
    }
    request.log = correlationChild(
      pinoInstance,
      request.correlationId,
      request.clientRequestId,
    );

    if (isAuthenticationExempt(request.method, request.url)) {
      return;
    }
    await authMiddleware(request);
  });

  app.setNotFoundHandler(async () => {
    throw new ApiError(404, "Not Found", "Route not found");
  });

  await app.register(profileRoutes, { prefix: "/api/v1" });
  await app.register(tripRoutes, { prefix: "/api/v1" });
  await app.register(consentRoutes, { prefix: "/api/v1" });
  await app.register(planningRoutes, { prefix: "/api/v1" });
  await app.register(confirmationRoutes, { prefix: "/api/v1" });
  await app.register(bookingRoutes, { prefix: "/api/v1" });
  await app.register(changeEventRoutes, { prefix: "/api/v1" });
  await app.register(chatThreadRoutes, { prefix: "/api/v1" });
  await app.register(locationReferenceRoutes, { prefix: "/api/v1" });
  await app.register(agentRunRoutes, { prefix: "/api/v1", relay: agentStreamRelay });

  // Register agents (Skills) — must happen before the server accepts traffic so
  // handlers can call skill-registry.invokeSkill without races.
  personalTravelAgent.register();
  sharedTripAgent.register();

  return app;
}

function isAuthenticationExempt(method: string, url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/health"
    || path === "/metrics"
    || path.startsWith("/docs")
    || (method === "POST" && path === "/api/v1/bookings/callback")
    || (method === "POST" && path === "/api/v1/explore/location-reference");
}

/**
 * Read the client-supplied request id from the inbound `X-Request-Id`
 * header. Returns `undefined` when missing or malformed. The format check
 * is deliberately permissive (UUIDv4 plus RFC4122 variants) — anything
 * the browser client generated is accepted, but we cap the length so a
 * malicious caller cannot poison the log index.
 */
function readClientRequestId(request: { headers: { [k: string]: unknown } }): string | undefined {
  const raw = request.headers["x-request-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  // Accept anything printable ASCII; pino and downstream consumers only
  // stringify this value. Strict UUID validation would reject legitimate
  // non-UUID request ids from older SDKs.
  if (!/^[A-Za-z0-9._\-:]+$/.test(trimmed)) return undefined;
  return trimmed;
}
