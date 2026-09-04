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
  it("records completed request count and latency while excluding metrics polling", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const rendered = metrics.render();
    expect(rendered).toContain('http_requests_total{method="GET",status_class="2xx"} 1');
    expect(rendered).toContain('http_request_duration_ms_count{method="GET",status_class="2xx"} 1');

    const endpoint = await app.inject({ method: "GET", url: "/metrics" });
    expect(endpoint.statusCode).toBe(200);
    expect(metrics.render()).toContain('http_requests_total{method="GET",status_class="2xx"} 1');
  });
});
