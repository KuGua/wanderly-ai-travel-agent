import type { AgentTaskRow } from "./task-repository.js";
import { metrics } from "../observability/metrics.js";

export type TaskMetricOperation = "conversation" | "plan" | "replan" | "research" | "personal_research";
export type TaskMetricOutcome = "completed" | "completed_with_gaps" | "failed" | "cancelled" | "retrying";

/** The sole translation boundary between persisted task enums and telemetry. */
export function taskMetricOperation(operation: AgentTaskRow["operation"]): TaskMetricOperation {
  switch (operation) {
    case "CONVERSATION": return "conversation";
    case "PLAN": return "plan";
    case "REPLAN": return "replan";
    case "RESEARCH": return "research";
    case "PERSONAL_RESEARCH": return "personal_research";
  }
}

/** Record one task state transition without allowing telemetry to alter task execution. */
export function recordTaskMetrics(run: AgentTaskRow, outcome: TaskMetricOutcome): void {
  const operation = taskMetricOperation(run.operation);
  metrics.inc("agent_task_outcomes_total", { operation, outcome });
  if (outcome !== "retrying") {
    metrics.observe("agent_task_duration_ms", Date.now() - run.createdAt.getTime(), { operation, outcome });
  }
}
