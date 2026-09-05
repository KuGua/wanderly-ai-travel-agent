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
import { researchRoutes } from "./routes/research.js";
import { staySearchProviderAuthorizationRoutes } from "./routes/stay-search-provider-authorizations.js";
import { confirmationRoutes } from "./routes/confirmations.js";
import { bookingRoutes } from "./routes/bookings.js";
import { changeEventRoutes } from "./routes/change-events.js";
import { chatThreadRoutes } from "./routes/chat-threads.js";
import { destinationCueRoutes } from "./routes/destination-cues.js";
import { offerCueRoutes, offerSelectionRoutes } from "./routes/offer-cues.js";
import { tripInvitationRoutes } from "./routes/trip-invitations.js";
import { tripThreadRoutes } from "./routes/trip-threads.js";
import { tripTitleSuggestRoutes } from "./routes/trip-title-suggest.js";
import { explorationRoutes } from "./routes/explorations.js";
import { locationReferenceRoutes } from "./routes/location-reference.js";
import { locationIntroductionRoutes } from "./routes/location-introduction.js";
import { agentRunRoutes } from "./routes/agent-runs.js";
import { agentRunDismissIntentRoute } from "./routes/agent-runs-dismiss-intent.js";
import { personalRouteEndpointsRoutes } from "./routes/personal-route-endpoints.js";
import { authRoutes } from "./routes/auth.js";
import { searchPreferenceRoutes } from "./routes/search-preferences.js";
import { teamOrchestrationRoutes } from "./routes/team-orchestration.js";
import { uiDiagnosticsRoutes } from "./routes/ui-diagnostics.js";
import { personalResearchRoutes } from "./routes/personal-research.js";
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
  const localDevAllowedOrigins = authMode === "local-dev" || authMode === "custom-local"
    ? resolveLocalDevAllowedOrigins(undefined, authMode)
    : [];
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
    request.observabilityStartedAt = performance.now();
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
    // The serialized form is what crosses the durable boundary: routes pass
    // `request.traceparent` into `createRequestContext`, and
    // `tasks/task-repository.ts#buildTraceContextForTask` persists it into
    // `agent_task_runs.trace_context`. Without it that column is always NULL
    // and the Worker cannot rejoin the originating request's log thread.
    request.traceparent = formatTraceparent(request.traceId, request.spanId, "01");
    const rawTracestate = request.headers["tracestate"];
    const tracestate = Array.isArray(rawTracestate) ? rawTracestate[0] : rawTracestate;
    if (tracestate) request.tracestate = tracestate;
    // This must be set before the CORS hook runs: a successful preflight is
    // short-circuited there and does not reach the regular route lifecycle.
    reply.header(TRACEPARENT_HEADER, request.traceparent);

    // Open the server span. The route pattern is not yet known in onRequest
    // for Fastify 5, so we set the bare minimum attributes here and enrich
    // them later via the preHandler hook once routing has matched.
    //
    // Operational endpoints are the exception: container health checks and
    // metric scrapers poll them continuously, so tracing them buries real
    // request traces and — at the production 5% sampling ratio, which samples
    // uniformly — crowds genuine traffic out of the sample. They are still
    // traced when the caller supplies its own `traceparent`, which keeps a
    // deliberate probe (`scripts/verify-trace-end-to-end.sh`) working while
    // unattributed polling stays silent.
    const span = isOperationalEndpoint(request.url) && !inbound
      ? undefined
      : getTracer().startSpan(
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
    if (span) {
      request._otelContext = trace.setSpan(context.active(), span);
      request._otelSpan = span;
    }

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
  });

  // CORS is registered here, between the origin guards above and the
  // authentication hook below, and the position is load-bearing at both ends.
  //
  // It must come *after* the guards: @fastify/cors answers a valid preflight
  // from its own onRequest hook, so registering it earlier would let a
  // disallowed origin's preflight end as a 204 before the guard can reject it.
  //
  // It must come *before* authentication. Fastify runs onRequest hooks in
  // registration order, so a hook that replies short-circuits every hook after
  // it — and an unauthenticated request replying 401 from a hook registered
  // ahead of CORS produced a 401 with no `access-control-allow-origin` on it.
  // The browser cannot read a response like that, so it reports an opaque
  // network failure instead of the status: the web app saw `net::ERR_FAILED`
  // where the server had plainly said "a valid bearer access token is
  // required", and could neither show that nor act on it. Registering CORS
  // first means the headers are on the reply before auth can reject it, so
  // every 4xx the API returns stays readable to the page that asked for it.
  await app.register(fastifyCors, {
    origin: authMode === "local-dev" || authMode === "custom-local"
      ? (origin, callback) => callback(null, isAllowedLocalDevOrigin(origin, localDevAllowedOrigins))
      : true,
    // Keep this allow-list aligned with the API's browser-facing routes.
    // In particular, creator-confirmed draft brief updates use PATCH.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.addHook("onRequest", async (request) => {
    if (isAuthenticationExempt(request.method, request.url)) {
      return;
    }
    await authMiddleware(request);
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
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx` as "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
    const method = metricMethod(request.method);
    // Operational endpoints are not product traffic. Excluding them keeps
    // polling from changing the very SLIs they exist to expose: a health check
    // every few seconds otherwise inflates request volume and drags the p95
    // latency down, so `sli.api.latency` and `sli.api.errors` would measure the
    // health check rather than the product.
    if (!isOperationalEndpoint(request.url)) {
      metrics.inc("http_requests_total", { method, status_class: statusClass });
      metrics.observe("http_request_duration_ms", performance.now() - request.observabilityStartedAt, {
        method,
        status_class: statusClass,
      });
    }
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
  await app.register(researchRoutes, { prefix: "/api/v1" }); // Phase 2 — Personal Trip Orchestrator
  await app.register(staySearchProviderAuthorizationRoutes, { prefix: "/api/v1" }); // Phase D — hotel provider authorization
  await app.register(confirmationRoutes, { prefix: "/api/v1" });
  await app.register(bookingRoutes, { prefix: "/api/v1" });
  await app.register(changeEventRoutes, { prefix: "/api/v1" });
  await app.register(chatThreadRoutes, { prefix: "/api/v1" });
  await app.register(destinationCueRoutes, { prefix: "/api/v1" });
  await app.register(offerCueRoutes, { prefix: "/api/v1" });
  await app.register(offerSelectionRoutes, { prefix: "/api/v1" });
  await app.register(tripInvitationRoutes, { prefix: "/api/v1" });
  await app.register(tripThreadRoutes, { prefix: "/api/v1" });
  await app.register(tripTitleSuggestRoutes, { prefix: "/api/v1" });
  await app.register(explorationRoutes, { prefix: "/api/v1" });
  await app.register(locationReferenceRoutes, { prefix: "/api/v1" });
  await app.register(locationIntroductionRoutes, { prefix: "/api/v1" });
  await app.register(agentRunRoutes, { prefix: "/api/v1", relay: agentStreamRelay });
  await app.register(agentRunDismissIntentRoute, { prefix: "/api/v1" });
  await app.register(personalRouteEndpointsRoutes, { prefix: "/api/v1" });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(searchPreferenceRoutes, { prefix: "/api/v1" });
  await app.register(teamOrchestrationRoutes, { prefix: "/api/v1" });
  await app.register(uiDiagnosticsRoutes, { prefix: "/api/v1" });
  await app.register(personalResearchRoutes, { prefix: "/api/v1" }); // DRAFT Personal Research (added via 0047a)

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

function metricMethod(method: string): "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER" {
  return ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method)
    ? method as "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE"
    : "OTHER";
}

/**
 * Endpoints that exist to be polled by infrastructure — container health
 * checks and the Prometheus scrape target — rather than by product clients.
 * They are excluded from both the HTTP metric series and (absent an explicit
 * inbound `traceparent`) from tracing.
 */
export function isOperationalEndpoint(url: string): boolean {
  const path = url.split("?", 1)[0] ?? "/";
  return path === "/health" || path === "/metrics";
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
