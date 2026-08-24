import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { demoAuthMiddleware } from "./middleware/auth.js";
import { errorHandler, ApiError } from "./middleware/error-handler.js";
import { profileRoutes } from "./routes/profiles.js";
import { tripRoutes } from "./routes/trips.js";
import { consentRoutes } from "./routes/consent.js";
import { planningRoutes } from "./routes/planning.js";
import { confirmationRoutes } from "./routes/confirmations.js";
import { bookingRoutes } from "./routes/bookings.js";
import { changeEventRoutes } from "./routes/change-events.js";
import { demoUserRoutes } from "./routes/demo-users.js";
import { pinoInstance, correlationChild } from "./observability/telemetry.js";
import { metrics } from "./observability/metrics.js";
import { personalTravelAgent } from "./agents/personal-travel-agent.js";
import { sharedTripAgent } from "./agents/shared-trip-agent.js";

export async function buildApp() {
  const app = Fastify({
    loggerInstance: pinoInstance,
    genReqId: () => randomUUID(),
  });

  await app.register(fastifyCors, { origin: true });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "AI Travel Agent API",
        description: "Hackathon MVP — collaborative international trip planning with consent-based data sharing",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:3000" }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.setErrorHandler(errorHandler);

  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  });

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = request.id ?? randomUUID();
    request.traceId = request.correlationId;
    reply.header("x-correlation-id", request.correlationId);
    request.log = correlationChild(pinoInstance, request.correlationId);

    if (
      request.url === "/health"
      || request.url === "/metrics"
      || request.url.startsWith("/docs")
      || (request.method === "GET" && request.url === "/api/v1/demo/users")
      || (request.method === "POST" && request.url.split("?", 1)[0] === "/api/v1/bookings/callback")
    ) {
      return;
    }
    await demoAuthMiddleware(request);
  });

  app.setNotFoundHandler(async () => {
    throw new ApiError(404, "Not Found", "Route not found");
  });

  await app.register(demoUserRoutes, { prefix: "/api/v1" });
  await app.register(profileRoutes, { prefix: "/api/v1" });
  await app.register(tripRoutes, { prefix: "/api/v1" });
  await app.register(consentRoutes, { prefix: "/api/v1" });
  await app.register(planningRoutes, { prefix: "/api/v1" });
  await app.register(confirmationRoutes, { prefix: "/api/v1" });
  await app.register(bookingRoutes, { prefix: "/api/v1" });
  await app.register(changeEventRoutes, { prefix: "/api/v1" });

  // Register agents (Skills) — must happen before the server accepts traffic so
  // handlers can call skill-registry.invokeSkill without races.
  personalTravelAgent.register();
  sharedTripAgent.register();

  return app;
}
