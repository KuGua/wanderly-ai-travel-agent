import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure unit test — does NOT require docker. It only inspects the file we
 * keep in version control so CI without a docker daemon still passes.
 */
describe("docker-compose.env.example contract", () => {
  const repoRoot = join(process.cwd(), "..", "..");
  const envExamplePath = join(repoRoot, "apps", "api", ".env.example");

  function readEnvExample(): string {
    return readFileSync(envExamplePath, "utf-8");
  }

  it("documents OTEL_EXPORTER_OTLP_ENDPOINT with a dev value", () => {
    const text = readEnvExample();
    expect(text).toMatch(/^OTEL_EXPORTER_OTLP_ENDPOINT=http\S*$/m);
  });

  it("documents OTEL_TRACES_SAMPLER_ARG with a dev value of 1.0", () => {
    const text = readEnvExample();
    expect(text).toMatch(/^OTEL_TRACES_SAMPLER_ARG=1\.0/m);
  });

  it("documents OTEL_EXPORTER_OTLP_HEADERS for SaaS auth", () => {
    const text = readEnvExample();
    expect(text).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(text).toMatch(/authorization=Bearer/);
  });

  it("explains that OTEL_SERVICE_NAME is overridden by the worker", () => {
    const text = readEnvExample();
    expect(text).toContain("OTEL_SERVICE_NAME");
    expect(text).toContain("worker overrides");
  });

  it("warns against committing the bearer token", () => {
    const text = readEnvExample();
    expect(text).toMatch(/never commit/i);
  });
});