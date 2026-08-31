/**
 * Agent Run — Dismiss Research Intent — Phase 2.
 *
 * `POST /api/v1/agent-runs/:runId/dismiss-intent` — owner-driven transition
 * of a PROPOSED research-intent draft to DISMISSED. The route never deletes
 * the draft; it preserves the body so post-draft analysis (logs, audit,
 * recovery) can still inspect what was proposed.
 *
 * Hard invariants:
 * - The caller MUST own the run (existing `getAuthorizedAgentRun` /
 *   `requireRunAccess` boundary).
 * - The run MUST be a CONVERSATION with state = PROPOSED. Other states
 *   return 409 — never silently transition a CONFIRMED or SUPERSEDED row.
 * - The state transition is guarded by the fromState predicate inside
 *   `transitionResearchIntentState` so a parallel request cannot observe
 *   an inconsistent intermediate state.
 * - On success the route publishes `research.intent_dismissed` SSE so the
 *   owner's open chat tab can unmount the card without waiting for the
 *   next 1.5 s `useAgentRun` poll.
 * - No provider call, no chat-content echo, no snapshot creation.
 *
 * Source: docs/personal-research-intent-routing-implementation.md §4.1,
 * §7 Phase 2.
 */

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { agentTaskRuns } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import {
  getAuthorizedAgentRun,
  transitionResearchIntentState,
} from "../tasks/task-repository.js";
import { publishAgentStreamEvent } from "../tasks/task-stream-publisher.js";
import {
  errorResponseSchema,
  toJsonSchema,
  uuidSchema,
} from "../types/schemas.js";
import { z } from "zod";

const dismissPathParamsSchema = z.object({
  runId: uuidSchema,
}).strict();

export async function agentRunDismissIntentRoute(app: FastifyInstance): Promise<void> {
  app.post("/agent-runs/:runId/dismiss-intent", {
    schema: {
      description: "Phase 2 — dismiss a PROPOSED research-intent draft on a CONVERSATION run.",
      response: {
        204: { type: "null", description: "Draft transitioned to DISMISSED." },
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { runId } = dismissPathParamsSchema.parse(request.params);
    // `getAuthorizedAgentRun` enforces owner / member scope. A non-owner
    // returns 403 before the run type / state checks fire, so cross-user
    // leakage is impossible from this entry point.
    const run = await getAuthorizedAgentRun(runId, request.user.id);

    // Re-load the row for the (operation, state) gate — the
    // `getAuthorizedAgentRun` DTO hides SUPERSEDED state, but this route
    // must observe the real column value to reject DISMISSED→DISMISSED
    // double-clicks with 409 instead of silently succeeding.
    const [row] = await db.select({
      operation: agentTaskRuns.operation,
      state: agentTaskRuns.researchIntentState,
    }).from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
    if (!row) throw new ApiError(404, "Not Found", "Agent run not found");
    if (row.operation !== "CONVERSATION") {
      throw new ApiError(
        409,
        "Conflict",
        "RESEARCH_DRAFT_NOT_DISMISSABLE: only CONVERSATION runs carry a dismissable draft",
      );
    }
    if (row.state !== "PROPOSED") {
      throw new ApiError(
        409,
        "Conflict",
        `RESEARCH_DRAFT_NOT_DISMISSABLE: state is ${row.state ?? "NULL"}, expected PROPOSED`,
      );
    }

    // From-state guarded transition. Returns false on a parallel
    // dismissal race (someone else won the transition first); both
    // callers observe 409 — never a duplicate state column value.
    const transitioned = await transitionResearchIntentState({
      runId,
      fromState: "PROPOSED",
      toState: "DISMISSED",
    });
    if (!transitioned) {
      metrics.inc("personal_research_intent_confirmation_total", { outcome: "lease_lost" });
      throw new ApiError(
        409,
        "Conflict",
        "RESEARCH_DRAFT_NOT_DISMISSABLE: concurrent transition lost the from-state race",
      );
    }
    metrics.inc("personal_research_intent_confirmation_total", { outcome: "dismissed" });

    // Publish the SSE so an open chat tab unmounts the card immediately
    // rather than waiting for the next 1.5 s `useAgentRun` poll. The
    // payload carries only the dismissal timestamp — never the question
    // text, place names, or draft body.
    const dismissedAt = new Date().toISOString();
    await publishAgentStreamEvent({
      event: "research.intent_dismissed",
      runId,
      generationAttempt: run.generationAttempt,
      dismissedAt,
      traceparent: request.traceparent,
    });

    return reply.code(204).send();
  });
}
