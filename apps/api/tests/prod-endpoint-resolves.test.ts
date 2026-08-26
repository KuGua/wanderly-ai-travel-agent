import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetTracingForTests,
  initTracing,
  resolveExporterModeForTests,
  shutdownTracing,
} from "../src/observability/tracing.js";

const originalEnv = { ...process.env };

/**
 * Pure unit tests for the Grafana Cloud Free production endpoint shape.
 * Asserts that the SDK's env-driven exporter selection accepts the
 * production endpoint and authentication header without throwing.
 */
describe("Grafana Cloud production endpoint", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("resolves to otlp-proto with Grafana Cloud OTLP endpoint", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer xyz";
    await expect(initTracing()).resolves.not.toThrow();
    expect(resolveExporterModeForTests()).toBe("otlp-proto");
  });

  it("resolves to otlp-proto when protocol is unset (default)", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp";
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    await expect(initTracing()).resolves.not.toThrow();
    expect(resolveExporterModeForTests()).toBe("otlp-proto");
  });

  it("rejects when OTEL_SDK_DISABLED=true even if endpoint is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp";
    await expect(initTracing()).resolves.not.toThrow();
    expect(resolveExporterModeForTests()).toBe("none");
  });

  it("falls back to none when only OTEL_TRACES_EXPORTER=otlp without endpoint", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await expect(initTracing()).resolves.not.toThrow();
    expect(resolveExporterModeForTests()).toBe("none");
  });

  it("env-driven propagation header parse: authorization=Bearer is recognized", async () => {
    process.env.NODE_ENV = "production";
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer abcdef";
    await expect(initTracing()).resolves.not.toThrow();
    // The exporter is wired; the SDK passes the header through to the
    // OTLP exporter. This test asserts the wiring path runs cleanly even
    // when the value would normally come from a secrets manager.
    expect(resolveExporterModeForTests()).toBe("otlp-proto");
  });
});