import "dotenv/config";

import { initTracing, shutdownTracing } from "../observability/tracing.js";
import { personalTravelAgent } from "../agents/personal-travel-agent.js";
import { sharedTripAgent } from "../agents/shared-trip-agent.js";
import { assertAuthModeEnvironment, resolveAuthMode } from "../middleware/auth-mode.js";
import { agentTaskConfig } from "../tasks/config.js";
import { logger } from "../utils/logger.js";
import { processNextAgentTask } from "./agent-task-worker.js";
import { processNextMemoryObservation } from "./memory-observation-worker.js";

// Tracing MUST be initialized before any agent module is required, so the
// SDK can patch the modules they import transitively. Service name is
// suffixed so dashboards can split API and Worker traffic.
await initTracing({ serviceName: "ai-travel-agent-worker" });

assertAuthModeEnvironment(resolveAuthMode());
// The Worker never calls the resolver. Force `disabled` mode so even an
// accidental transitive call returns NO_REFERENCE without reading 70 MB of
// GeoJSON into the Worker process. See `apps/api/src/location-reference/SIDECAR.md`.
process.env.LOCATION_REFERENCE_MODE = process.env.LOCATION_REFERENCE_MODE ?? "disabled";
personalTravelAgent.register();
sharedTripAgent.register();

let stopping = false;
const shutdown = async (signal: NodeJS.Signals) => {
  stopping = true;
  logger.info({ signal }, "Worker shutdown initiated");
  await shutdownTracing();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

async function main() {
  logger.info({
    component: "agent-task-worker",
    concurrency: agentTaskConfig.workerConcurrency,
  }, "Agent task Worker started");
  await Promise.all([
    ...Array.from(
      { length: agentTaskConfig.workerConcurrency },
      (_, slot) => runWorkerSlot(slot),
    ),
    // One slot is enough: an observation is a single short transaction, and
    // keeping it off the agent slots means memory aggregation can never take
    // capacity from planning.
    runMemoryObservationSlot(),
  ]);
  logger.info({ component: "agent-task-worker" }, "Agent task Worker stopped");
}

async function runMemoryObservationSlot() {
  while (!stopping) {
    const processed = await processNextMemoryObservation();
    if (!processed) await delay(agentTaskConfig.pollIntervalMs);
  }
  logger.debug({ component: "memory-observation-worker" }, "Memory observation slot stopped");
}

async function runWorkerSlot(slot: number) {
  while (!stopping) {
    const processed = await processNextAgentTask();
    if (!processed) await delay(agentTaskConfig.pollIntervalMs);
  }
  logger.debug({ component: "agent-task-worker", slot }, "Agent task Worker slot stopped");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  logger.error({ errorClass: (error as Error).name }, "Agent task Worker failed");
  process.exitCode = 1;
});
