import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";

import { metrics } from "./metrics.js";
import { correlationChild, pinoInstance } from "./telemetry.js";
import { getTracer, safeSetAttribute } from "./tracing.js";

/**
 * Content-free telemetry boundary for every outbound provider HTTP request.
 *
 * Deliberately accepts no URL, headers, request body, response body, or
 * supplier error text. Those values can contain credentials or private trip
 * constraints. The calling adapter supplies only catalogued identifiers.
 */
export type ExternalProviderName =
  | "amadeus"
  | "flightapi"
  | "nuitee_connect"
  | "openrouteservice"
  | "opentripmap"
  | "serpapi"
  | "viator_mcp"
  | "location_reference";

export type ExternalProviderOperation =
  | "flight.search"
  | "hotel.search"
  | "accommodation.discover"
  | "place.search"
  | "navigation.route"
  | "mobility.search"
  | "activities.search"
  | "oauth.token"
  | "location.resolve";

export type ExternalProviderRequest = {
  provider: ExternalProviderName;
  operation: ExternalProviderOperation;
  method: "GET" | "POST";
};

function responseBytes(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function logEvent(event: Record<string, string | number | undefined>, span: Span): void {
  // There is no request context available in every adapter interface. The
  // active span still supplies trace_id/span_id, which links this record to
  // the worker/API trace; the fixed correlation binding is not user data.
  const context = span.spanContext();
  correlationChild(pinoInstance, "external-provider", undefined, context.traceId, context.spanId).info(
    { external_provider_call: event },
    "External provider HTTP call",
  );
}

/**
 * Observe a single outbound HTTP call using only allow-listed metadata.
 * A retry naturally creates another start/end pair in the same trace.
 */
export async function observeExternalProviderFetch(
  request: ExternalProviderRequest,
  execute: () => Promise<Response>,
): Promise<Response> {
  const startedAt = performance.now();
  const span = getTracer().startSpan(`external.provider.${request.operation}`, {
    kind: SpanKind.CLIENT,
  });
  safeSetAttribute(span, "provider.name", request.provider);
  safeSetAttribute(span, "provider.operation", request.operation);
  safeSetAttribute(span, "http.request.method", request.method);
  logEvent({ phase: "started", ...request }, span);

  try {
    const response = await execute();
    const latencyMs = Math.round(performance.now() - startedAt);
    const outcome = response.ok ? "success" : "failure";
    const bytes = responseBytes(response);
    safeSetAttribute(span, "http.response.status_code", response.status);
    safeSetAttribute(span, "provider.outcome", outcome);
    safeSetAttribute(span, "provider.latency_ms", latencyMs);
    if (bytes !== undefined) safeSetAttribute(span, "provider.response_bytes", bytes);
    if (!response.ok) span.setStatus({ code: SpanStatusCode.ERROR });
    logEvent({ phase: "completed", ...request, outcome, httpStatus: response.status, latencyMs, responseBytes: bytes }, span);
    metrics.inc("external_provider_http_calls_total", {
      provider: request.provider,
      operation: request.operation,
      outcome,
    });
    metrics.observe("external_provider_http_latency_ms", latencyMs, {
      provider: request.provider,
      operation: request.operation,
    });
    return response;
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const errorCode = (error as { name?: string }).name === "AbortError" ? "timeout" : "network";
    safeSetAttribute(span, "provider.outcome", "failure");
    safeSetAttribute(span, "provider.error_code", errorCode);
    safeSetAttribute(span, "provider.latency_ms", latencyMs);
    span.setStatus({ code: SpanStatusCode.ERROR });
    logEvent({ phase: "completed", ...request, outcome: "failure", errorCode, latencyMs }, span);
    metrics.inc("external_provider_http_calls_total", {
      provider: request.provider,
      operation: request.operation,
      outcome: "failure",
    });
    metrics.observe("external_provider_http_latency_ms", latencyMs, {
      provider: request.provider,
      operation: request.operation,
    });
    throw error;
  } finally {
    span.end();
  }
}
