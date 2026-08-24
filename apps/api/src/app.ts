import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { demoAuthMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { profileRoutes } from "./routes/profiles.js";
import { tripRoutes } from "./routes/trips.js";
import { consentRoutes } from "./routes/consent.js";
import { planningRoutes } from "./routes/planning.js";
import { confirmationRoutes } from "./routes/confirmations.js";
import { bookingRoutes } from "./routes/bookings.js";
import { changeEventRoutes } from "./routes/change-events.js";
import { demoUserRoutes } from "./routes/demo-users.js";
import { createRequestContext } from "./utils/context.js";
import { ApiError } from "./middleware/error-handler.js";

export async function buildApp() {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // CORS
  await app.register(fastifyCors, { origin: true });

  // OpenAPI / Swagger
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

  // Global error handler
  app.setErrorHandler(errorHandler);

  // Health check (no auth required)
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Auth middleware for all other routes
  app.addHook("onRequest", async (request, reply) => {
    const requestContext = createRequestContext();
    request.correlationId = requestContext.correlationId;
    request.traceId = requestContext.traceId ?? requestContext.correlationId;
    reply.header("x-correlation-id", request.correlationId);

    if (
      request.url === "/health"
      || request.url.startsWith("/docs")
      || (request.method === "GET" && request.url === "/api/v1/demo/users")
    ) {
      return;
    }
    await demoAuthMiddleware(request);
  });

  app.setNotFoundHandler(async () => {
    throw new ApiError(404, "Not Found", "Route not found");
  });

  // Register routes
  await app.register(demoUserRoutes, { prefix: "/api/v1" });
  await app.register(profileRoutes, { prefix: "/api/v1" });
  await app.register(tripRoutes, { prefix: "/api/v1" });
  await app.register(consentRoutes, { prefix: "/api/v1" });
  await app.register(planningRoutes, { prefix: "/api/v1" });
  await app.register(confirmationRoutes, { prefix: "/api/v1" });
  await app.register(bookingRoutes, { prefix: "/api/v1" });
  await app.register(changeEventRoutes, { prefix: "/api/v1" });

  return app;
}
