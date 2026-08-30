import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { createAuthMiddleware, type VerifyAccessToken } from "./middleware/auth.js";
import { errorHandler, ApiError } from "./middleware/error-handler.js";
import { profileRoutes } from "./routes/profiles.js";
import { profileMemoryRoutes } from "./routes/profile-memory.js";
import { tripMemoryRoutes } from "./routes/trip-memory.js";
import { tripRoutes } from "./routes/trips.js";
import { consentRoutes } from "./routes/consent.js";
import { planningRoutes } from "./routes/planning.js";
import { confirmationRoutes } from "./routes/confirmations.js";
import { bookingRoutes } from "./routes/bookings.js";
import { changeEventRoutes } from "./routes/change-events.js";
import { chatThreadRoutes } from "./routes/chat-threads.js";
import { tripInvitationRoutes } from "./routes/trip-invitations.js";
import { tripThreadRoutes } from "./routes/trip-threads.js";
import { explorationRoutes } from "./routes/explorations.js";
import { locationReferenceRoutes } from "./routes/location-reference.js";
import { locationIntroductionRoutes } from "./routes/location-introduction.js";
import { agentRunRoutes } from "./routes/agent-runs.js";
import { authRoutes } from "./routes/auth.js";
import { searchPreferenceRoutes } from "./routes/search-preferences.js";
import { teamOrchestrationRoutes } from "./routes/team-orchestration.js";
import { AgentStreamRelay } from "./tasks/agent-stream-relay.js";
import { pinoInstance, correlationChild } from "./observability/telemetry.js";
import { metrics } from "./observability/metrics.js";
import {
  TRACEPARENT_HEADER,
  formatTraceparent,
  getTracer,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from "./observability/tracing.js";
import { personalTravelAgent } from "./agents/personal-travel-agent.js";
import { sharedTripAgent } from "./agents/shared-trip-agent.js";
import {
  isAllowedLocalDevOrigin,
  resolveAuthMode,
  resolveLocalDevAllowedOrigins,
} from "./middleware/auth-mode.js";

export interface BuildAppOptions {
  verifyAccessToken?: VerifyAccessToken;
  agentStreamRelay?: AgentStreamRelay;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const authMode = resolveAuthMode();
  const localDevAllowedOrigins = authMode === "local-dev" || authMode === "custom-local" ? resolveLocalDevAllowedOrigins() : [];
  const app = Fastify({
    loggerInstance: pinoInstance,
    genReqId: () => randomUUID(),
    trustProxy: false,
  });
  const agentStreamRelay = options.agentStreamRelay ?? new AgentStreamRelay();
  if (!options.agentStreamRelay) {
    await agentStreamRelay.start();
    app.addHook("onClose", async () => {
      await agentStreamRelay.stop();
    });
  }

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
    request.clientRequestId = readClientRequestId(request);
    reply.header("x-correlation-id", request.correlationId);
    if (request.clientRequestId) {
      reply.header("x-request-id", request.clientRequestId);
    }

    // W3C trace context: prefer the inbound `traceparent` when present and
    // well-formed; otherwise mint a fresh trace. The span id is always new
    // because this request owns a brand-new server span.
    const rawTraceparent = request.headers[TRACEPARENT_HEADER];
    const inbound = parseTraceparent(
      Array.isArray(rawTraceparent) ? rawTraceparent[0] : rawTraceparent,
    );
    request.traceId = inbound?.traceId ?? newTraceId();
    request.spanId = newSpanId();
    // This must be set before the CORS hook runs: a successful preflight is
    // short-circuited there and does not reach the regular route lifecycle.
    reply.header(
      TRACEPARENT_HEADER,
      formatTraceparent(request.traceId, request.spanId, "01"),
    );

    // Open the server span. The route pattern is not yet known in onRequest
    // for Fastify 5, so we set the bare minimum attributes here and enrich
    // them later via the preHandler hook once routing has matched.
    const span = getTracer().startSpan(
      `HTTP ${request.method}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.method": request.method,
          // Tokens are bearer-like invitation credentials. Keep the route
          // shape useful for diagnostics without recording the raw token.
          "http.target": safeHttpTarget(request.url),
          "net.peer.ip": request.ip,
          "app.correlation_id": request.correlationId,
        },
      },
    );
    const ctxWithSpan = trace.setSpan(context.active(), span);
    request._otelContext = ctxWithSpan;
    request._otelSpan = span;

    request.log = correlationChild(
      pinoInstance,
      request.correlationId,
      request.clientRequestId,
      request.traceId,
      request.spanId,
    );

    if (
      (authMode === "local-dev" || authMode === "custom-local")
      && isCorsPreflight(request.method, request.headers.origin, request.headers["access-control-request-method"])
      && !isAllowedLocalDevOrigin(request.headers.origin, localDevAllowedOrigins)
    ) {
      throw new ApiError(403, "Forbidden", "Local development requests require an allowed browser origin");
    }
    if (
      (authMode === "local-dev" || authMode === "custom-local")
      && isUnsafeMethod(request.method)
      && !isAllowedLocalDevOrigin(request.headers.origin, localDevAllowedOrigins)
    ) {
      throw new ApiError(403, "Forbidden", "Local development writes require an allowed browser origin");
    }
    if (isAuthenticationExempt(request.method, request.url)) {
      return;
    }
    await authMiddleware(request);
  });

  // Register CORS after request tracing. @fastify/cors completes successful
  // preflight requests from its onRequest hook, so it must observe the trace
  // context already initialized above.
  await app.register(fastifyCors, {
    origin: authMode === "local-dev" || authMode === "custom-local"
      ? (origin, callback) => callback(null, isAllowedLocalDevOrigin(origin, localDevAllowedOrigins))
      : true,
  });

  app.addHook("preHandler", async (request) => {
    // Route matching has happened by preHandler; promote the bare URL to the
    // stable route pattern and expose it on the span. This attribute is what
    // dashboards will group by.
    const span = request._otelSpan;
    if (!span) return;
    const route = request.routeOptions?.url ?? "unknown";
    span.setAttribute("http.route", route);
    span.updateName(`HTTP ${request.method} ${route}`);
  });

  app.addHook("onResponse", async (request, reply) => {
    const span = request._otelSpan;
    if (span) {
      const status = reply.statusCode;
      span.setAttribute("http.status_code", status);
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      }
      span.end();
    }
  });

  app.setNotFoundHandler(async () => {
    throw new ApiError(404, "Not Found", "Route not found");
  });

  await app.register(profileRoutes, { prefix: "/api/v1" });
  await app.register(profileMemoryRoutes, { prefix: "/api/v1" });
  await app.register(tripMemoryRoutes, { prefix: "/api/v1" });
  await app.register(tripRoutes, { prefix: "/api/v1" });
  await app.register(consentRoutes, { prefix: "/api/v1" });
  await app.register(planningRoutes, { prefix: "/api/v1" });
  await app.register(confirmationRoutes, { prefix: "/api/v1" });
  await app.register(bookingRoutes, { prefix: "/api/v1" });
  await app.register(changeEventRoutes, { prefix: "/api/v1" });
  await app.register(chatThreadRoutes, { prefix: "/api/v1" });
  await app.register(tripInvitationRoutes, { prefix: "/api/v1" });
  await app.register(tripThreadRoutes, { prefix: "/api/v1" });
  await app.register(explorationRoutes, { prefix: "/api/v1" });
  await app.register(locationReferenceRoutes, { prefix: "/api/v1" });
  await app.register(locationIntroductionRoutes, { prefix: "/api/v1" });
  await app.register(agentRunRoutes, { prefix: "/api/v1", relay: agentStreamRelay });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(searchPreferenceRoutes, { prefix: "/api/v1" });
  await app.register(teamOrchestrationRoutes, { prefix: "/api/v1" });

  // Register agents (Skills) — must happen before the server accepts traffic so
  // handlers can call skill-registry.invokeSkill without races.
  personalTravelAgent.register();
  sharedTripAgent.register();

  return app;
}

function isAuthenticationExempt(method: string, url: string): boolean {
  const path = url.split("?", 1)[0];
  return method === "OPTIONS"
    || path === "/health"
    || path === "/metrics"
    || path.startsWith("/docs")
    || (method === "POST" && path === "/api/v1/bookings/callback")
    || (method === "POST" && path === "/api/v1/explore/location-reference")
    || (method === "POST" && path === "/api/v1/explore/location-introductions")
    || path.startsWith("/api/v1/auth/");
}

function safeHttpTarget(url: string): string {
  const path = url.split("?", 1)[0] ?? "/";
  const invitationMatch = path.match(/^\/api\/v1\/trip-invitations\/[^/]+(?:\/(accept|decline))?$/u);
  if (!invitationMatch) return path;
  return invitationMatch[1]
    ? `/api/v1/trip-invitations/:inviteToken/${invitationMatch[1]}`
    : "/api/v1/trip-invitations/:inviteToken";
}

function isUnsafeMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isCorsPreflight(method: string, origin: unknown, requestedMethod: unknown): boolean {
  return method === "OPTIONS" && typeof origin === "string" && typeof requestedMethod === "string";
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
