import { afterEach, describe, expect, it } from "vitest";

import { metrics } from "../src/observability/metrics.js";
import { startWorkerMetricsServer, type WorkerMetricsServer } from "../src/workers/metrics-server.js";

let server: WorkerMetricsServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  metrics.reset();
});

describe("Worker metrics endpoint", () => {
  it("renders the worker-local registry and does not expose an unrecognised path", async () => {
    metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "completed" });
    server = await startWorkerMetricsServer({ host: "127.0.0.1", port: 0 });

    const metricsResponse = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get("content-type")).toContain("text/plain");
    expect(await metricsResponse.text()).toContain('agent_task_outcomes_total{operation="conversation",outcome="completed"} 1');

    const healthResponse = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(healthResponse.status).toBe(200);

    const missing = await fetch(`http://127.0.0.1:${server.port}/not-a-metrics-path`);
    expect(missing.status).toBe(404);
  });
});
