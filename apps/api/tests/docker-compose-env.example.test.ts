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
    // OTLPTraceExporter appends `/v1/traces`; a path here would become
    // `/v1/traces/v1/traces` and Tempo responds with 404.
    expect(text).toMatch(/^OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/tempo:4318$/m);
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

  it("injects the Git-ignored local env file into both Agent processes", () => {
    const compose = readFileSync(join(repoRoot, "apps", "api", "docker-compose.yml"), "utf-8");
    expect((compose.match(/env_file:\s*\r?\n\s*- \.env/g) ?? [])).toHaveLength(2);
  });

  it("uses development auth semantics while keeping the API reachable from the Docker host", () => {
    const compose = readFileSync(join(repoRoot, "apps", "api", "docker-compose.yml"), "utf-8");
    expect((compose.match(/NODE_ENV: development/g) ?? [])).toHaveLength(2);
    expect(compose).toContain("HOST: 0.0.0.0");
    expect(compose).toContain('LOCAL_DEV_CONTAINER: "true"');
    expect(compose).toContain('"127.0.0.1:3000:3000"');
  });
});
