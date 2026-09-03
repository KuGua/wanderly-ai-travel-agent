import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure unit test — does NOT call AWS. It inspects the deploy workflow we keep
 * in version control, because the failure it guards is silent: a Worker whose
 * OTLP exporter has no credentials keeps running, keeps logging, and simply
 * never lands a span. The API half of a durable-task trace still arrives, so
 * Grafana shows a plausible-looking trace with the Worker work missing.
 */
describe("apps-api-deploy workflow — OTel wiring", () => {
  const repoRoot = join(process.cwd(), "..", "..");
  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "apps-api-deploy.yml"),
    "utf-8",
  ).replace(/\r\n/gu, "\n");

  /** The `run:` block of the step that patches the Fargate task definition. */
  const workerStep = (() => {
    const start = workflow.indexOf("- name: Update Fargate Worker service");
    expect(start, "worker deploy step must exist").toBeGreaterThan(-1);
    const next = workflow.indexOf("\n      - name:", start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  })();

  it("injects the Grafana Cloud bearer token into the Worker task definition", () => {
    // App Runner receives this via RuntimeConfigurationSecrets; the Worker has
    // no equivalent, so it must come from the task definition's own `secrets`.
    expect(workerStep).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(workerStep).toMatch(/\.secrets\s*=/u);
    expect(workerStep).toContain("valueFrom: $tokenArn");
  });

  it("resolves the secret ARN through the API rather than hand-assembling it", () => {
    // A hand-built ARN omits the six-character suffix AWS appends, and it
    // cannot detect a missing secret before the task definition is registered.
    expect(workerStep).toContain("aws secretsmanager describe-secret");
    expect(workerStep).toMatch(/--query 'ARN'/u);
  });

  it("replaces the env vars it owns instead of appending duplicates", () => {
    // ECS rejects a container definition carrying the same environment or
    // secret name twice, so a second deploy would fail without the filter.
    expect(workerStep).toContain("$ownedEnv");
    expect(workerStep).toContain("$ownedSecrets");
    expect(workerStep).toMatch(/select\(\.name as \$n \| \$ownedEnv \| index\(\$n\) \| not\)/u);
    expect(workerStep).toMatch(/select\(\.name as \$n \| \$ownedSecrets \| index\(\$n\) \| not\)/u);
  });

  it("keeps the API and Worker on the same sampling ratio and service names", () => {
    expect(workerStep).toContain('value: "ai-travel-agent-worker"');
    expect(workerStep).toContain('{ name: "OTEL_TRACES_SAMPLER_ARG", value: "0.05" }');
    expect(workflow).toContain('{ "Name": "OTEL_SERVICE_NAME", "Value": "ai-travel-agent-api" }');
    expect(workflow).toContain('{ "Name": "OTEL_TRACES_SAMPLER_ARG", "Value": "0.05" }');
  });
});
