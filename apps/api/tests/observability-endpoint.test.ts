import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetTracingForTests,
  initTracing,
  resolveExporterModeForTests,
  shutdownTracing,
} from "../src/observability/tracing.js";

const originalEnv = { ...process.env };

/**
 * Unit tests asserting that the dev / prod OTLP endpoints are wired without
 * any SDK code change — only environment variables. The dev endpoint
 * matches the Tempo service in `docker-compose.observability.yml`; the prod
 * endpoint matches the Grafana Cloud Free OTLP gateway shape.
 */
describe("observability endpoint env wiring", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("dev compose endpoint resolves to otlp-proto (default protocol)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.OTEL_TRACES_EXPORTER;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://tempo:4318";
    await initTracing();
    expect(resolveExporterModeForTests()).toBe("otlp-proto");
  });

  it("dev compose with explicit grpc protocol falls back to otlp-http", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.OTEL_TRACES_EXPORTER;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://tempo:4318";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    await initTracing();
    expect(resolveExporterModeForTests()).toBe("otlp-http");
  });

  it("Grafana Cloud prod endpoint resolves to otlp-proto", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer xyz";
    await initTracing();
    expect(resolveExporterModeForTests()).toBe("otlp-proto");
  });

  it("no OTLP endpoint → exporter mode is none", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_TRACES_EXPORTER;
    await initTracing();
    expect(resolveExporterModeForTests()).toBe("none");
  });

  it("OTEL_SDK_DISABLED=true → exporter mode is none even with endpoint", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp";
    await initTracing();
    expect(resolveExporterModeForTests()).toBe("none");
  });
});
