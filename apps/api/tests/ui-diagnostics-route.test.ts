import Fastify from "fastify";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";

import { errorHandler } from "../src/middleware/error-handler.js";
import { metrics } from "../src/observability/metrics.js";
import { uiDiagnosticsRoutes } from "../src/routes/ui-diagnostics.js";

const app = Fastify();

beforeAll(async () => {
  app.setErrorHandler(errorHandler);
  app.addHook("onRequest", async (request) => {
    request.user = { id: "00000000-0000-4000-8000-000000000001", externalId: "test-ui", displayName: "Test UI" };
    request.correlationId = "00000000-0000-4000-8000-000000000002";
    request.traceId = "0123456789abcdef0123456789abcdef";
    request.spanId = "0123456789abcdef";
  });
  await app.register(uiDiagnosticsRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterEach(() => metrics.reset());
afterAll(async () => app.close());

describe("browser diagnostics route", () => {
  const safeEvent = {
    eventType: "ui_api_request",
    action: "conversation.submit",
    screen: "explore",
    outcome: "failure",
    errorCategory: "http_5xx",
    durationMs: 125,
    httpStatus: 500,
    relatedCorrelationId: "00000000-0000-4000-8000-000000000003",
    relatedClientRequestId: "00000000-0000-4000-8000-000000000004",
  };

  it("accepts only the content-free event contract and emits bounded metrics", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/diagnostics/ui-events", payload: safeEvent });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(metrics.render()).toContain('ui_diagnostic_events_total{action="conversation.submit",error_category="http_5xx",outcome="failure"} 1');
  });

  it("rejects raw error details, URLs and unknown fields instead of logging them", async () => {
    for (const forbidden of [
      { message: "private prompt text" },
      { stack: "Error: secret" },
      { url: "https://example.test/?token=secret" },
      { prompt: "private prompt text" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/diagnostics/ui-events", payload: { ...safeEvent, ...forbidden } });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("private prompt text");
      expect(response.body).not.toContain("token=secret");
    }
  });
});
