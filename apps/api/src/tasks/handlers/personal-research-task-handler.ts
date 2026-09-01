/**
 * DRAFT Personal Research task handler.
 *
 * Mirrors `research-task-handler.ts`. Called from `handlePlanningTask` when
 * `run.operation === "PERSONAL_RESEARCH"`. The handler:
 *   1. Re-checks the run row invariant (owner-only, thread-bound, no snapshot).
 *   2. Calls `DefaultPolicyGate.requirePersonalResearchAuthority`.
 *   3. Loads the typed, immutable request captured when the owner confirmed it.
 *   4. Invokes the capability-specific executor via `executePersonalResearch`.
 *   5. Writes the terminal state with `completePersonalResearchTask`.
 *
 * Failure modes (provider timeout / rate limit / missing config / etc.) all
 * map to `outcome: "UNAVAILABLE"` with a typed errorCode. No fixture /
 * Demo data / model content ever lands in `personal_research_evidence`.
 *
 * Source: docs/draft-personal-research-implementation.md §3.2, §3.3.
 */

import { eq } from "drizzle-orm";

import { db } from "../../db/database.js";
import { personalResearchRequests } from "../../db/schema.js";
import { DefaultPolicyGate } from "../../agents/policy-gate.js";
import type { ResearchAuthority } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import {
  agentRunErrorCodeSchema,
  personalResearchConfirmAcceptedResponseSchema,
  personalResearchOwnerDraftSchema,
} from "../../types/schemas.js";
import type {
  PersonalResearchOperationCapability,
  PersonalResearchOwnerDraft,
} from "../../types/domain.js";
import { capabilityForDraft, executePersonalResearch } from "../../services/personal-research-service.js";
import {
  completePersonalResearchTask,
  failPersonalResearchTask,
  type AgentTaskRow,
} from "../task-repository.js";
import type { RequestContext } from "../../utils/context.js";
import { publishPhase } from "./conversation-task-handler.js";

export async function handlePersonalResearchTask(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  leaseToken?: string;
}): Promise<string | null> {
  if (params.run.operation !== "PERSONAL_RESEARCH") {
    throw new Error(`handlePersonalResearchTask called for non-PERSONAL_RESEARCH operation ${params.run.operation}`);
  }
  if (!params.run.tripId || !params.run.threadId) {
    throw new SkillError("POLICY_DENIED", "Personal research run missing trip/thread binding");
  }
  if (params.run.snapshotId !== null) {
    throw new SkillError("POLICY_DENIED", "Personal research run must not carry a snapshot");
  }
  const capability = (params.run.requestedCapabilities ?? [])[0] as PersonalResearchOperationCapability | undefined;
  if (!capability) {
    await failPersonalResearchTask({
      ctx: params.ctx,
      run: params.run,
      leaseToken: params.leaseToken,
      code: "INTERNAL",
    });
    return null;
  }

  const policyGate = new DefaultPolicyGate("personal");
  const authority: ResearchAuthority = {
    kind: "PERSONAL",
    tripId: params.run.tripId,
    threadId: params.run.threadId,
    ownerUserId: params.run.createdByUserId,
    runId: params.run.id,
    capability,
  };
  policyGate.requirePersonalResearchAuthority(authority, params.run);

  await publishPhase(params.run, "RESEARCHING", params.ctx.traceparent);

  const draft = await loadTypedDraft({
    run: params.run,
    capability,
  });
  if (!draft) {
    await failPersonalResearchTask({
      ctx: params.ctx,
      run: params.run,
      leaseToken: params.leaseToken,
      code: "INTERNAL",
    });
    return null;
  }

  await publishPhase(params.run, "VALIDATING", params.ctx.traceparent);

  let executorResult: Awaited<ReturnType<typeof executePersonalResearch>>;
  try {
    executorResult = await executePersonalResearch({
      run: params.run,
      draft,
      signal: params.signal,
    });
  } catch (err) {
    const code = (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string")
      ? agentRunErrorCodeSchema.parse((err as { code: string }).code)
      : "INTERNAL";
    await failPersonalResearchTask({
      ctx: params.ctx,
      run: params.run,
      leaseToken: params.leaseToken,
      code,
    });
    return null;
  }

  await publishPhase(params.run, "PERSISTING", params.ctx.traceparent);

  await completePersonalResearchTask({
    ctx: params.ctx,
    run: params.run,
    leaseToken: params.leaseToken,
    outcome: executorResult.outcome,
    evidenceId: executorResult.evidenceId,
  });

  return null;
}

async function loadTypedDraft(params: {
  run: AgentTaskRow;
  capability: PersonalResearchOperationCapability;
}): Promise<PersonalResearchOwnerDraft | null> {
  const [request] = await db.select({
    capability: personalResearchRequests.capability,
    inputJson: personalResearchRequests.inputJson,
  }).from(personalResearchRequests).where(eq(personalResearchRequests.runId, params.run.id)).limit(1);
  if (request?.capability !== params.capability) return null;
  const raw = request?.inputJson;
  if (!raw) return null;
  // The persisted draft is the Zod-validated object that the OWNER drafted
  // through PUT /personal-research/answers. We re-parse to verify and to
  // obtain a typed `PersonalResearchOwnerDraft` instance.
  const parsed = personalResearchOwnerDraftSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (capabilityForDraft(parsed.data) !== params.capability) return null;
  return parsed.data;
}

// Re-export for the route layer / tests
export { personalResearchConfirmAcceptedResponseSchema };
