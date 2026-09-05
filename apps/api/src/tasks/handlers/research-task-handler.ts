import type { RequestContext } from "../../utils/context.js";
import type { AgentTaskRow } from "../task-repository.js";
import { completeResearchTask } from "../task-repository.js";
import {
  pinSessionIfTerminal,
  runResearch,
} from "../personal-trip-orchestrator-service.js";
import { publishPhase } from "./conversation-task-handler.js";
import { publishAgentStreamEvent } from "../task-stream-publisher.js";

/**
 * Phase 2 — Personal Trip Orchestrator Worker handler.
 *
 * Invoked by `handlePlanningTask` early-return when `run.operation ===
 * "RESEARCH"`. Validates the run row, drives the orchestrator under the
 * lease, publishes `research.stage` SSE events on lifecycle transitions,
 * and finalises the run via `completeResearchTask` (lease-guarded).
 *
 * The orchestrator body (`personal-trip-orchestrator-service.runResearch`)
 * is a Phase 2 stub that returns `{ outcome: "COMPLETED" }`. Phase 3
 * replaces it with the full capability dispatcher and Phase 4 wires the
 * `PROPOSE_PLAN` synthesis through `generatePlan`.
 */
export async function handleResearchTask(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  leaseToken: string;
}): Promise<string | null> {
  if (params.run.operation !== "RESEARCH") {
    throw new Error(`handleResearchTask called for ${params.run.operation} (expected RESEARCH)`);
  }
  if (!params.run.snapshotId || !params.run.tripId) {
    throw new Error("RESEARCH run is missing snapshot or trip binding");
  }

  // Coverage / research phase — the orchestrator emits its own
  // `research.stage RESEARCHING` event. We add `VALIDATING` and `PERSISTING`
  // around the orchestrator's lease-bound commit.
  await publishPhase(params.run, "RESEARCHING", params.ctx.traceparent);

  const result = await runResearch({
    ctx: params.ctx,
    run: params.run,
    signal: params.signal,
    leaseToken: params.leaseToken,
  });

  await publishPhase(params.run, "VALIDATING", params.ctx.traceparent);
  await publishAgentStreamEvent({
    event: "research.stage",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    stage: "VALIDATING",
    traceparent: params.ctx.traceparent,
  });

  await publishPhase(params.run, "PERSISTING", params.ctx.traceparent);
  await publishAgentStreamEvent({
    event: "research.stage",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    stage: "PERSISTING",
    traceparent: params.ctx.traceparent,
  });

  await completeResearchTask({
    ctx: params.ctx,
    run: params.run,
    leaseToken: params.leaseToken,
    outcome: result.outcome,
    researchResultId: result.researchResultId,
    resultPlanId: result.resultPlanId,
  });

  await publishAgentStreamEvent({
    event: "research.stage",
    runId: params.run.id,
    generationAttempt: params.run.generationAttempt,
    stage: result.outcome,
    traceparent: params.ctx.traceparent,
  });

  // Quick orchestration — auto-pin the terminal run on the trip header so
  // the owner sees the latest accepted research / plan result. Idempotent
  // and never throws; failure is logged via the pin_write_total counter.
  if (result.outcome === "COMPLETED" || result.outcome === "COMPLETED_WITH_GAPS") {
    await pinSessionIfTerminal({
      ctx: params.ctx,
      tripId: params.run.tripId,
      runId: params.run.id,
      outcome: result.outcome,
      ...(params.run.createdByUserId ? { actorUserId: params.run.createdByUserId } : {}),
    });
  }

  return result.resultPlanId ?? null;
}