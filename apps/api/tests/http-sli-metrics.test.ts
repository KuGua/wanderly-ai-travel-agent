import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { metrics } from "../src/observability/metrics.js";
import { AgentStreamRelay } from "../src/tasks/agent-stream-relay.js";
import { verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    verifyAccessToken: verifyTestAccessToken,
    agentStreamRelay: new AgentStreamRelay(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => metrics.reset());

describe("unsampled API HTTP SLI metrics", () => {
  it("records completed request count and latency for product traffic", async () => {
    // Unauthenticated, so this 401s. The status class is what the series
    // records; the point here is that a product route is counted at all.
    const rejected = await app.inject({ method: "GET", url: "/api/v1/trips" });
    expect(rejected.statusCode).toBe(401);

    const rendered = metrics.render();
    expect(rendered).toContain('http_requests_total{method="GET",status_class="4xx"} 1');
    expect(rendered).toContain('http_request_duration_ms_count{method="GET",status_class="4xx"} 1');
  });

  it("excludes operational polling so it cannot move the SLIs it exposes", async () => {
    // Both endpoints are polled continuously by the container health check
    // and the Prometheus scrape. Counting them would inflate request volume
    // and drag p95 down, so sli.api.latency would measure the health check.
    // Trace-side exclusion is covered by
    // tests/operational-endpoint-observability.test.ts.
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);

    const rendered = metrics.render();
    expect(rendered).toContain("http_requests_total 0");
    expect(rendered).not.toMatch(/http_requests_total\{[^}]*\} [1-9]/u);
  });
});
