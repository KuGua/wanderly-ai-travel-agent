import { randomUUID } from "node:crypto";

import { SkillError } from "../agents/errors.js";
import { metrics } from "../observability/metrics.js";
import { createRequestContext } from "../utils/context.js";
import { agentTaskConfig } from "../tasks/config.js";
import { handleConversationTask, publishPhase } from "../tasks/handlers/conversation-task-handler.js";
import {
  claimNextConversationTask,
  completeConversationTask,
  failOrRetryTask,
  finishCancelledTask,
  LostTaskLeaseError,
  recoverExpiredAgentTasks,
  renewTaskLease,
  taskCancellationRequested,
} from "../tasks/task-repository.js";
import { publishAgentStreamEvent } from "../tasks/task-stream-publisher.js";

export async function processNextAgentTask(): Promise<boolean> {
  const recovered = await recoverExpiredAgentTasks();
  for (const task of recovered) {
    metrics.inc("agent_task_recoveries_total", { outcome: task.outcome.toLowerCase() });
    if (task.outcome === "RETRYING") {
      await publishAgentStreamEvent({
        event: "run.phase",
        runId: task.runId,
        generationAttempt: task.generationAttempt,
        phase: "RETRYING",
      });
    } else if (task.outcome === "CANCELLED") {
      await publishAgentStreamEvent({
        event: "turn.cancelled",
        runId: task.runId,
        generationAttempt: task.generationAttempt,
      });
    } else {
      await publishAgentStreamEvent({
        event: "turn.failed",
        runId: task.runId,
        generationAttempt: task.generationAttempt,
        code: task.code ?? "INTERNAL",
        retryable: false,
      });
    }
  }
  const run = await claimNextConversationTask();
  if (!run) return recovered.length > 0;
  if (!run.leaseToken) throw new Error("Claimed task has no lease token");

  const leaseToken = run.leaseToken;
  const abortController = new AbortController();
  let leaseLost = false;
  const leaseTimer = setInterval(() => {
    void renewTaskLease(run.id, leaseToken).then((renewed) => {
      if (!renewed) {
        leaseLost = true;
        abortController.abort(new LostTaskLeaseError());
      }
    });
  }, agentTaskConfig.leaseRenewSeconds * 1000);
  const cancellationTimer = setInterval(() => {
    void taskCancellationRequested(run.id, leaseToken).then((cancelled) => {
      if (cancelled) abortController.abort(new Error("Agent task cancellation requested"));
    });
  }, 250);

  try {
    await publishAgentStreamEvent({
      event: "turn.started",
      runId: run.id,
      generationAttempt: run.generationAttempt,
    });
    await publishPhase(run, "GENERATING");
    const output = await handleConversationTask({
      run,
      ctx: createRequestContext(run.createdByUserId, randomUUID(), randomUUID()),
      signal: abortController.signal,
    });

    if (await taskCancellationRequested(run.id, leaseToken)) {
      abortController.abort();
      throw new Error("Agent task cancellation requested");
    }
    await publishPhase(run, "PERSISTING");
    const assistant = await completeConversationTask({
      ctx: createRequestContext(run.createdByUserId, randomUUID(), randomUUID()),
      run,
      leaseToken,
      content: output.content,
      responseMode: output.responseMode,
    });
    await publishAgentStreamEvent({
      event: "turn.completed",
      runId: run.id,
      generationAttempt: run.generationAttempt,
      assistantMessageId: assistant.id,
    });
    metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "completed" });
    metrics.observe("agent_task_duration_ms", Date.now() - run.createdAt.getTime(), {
      operation: "conversation",
      outcome: "completed",
    });
    return true;
  } catch (error) {
    if (leaseLost || error instanceof LostTaskLeaseError) return true;
    if (await taskCancellationRequested(run.id, leaseToken)) {
      if (await finishCancelledTask(run.id, leaseToken)) {
        await publishAgentStreamEvent({
          event: "turn.cancelled",
          runId: run.id,
          generationAttempt: run.generationAttempt,
        });
        metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "cancelled" });
        metrics.observe("agent_task_duration_ms", Date.now() - run.createdAt.getTime(), {
          operation: "conversation",
          outcome: "cancelled",
        });
      }
      return true;
    }

    const classified = classifyTaskError(error);
    const outcome = await failOrRetryTask({
      run,
      leaseToken,
      code: classified.code,
      retryable: classified.retryable,
    });
    if (outcome === "RETRYING") {
      metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "retrying" });
      await publishPhase(run, "RETRYING");
    } else if (outcome === "FAILED") {
      metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "failed" });
      metrics.observe("agent_task_duration_ms", Date.now() - run.createdAt.getTime(), {
        operation: "conversation",
        outcome: "failed",
      });
      await publishAgentStreamEvent({
        event: "turn.failed",
        runId: run.id,
        generationAttempt: run.generationAttempt,
        code: classified.code,
        retryable: false,
      });
    }
    return true;
  } finally {
    clearInterval(leaseTimer);
    clearInterval(cancellationTimer);
  }
}

function classifyTaskError(error: unknown): {
  code: "NETWORK" | "UPSTREAM_5XX" | "UPSTREAM_FAILURE" | "TIMEOUT" | "SCHEMA_PARSE" | "POLICY_DENIED" | "INTERNAL";
  retryable: boolean;
} {
  const code = error instanceof SkillError ? error.code : (error as { code?: string }).code;
  if (code === "TIMEOUT") return { code: "TIMEOUT", retryable: true };
  if (code === "NETWORK") return { code: "NETWORK", retryable: true };
  if (code === "UPSTREAM_5XX") return { code: "UPSTREAM_5XX", retryable: true };
  if (code === "UPSTREAM_FAILURE") return { code: "UPSTREAM_FAILURE", retryable: true };
  if (code === "SCHEMA_PARSE" || code === "OUTPUT_INVALID") return { code: "SCHEMA_PARSE", retryable: false };
  if (code === "POLICY_DENIED") return { code: "POLICY_DENIED", retryable: false };
  return { code: "INTERNAL", retryable: false };
}
