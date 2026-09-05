import { SkillError } from "../agents/errors.js";
import { context as otelContext, SpanKind, trace as otelTrace } from "@opentelemetry/api";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent, pinoInstance } from "../observability/telemetry.js";
import {
  getTracer,
  parseTraceparent,
  safeSetAttribute,
} from "../observability/tracing.js";
import { eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { agentTaskRuns, sharedTrips } from "../db/schema.js";
import {
  mergePendingBriefProposal,
  normalizeBriefProposalDestinations,
  withoutSettledFields,
  type TripBriefProposal,
} from "../services/trip-brief-proposal-service.js";
import { agentTaskConfig } from "../tasks/config.js";
import { handleConversationTask, publishPhase } from "../tasks/handlers/conversation-task-handler.js";
import { persistDestinationCue } from "../services/destination-cue-service.js";
import { persistOfferCue } from "../services/offer-cue-service.js";
import { getUserMessageSequenceForRun } from "../services/personal-research-sequence.js";
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
import { recordTaskMetrics, taskMetricOperation, type TaskMetricOutcome } from "../tasks/task-observability.js";

/**
 * Open the worker root span for a claimed task. The span is linked to the
 * originating HTTP server span via `parseTraceparent` so the trace stays
 * continuous across the durable boundary. When the task row has no trace
 * context (old rows, recovery path, replay) we fall back to a fresh span.
 */
function openWorkerRunSpan(run: AgentTaskRow, claimDurationMs: number) {
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
        "tasks.operation": taskMetricOperation(run.operation),
        "tasks.attempt": run.generationAttempt,
        "tasks.recovery": tc === null,
        // Latency of the claim query that produced this row. Carried here
        // rather than on its own span so an empty poll — the overwhelming
        // majority of them — costs no trace at all.
        "tasks.claim_duration_ms": Math.round(claimDurationMs),
      },
      links,
    },
  );
  safeSetAttribute(span, "app.correlation_id", tc?.correlationId ?? run.requestId);
  return span;
}

/**
 * Folds this turn's brief proposal into the one the trip already carries, and
 * stores what survives the date-coherence guard.
 *
 * Read-modify-write under a row lock rather than the jsonb `||` this replaced:
 * the merge has to be able to reject the combined pair, and `||` can only
 * overwrite keys. Returns what was stored, or `null` when nothing was.
 */
async function persistPendingBriefProposal(
  tripId: string,
  incoming: TripBriefProposal,
): Promise<TripBriefProposal | null> {
  return db.transaction(async (tx) => {
    const [trip] = await tx.select({
      pending: sharedTrips.pendingBriefProposal,
      departureCities: sharedTrips.departureCities,
      destinationCandidates: sharedTrips.destinationCandidates,
      travelDateStart: sharedTrips.travelDateStart,
      travelDateEnd: sharedTrips.travelDateEnd,
      travelDays: sharedTrips.travelDays,
    })
      .from(sharedTrips).where(eq(sharedTrips.id, tripId)).for("update").limit(1);
    if (!trip) return null;
    const { proposal, result } = mergePendingBriefProposal(
      trip.pending as TripBriefProposal | null,
      incoming,
    );
    metrics.inc("trip_brief_proposal_dates_total", { result });
    // Subtract what the trip has already settled. Without this a turn that
    // merely repeats a saved fact still carries a proposal, and a proposal is
    // what puts the review card back on screen — asking again about a
    // destination the traveller confirmed turns ago.
    const unsettled = withoutSettledFields(proposal, {
      departureCities: trip.departureCities ?? [],
      destinationCandidates: trip.destinationCandidates ?? [],
      travelDateStart: trip.travelDateStart ?? null,
      travelDateEnd: trip.travelDateEnd ?? null,
      travelDays: trip.travelDays ?? null,
    });
    await tx.update(sharedTrips)
      .set({ pendingBriefProposal: unsettled })
      .where(eq(sharedTrips.id, tripId));
    return unsettled;
  });
}

async function persistedPlanningOutcome(run: AgentTaskRow): Promise<TaskMetricOutcome> {
  const [persisted] = await db.select({ status: agentTaskRuns.status })
    .from(agentTaskRuns).where(eq(agentTaskRuns.id, run.id)).limit(1);
  return persisted?.status === "COMPLETED_WITH_GAPS" ? "completed_with_gaps" : "completed";
}

/**
 * Helper that wraps a callback with the worker span set as active. Returns
 * the callback's return value while ensuring AsyncLocalStorage carries the
 * span context for child operations.
 */
async function withWorkerSpan<T>(
  run: AgentTaskRow,
  claimDurationMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const span = openWorkerRunSpan(run, claimDurationMs);
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
  const claimStartedAt = performance.now();
  const run = await claimNextConversationTask() ?? await claimNextPlanningTask();
  const claimDurationMs = performance.now() - claimStartedAt;
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

  return withWorkerSpan(run, claimDurationMs, async () => {
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
        await publishAgentStreamEvent({ event: "turn.completed", runId: run.id, generationAttempt: run.generationAttempt, resultPlanId: planId ?? undefined, traceparent });
        recordTaskMetrics(run, await persistedPlanningOutcome(run));
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
        recordTaskMetrics(run, "completed");
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
      const briefProposal = output.tripBriefProposal
        ? normalizeBriefProposalDestinations(output.tripBriefProposal)
        : null;
      if (output.tripBriefProposal && !briefProposal) {
        metrics.inc("trip_brief_proposal_destination_resolution_total", { result: "rejected" });
      }
      if (briefProposal) {
        metrics.inc("trip_brief_proposal_destination_resolution_total", { result: "accepted" });
      }
      if (output.destinationCueDecision) {
        try {
          const decision = await output.destinationCueDecision;
          const cue = decision ? await persistDestinationCue({ run, decision }) : null;
          if (cue) {
            await publishAgentStreamEvent({
              event: "destination.cue_ready",
              runId: run.id,
              generationAttempt: run.generationAttempt,
              cue,
              traceparent,
            });
          }
        } catch (error) {
          // The cue is an optional confirmation affordance. Conversation
          // persistence and delivery must survive classifier/state failures.
          logSafeRuntimeEvent(ctx, {
            component: "worker",
            event: "destination_cue",
            operation: "conversation",
            outcome: "failure",
            errorCode: error instanceof Error ? error.name : "INTERNAL",
            relatedRunId: run.id,
          });
        }
      }
      if (output.flightOfferCueDecision || output.hotelOfferCueDecision) {
        const currentUserMessageSequence = run.tripId
          ? await getUserMessageSequenceForRun({ runId: run.id, tripId: run.tripId })
          : null;
        if (currentUserMessageSequence !== null) {
          if (output.flightOfferCueDecision) {
            try {
              const decision = await output.flightOfferCueDecision;
              if (decision) {
                const outcome = await persistOfferCue({
                  ctx,
                  run,
                  decision,
                  currentUserMessageSequence,
                  capability: "flight",
                });
                if (outcome) {
                  await publishAgentStreamEvent({
                    event: "flight.offer_cue_ready",
                    runId: run.id,
                    generationAttempt: run.generationAttempt,
                    cue: outcome.cue,
                    traceparent,
                  });
                }
              }
            } catch (error) {
              logSafeRuntimeEvent(ctx, {
                component: "offer_cue",
                event: "flight_offer_cue",
                operation: "flight.offer.cue",
                outcome: "failure",
                errorCode: error instanceof Error ? error.name : "INTERNAL",
                relatedRunId: run.id,
              });
            }
          }
          if (output.hotelOfferCueDecision) {
            try {
              const decision = await output.hotelOfferCueDecision;
              if (decision) {
                const outcome = await persistOfferCue({
                  ctx,
                  run,
                  decision,
                  currentUserMessageSequence,
                  capability: "hotel",
                });
                if (outcome) {
                  await publishAgentStreamEvent({
                    event: "hotel.offer_cue_ready",
                    runId: run.id,
                    generationAttempt: run.generationAttempt,
                    cue: outcome.cue,
                    traceparent,
                  });
                }
              }
            } catch (error) {
              logSafeRuntimeEvent(ctx, {
                component: "offer_cue",
                event: "hotel_offer_cue",
                operation: "hotel.offer.cue",
                outcome: "failure",
                errorCode: error instanceof Error ? error.name : "INTERNAL",
                relatedRunId: run.id,
              });
            }
          }
        }
      }
      if (briefProposal) {
        // Persist before publishing: the notification can be missed, the row
        // cannot. The client rebuilds the card from the run it already polls.
        await db.update(agentTaskRuns)
          .set({ tripBriefProposal: briefProposal })
          .where(eq(agentTaskRuns.id, run.id));
        // Also on the trip, where it survives a reload and a device change.
        // Merged, because a brief is often given across several turns and the
        // card is a running review of all of them — which is also why the
        // merge happens here rather than in a jsonb `||`: a start date from
        // one turn can meet an end date from another, and a pair that cannot
        // be true has to be dropped before it becomes a card nobody can save.
        const persisted = run.tripId
          ? await persistPendingBriefProposal(run.tripId, briefProposal)
          : briefProposal;
        // The card is built from what was stored, never from what the turn
        // proposed: publishing the unguarded value would put a date on screen
        // that the trip does not have and the write boundary would refuse.
        if (persisted) {
          await publishAgentStreamEvent({
            event: "trip.brief_proposed",
            runId: run.id,
            generationAttempt: run.generationAttempt,
            proposal: persisted,
            traceparent,
          });
        }
      }
      await publishAgentStreamEvent({
        event: "turn.completed",
        runId: run.id,
        generationAttempt: run.generationAttempt,
        assistantMessageId: assistant.id,
        responseMode: output.responseMode,
        traceparent,
      });
      recordTaskMetrics(run, "completed");
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
          recordTaskMetrics(run, "cancelled");
        }
        return true;
      }

      const classified = classifyTaskError(error);
      logSafeRuntimeEvent(ctx, {
        component: "worker", event: "task", operation: run.operation.toLowerCase(),
        outcome: "failure", attempt: run.generationAttempt, errorCode: classified.code,
        relatedRunId: run.id,
      });
      // The classified code alone says a task failed and nothing about why:
      // INTERNAL covers every unclassified throw in planning, and chasing one
      // meant adding a temporary probe and reproducing it. The class and the
      // throw site are developer-authored strings, so they are safe to keep;
      // a message can quote input, so it is capped rather than trusted, and
      // never becomes a metric label.
      pinoInstance.warn({
        component: "agent-task-worker",
        runId: run.id,
        operation: run.operation,
        errorCode: classified.code,
        errorClass: (error as Error)?.name ?? typeof error,
        errorMessage: String((error as Error)?.message ?? error).slice(0, 300),
        throwSite: String((error as Error)?.stack ?? "").split("\n")[1]?.trim().slice(0, 200),
      }, "Durable task failed");
      const outcome = await failOrRetryTask({
        run,
        leaseToken,
        code: classified.code,
        retryable: classified.retryable,
      });
      if (outcome === "RETRYING") {
        recordTaskMetrics(run, "retrying");
        await publishPhase(run, "RETRYING", traceparent);
      } else if (outcome === "FAILED") {
        recordTaskMetrics(run, "failed");
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
