import "dotenv/config";

import { initTracing, shutdownTracing } from "../observability/tracing.js";
import { personalTravelAgent } from "../agents/personal-travel-agent.js";
import { assertAuthModeEnvironment, resolveAuthMode } from "../middleware/auth-mode.js";
import { agentTaskConfig } from "../tasks/config.js";
import { logger } from "../utils/logger.js";
import { processNextAgentTask } from "./agent-task-worker.js";

// Tracing MUST be initialized before any agent module is required, so the
// SDK can patch the modules they import transitively. Service name is
// suffixed so dashboards can split API and Worker traffic.
await initTracing({ serviceName: "ai-travel-agent-worker" });

assertAuthModeEnvironment(resolveAuthMode());
personalTravelAgent.register();

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
  await Promise.all(Array.from(
    { length: agentTaskConfig.workerConcurrency },
    (_, slot) => runWorkerSlot(slot),
  ));
  logger.info({ component: "agent-task-worker" }, "Agent task Worker stopped");
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
