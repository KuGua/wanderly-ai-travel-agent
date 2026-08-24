import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { agentRuns } from "../db/schema.js";
import type { AgentKind } from "../agents/contracts.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "../services/audit-service.js";

export type AgentRunStatus = "SUCCESS" | "FALLBACK" | "TIMEOUT" | "ERROR";

export interface AgentRunTokens {
  prompt: number;
  completion: number;
  total: number;
}

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
}): Promise<void> {
  const runId = randomUUID();

  await db.insert(agentRuns).values({
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
  });
}