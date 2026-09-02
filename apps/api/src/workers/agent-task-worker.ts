import { SkillError } from "../agents/errors.js";
import { context as otelContext, SpanKind, trace as otelTrace } from "@opentelemetry/api";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import {
  getTracer,
  parseTraceparent,
  safeSetAttribute,
} from "../observability/tracing.js";
import { agentTaskConfig } from "../tasks/config.js";
import { handleConversationTask, publishPhase } from "../tasks/handlers/conversation-task-handler.js";
import { handlePlanningTask } from "../tasks/handlers/planning-task-handler.js";
import {
  claimNextConversationTask,
  claimNextPlanningTask,
  completeConversationTask,
  ctxFromRun,
  failOrRetryTask,
  finishCancelledTask,
  LostTaskLeaseError,
  recoverExpiredAgentTasks,
  renewTaskLease,
  taskCancellationRequested,
  type AgentTaskRow,
} from "../tasks/task-repository.js";
import { publishAgentStreamEvent } from "../tasks/task-stream-publisher.js";

/**
 * Open the worker root span for a claimed task. The span is linked to the
 * originating HTTP server span via `parseTraceparent` so the trace stays
 * continuous across the durable boundary. When the task row has no trace
 * context (old rows, recovery path, replay) we fall back to a fresh span.
 */
function openWorkerRunSpan(run: AgentTaskRow) {
  const tc = run.traceContext ?? null;
  const parsed = tc?.traceparent ? parseTraceparent(tc.traceparent) : null;
  const tracer = getTracer();
  const links = parsed
    ? [{ context: { traceId: parsed.traceId, spanId: parsed.spanId, isRemote: true, traceFlags: 1 } }]
    : undefined;
  const span = tracer.startSpan(
    "agent_task_worker.run",
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "tasks.operation": "conversation",
        "tasks.run.id": run.id,
        "tasks.attempt": run.generationAttempt,
        "tasks.recovery": tc === null,
      },
      links,
    },
  );
  safeSetAttribute(span, "app.correlation_id", tc?.correlationId ?? run.requestId);
  return span;
}

/**
 * Helper that wraps a callback with the worker span set as active. Returns
 * the callback's return value while ensuring AsyncLocalStorage carries the
 * span context for child operations.
 */
async function withWorkerSpan<T>(
  run: AgentTaskRow,
  fn: () => Promise<T>,
): Promise<T> {
  const span = openWorkerRunSpan(run);
  try {
    return await otelContext.with(otelTrace.setSpan(otelContext.active(), span), fn);
  } finally {
    span.end();
  }
}

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
  const run = await claimNextConversationTask() ?? await claimNextPlanningTask();
  if (!run) return recovered.length > 0;
  if (!run.leaseToken) throw new Error("Claimed task has no lease token");

  const leaseToken = run.leaseToken;
  const ctx = ctxFromRun(run);
  const traceparent = ctx.traceparent;
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

  return withWorkerSpan(run, async () => {
    try {
      logSafeRuntimeEvent(ctx, {
        component: "worker", event: "task", operation: run.operation.toLowerCase(), outcome: "started",
        attempt: run.generationAttempt, relatedRunId: run.id,
      });
      await publishAgentStreamEvent({
        event: "turn.started",
        runId: run.id,
        generationAttempt: run.generationAttempt,
        traceparent,
      });
      if (run.operation !== "CONVERSATION") {
        await publishPhase(run, "RESEARCHING", traceparent);
        const planId = await handlePlanningTask({ run, ctx, signal: abortController.signal, leaseToken });
        await publishPhase(run, "PERSISTING", traceparent);
        await publishAgentStreamEvent({ event: "turn.completed", runId: run.id, generationAttempt: run.generationAttempt, resultPlanId: planId, traceparent });
        metrics.inc("agent_task_outcomes_total", { operation: run.operation.toLowerCase(), outcome: "completed" });
        logSafeRuntimeEvent(ctx, {
          component: "worker", event: "task", operation: run.operation.toLowerCase(), outcome: "success",
          attempt: run.generationAttempt, relatedRunId: run.id,
        });
        return true;
      }
      await publishPhase(run, "GENERATING", traceparent);
      const output = await handleConversationTask({ run, ctx, signal: abortController.signal });

      if (await taskCancellationRequested(run.id, leaseToken)) {
        abortController.abort();
        throw new Error("Agent task cancellation requested");
      }

      // Quick orchestration — proactive intro returns `null` because no
      // user message exists; `handleProactiveIntro` already published its
      // own SSE events and a `turn.completed`, so the worker just bails
      // out cleanly without trying to persist a duplicate message.
      if (!output) {
        metrics.inc("agent_task_outcomes_total", { operation: run.operation.toLowerCase(), outcome: "completed" });
        logSafeRuntimeEvent(ctx, {
          component: "worker", event: "task", operation: run.operation.toLowerCase(), outcome: "success",
          attempt: run.generationAttempt, relatedRunId: run.id,
        });
        return true;
      }

      await publishPhase(run, "PERSISTING", traceparent);
      const assistant = await completeConversationTask({
        ctx,
        run,
        leaseToken,
        content: output.content,
        responseMode: output.responseMode,
      });
      if (output.tripBriefProposal) {
        await publishAgentStreamEvent({
          event: "trip.brief_proposed",
          runId: run.id,
          generationAttempt: run.generationAttempt,
          proposal: output.tripBriefProposal,
          traceparent,
        });
      }
      await publishAgentStreamEvent({
        event: "turn.completed",
        runId: run.id,
        generationAttempt: run.generationAttempt,
        assistantMessageId: assistant.id,
        responseMode: output.responseMode,
        traceparent,
      });
      metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "completed" });
      metrics.observe("agent_task_duration_ms", Date.now() - run.createdAt.getTime(), {
        operation: "conversation",
        outcome: "completed",
      });
      logSafeRuntimeEvent(ctx, {
        component: "worker", event: "task", operation: "conversation", outcome: "success",
        attempt: run.generationAttempt, relatedRunId: run.id,
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
            traceparent,
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
      logSafeRuntimeEvent(ctx, {
        component: "worker", event: "task", operation: run.operation.toLowerCase(),
        outcome: "failure", attempt: run.generationAttempt, errorCode: classified.code,
        relatedRunId: run.id,
      });
      const outcome = await failOrRetryTask({
        run,
        leaseToken,
        code: classified.code,
        retryable: classified.retryable,
      });
      if (outcome === "RETRYING") {
        metrics.inc("agent_task_outcomes_total", { operation: "conversation", outcome: "retrying" });
        await publishPhase(run, "RETRYING", traceparent);
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
          traceparent,
        });
      }
      return true;
    } finally {
      clearInterval(leaseTimer);
      clearInterval(cancellationTimer);
    }
  });
}

function classifyTaskError(error: unknown): {
  code: "NETWORK" | "UPSTREAM_5XX" | "UPSTREAM_FAILURE" | "TIMEOUT" | "SCHEMA_PARSE" | "POLICY_DENIED" | "SEARCH_PREFERENCES_STALE" | "PLANNING_DATA_UNAVAILABLE" | "UNKNOWN_SKILL" | "TOOL_CALL_MAX_TURNS" | "INTERNAL";
  retryable: boolean;
} {
  const code = error instanceof SkillError ? error.code : (error as { code?: string }).code;
  if (code === "TIMEOUT") return { code: "TIMEOUT", retryable: true };
  if (code === "NETWORK") return { code: "NETWORK", retryable: true };
  if (code === "UPSTREAM_5XX") return { code: "UPSTREAM_5XX", retryable: true };
  if (code === "UPSTREAM_FAILURE") return { code: "UPSTREAM_FAILURE", retryable: true };
  if (code === "SCHEMA_PARSE" || code === "OUTPUT_INVALID" || code === "INPUT_INVALID" || code === "PLAN_VALIDATION_FAILED") return { code: "SCHEMA_PARSE", retryable: false };
  if (code === "POLICY_DENIED") return { code: "POLICY_DENIED", retryable: false };
  if (code === "SEARCH_PREFERENCES_STALE") return { code: "SEARCH_PREFERENCES_STALE", retryable: false };
  if (code === "PLANNING_DATA_UNAVAILABLE") return { code: "PLANNING_DATA_UNAVAILABLE", retryable: false };
  if (code === "UNKNOWN_SKILL") return { code: "UNKNOWN_SKILL", retryable: false };
  if (code === "TOOL_CALL_MAX_TURNS") return { code: "TOOL_CALL_MAX_TURNS", retryable: false };
  return { code: "INTERNAL", retryable: false };
}
