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

  it("keeps local tracing disabled and documents the host Tempo endpoint", () => {
    const text = readEnvExample();
    // OTLPTraceExporter appends `/v1/traces`; a path here would become
    // `/v1/traces/v1/traces` and Tempo responds with 404.
    expect(text).toMatch(/^OTEL_SDK_DISABLED=true$/m);
    expect(text).toMatch(/^OTEL_TRACES_EXPORTER=none$/m);
    expect(text).toContain("# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318");
    expect(text).not.toMatch(/^OTEL_EXPORTER_OTLP_ENDPOINT=/m);
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

  it("keeps safe local logs on while the base Compose stack keeps tracing off", () => {
    const compose = readFileSync(join(repoRoot, "apps", "api", "docker-compose.yml"), "utf-8");
    expect(compose).toContain("LOCAL_DEBUG_LOG_FILE: ${API_LOCAL_DEBUG_LOG_FILE:-api-runtime.ndjson}");
    expect(compose).toContain("LOCAL_DEBUG_LOG_FILE: ${WORKER_LOCAL_DEBUG_LOG_FILE:-worker-runtime.ndjson}");
    expect((compose.match(/OTEL_SDK_DISABLED: "true"/g) ?? [])).toHaveLength(2);
    expect((compose.match(/OTEL_TRACES_EXPORTER: none/g) ?? [])).toHaveLength(2);
    expect((compose.match(/LOG_FORMAT: json/g) ?? [])).toHaveLength(2);
    expect(compose).toContain('WORKER_METRICS_PORT: "9464"');
    expect(compose).toContain("127.0.0.1:9464/health");
  });

  it("uses the Tempo HTTP query port and avoids the Web app port for Grafana", () => {
    const compose = readFileSync(join(repoRoot, "apps", "api", "docker-compose.observability.yml"), "utf-8");
    const datasource = readFileSync(join(repoRoot, "apps", "api", "observability", "grafana-datasources.yml"), "utf-8");
    expect(compose).toContain('"127.0.0.1:3003:3000"');
    expect(compose).toContain('"127.0.0.1:3100:3100"');
    expect(datasource).toContain("url: http://tempo:3100");
    expect(datasource).not.toContain("url: http://tempo:4317");
  });
});
