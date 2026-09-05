import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { agentRuns } from "../db/schema.js";
import type { AgentKind } from "../agents/contracts.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "../services/audit-service.js";
import { pinoInstance } from "./telemetry.js";

export type AgentRunStatus = "SUCCESS" | "TIMEOUT" | "ERROR";

export interface AgentRunTokens {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * Persists derived LLM-run telemetry without changing the caller's business
 * outcome when the observability store is unavailable. `AGENT_RUN` is useful
 * for diagnosis, but it is not an authorization, state-transition, or
 * execution invariant. Keep strict audit writes at their owning business
 * boundaries; this exception is intentionally limited to this derived event.
 */
export async function recordAgentRun(params: {
  ctx: RequestContext;
  skillName: string;
  agentName: AgentKind;
  modelName: string;
  promptVersion: string;
  outputHash: string;
  latencyMs: number;
  status: AgentRunStatus;
  errorCode?: string;
  tokens?: AgentRunTokens;
}): Promise<"recorded" | "failed"> {
  const runId = randomUUID();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(agentRuns).values({
        runId,
        skillName: params.skillName,
        agentName: params.agentName,
        modelName: params.modelName,
        promptVersion: params.promptVersion,
        outputHash: params.outputHash,
        latencyMs: params.latencyMs,
        status: params.status,
        errorCode: params.errorCode,
        tokens: params.tokens ?? null,
      });

      await recordAudit({
        ctx: params.ctx,
        action: "AGENT_RUN",
        summary: {
          runId,
          skillName: params.skillName,
          agentName: params.agentName,
          modelName: params.modelName,
          status: params.status,
          errorCode: params.errorCode ?? null,
          latencyMs: params.latencyMs,
        },
        tx,
      });
    });
    return "recorded";
  } catch (error) {
    // Do not include an error message: database drivers can embed connection
    // strings or provider response fragments. Correlation IDs are for logs
    // and traces only, never metric labels.
    try {
      pinoInstance.warn({
        component: "agent-run-observability",
        operation: "agent_run_record",
        diagnostic: "OBSERVABILITY_FAILURE",
        errorClass: error instanceof Error ? error.name : typeof error,
        correlationId: params.ctx.correlationId,
        clientRequestId: params.ctx.clientRequestId,
        traceId: params.ctx.traceId,
        spanId: params.ctx.spanId,
      }, "Agent run observability was not recorded");
    } catch {
      // The fallback logger is itself observability infrastructure. A broken
      // sink must not undermine the same best-effort guarantee.
    }
    return "failed";
  }
}
