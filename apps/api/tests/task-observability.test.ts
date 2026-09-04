import { beforeEach, describe, expect, it } from "vitest";

import { metrics } from "../src/observability/metrics.js";
import { recordTaskMetrics, taskMetricOperation } from "../src/tasks/task-observability.js";
import type { AgentTaskRow } from "../src/tasks/task-repository.js";

function task(operation: AgentTaskRow["operation"]): AgentTaskRow {
  return { operation, createdAt: new Date(Date.now() - 25) } as AgentTaskRow;
}

describe("durable task observability", () => {
  beforeEach(() => metrics.reset());

  it("maps every persisted operation to its bounded metric operation", () => {
    expect(taskMetricOperation("CONVERSATION")).toBe("conversation");
    expect(taskMetricOperation("PLAN")).toBe("plan");
    expect(taskMetricOperation("REPLAN")).toBe("replan");
    expect(taskMetricOperation("RESEARCH")).toBe("research");
    expect(taskMetricOperation("PERSONAL_RESEARCH")).toBe("personal_research");
  });

  it("records plan terminal outcomes and duration without polluting conversation", () => {
    recordTaskMetrics(task("PLAN"), "completed_with_gaps");
    recordTaskMetrics(task("REPLAN"), "failed");
    const rendered = metrics.render();
    expect(rendered).toContain('agent_task_outcomes_total{operation="plan",outcome="completed_with_gaps"} 1');
    expect(rendered).toContain('agent_task_outcomes_total{operation="replan",outcome="failed"} 1');
    expect(rendered).toContain('agent_task_duration_ms_count{operation="plan",outcome="completed_with_gaps"} 1');
    expect(rendered).not.toContain('agent_task_outcomes_total{operation="conversation",outcome="failed"} 1');
  });
});
