import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp, isOperationalEndpoint } from "../src/app.js";
import { metrics } from "../src/observability/metrics.js";
import {
  _resetTracingForTests,
  drainInMemorySpans,
  formatTraceparent,
  getInMemoryExporter,
  initTracing,
  shutdownTracing,
} from "../src/observability/tracing.js";
import { verifyTestAccessToken } from "./helpers/auth.js";

/**
 * Health checks and metric scrapes are infrastructure polling, not product
 * traffic. Before this exemption the Docker health check alone produced a
 * steady stream of root traces, and the worker's poll loop produced far more —
 * measured at 477 of the 500 traces Tempo held over five minutes, against 3
 * real ones. Under the production 5% sampler, which samples uniformly, that
 * ratio means genuine traffic is mostly sampled away.
 */
describe("operational endpoints are excluded from traces and HTTP metrics", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    _resetTracingForTests();
    await initTracing();
    app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await shutdownTracing();
    _resetTracingForTests();
  });

  afterEach(() => {
    // `drainInMemorySpans` reads without clearing, so spans would otherwise
    // accumulate across cases in this file.
    getInMemoryExporter()?.reset();
    metrics.reset();
  });

  function httpRequestSamples(): string[] {
    return metrics.render()
      .split("\n")
      .filter(line => line.startsWith("http_requests_total{"));
  }

  it("classifies only /health and /metrics as operational", () => {
    expect(isOperationalEndpoint("/health")).toBe(true);
    expect(isOperationalEndpoint("/metrics")).toBe(true);
    expect(isOperationalEndpoint("/metrics?format=text")).toBe(true);
    expect(isOperationalEndpoint("/api/v1/trips")).toBe(false);
    // Not a prefix match: a product route must never be silently untraced.
    expect(isOperationalEndpoint("/health-check/deep")).toBe(false);
  });

  it("emits no span and no HTTP metric for an unattributed health check", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(drainInMemorySpans()).toHaveLength(0);
    expect(httpRequestSamples()).toHaveLength(0);
  });

  it("emits no span and no HTTP metric for a metrics scrape", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(drainInMemorySpans()).toHaveLength(0);
    expect(httpRequestSamples()).toHaveLength(0);
  });

  it("still traces /health when the caller supplies its own traceparent", async () => {
    // `scripts/verify-trace-end-to-end.sh` probes /health with an explicit
    // trace context; the exemption must not silence that deliberate probe.
    //
    // Only the presence of the span is asserted. Whether the span *adopts* the
    // inbound trace id is a separate concern that this exemption neither
    // creates nor fixes: `onRequest` never calls `propagation.extract`, so the
    // span is a fresh root and `request.traceId` is a parallel, server-minted
    // identifier. Asserting equality here would bake that gap in.
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { traceparent: formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", "01") },
    });

    expect(response.statusCode).toBe(200);
    expect(drainInMemorySpans()).toHaveLength(1);
    // Still not product traffic, so the metric stays out regardless.
    expect(httpRequestSamples()).toHaveLength(0);
  });

  it("keeps tracing and counting ordinary product routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/trips" });

    // Unauthenticated, so this 401s — the point is that it is observed at all.
    expect(response.statusCode).toBe(401);
    expect(drainInMemorySpans()).toHaveLength(1);
    expect(httpRequestSamples().join("\n")).toContain('status_class="4xx"');
  });
});
