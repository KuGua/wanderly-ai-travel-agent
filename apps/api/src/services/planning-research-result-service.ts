import { z } from "zod";
import { db } from "../db/database.js";
import { planningResearchResults, researchResultStatusEnum } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";
import type { PlanningResearchResult, ServiceCapability, ServiceGapCode, ResearchResultStatus } from "../types/domain.js";
import type { ResearchSummaryReason } from "./planning-service.js";
import { recordAudit } from "./audit-service.js";
import { SkillError } from "../agents/errors.js";

/**
 * Spec §4.2 / §4.3 — PlanningResearchResult.
 *
 * The research result is the durable record of what the planner attempted and
 * what it found. It is the only path through which `agent_task_runs` can
 * terminate as `COMPLETED_WITH_GAPS` (or `COMPLETE`) without also persisting
 * an itinerary_plan. It carries NO booking or confirmation authority.
 *
 * Safe DTO contract:
 *   * `serviceGaps` only contains a bounded set of `(capability, code)` pairs
 *     plus an optional `destinationId`. Coordinates, raw payloads, and free
 *     text never enter this row.
 *   * The summary rows in `audit_events` for `RESEARCH_RESULT_RECORDED`
 *     only carry `status` and the high-cardinality `taskRunId` / `tripId`
 *     which already exist in the audit schema.
 */

export const serviceCapabilitySchema = z.enum(["flight", "stay", "hotel", "accommodation", "activities", "places", "navigation", "transit", "mobility", "readiness"]);
export const providerUnavailableCodeSchema = z.enum([
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
  "PROVIDER_REQUEST_REJECTED",
]);

/**
 * A gap can also be ours: `SKILL_CONTRACT_VIOLATION` is raised by the
 * orchestrator when a Skill's own input/output contract rejected a legitimate
 * provider answer. It is not in `providerUnavailableCodeSchema` because no
 * adapter may produce it. Persistence must accept it — a narrower gate here
 * would fail the write and lose the very outcome the run is trying to report,
 * which is the same shape of bug this code exists to name.
 */
export const serviceGapCodeSchema = z.enum([
  ...providerUnavailableCodeSchema.options,
  "SKILL_CONTRACT_VIOLATION",
]);

/**
 * Turn a failed capability invocation into the gap code the traveller will
 * eventually read. Shared by the Personal orchestrator and the Shared
 * planner's tool dispatch, so one failure classifies the same way whichever
 * loop met it.
 *
 * `SkillError` carries a typed code, so classify on that first and treat the
 * message only as a last resort for foreign errors. Reading the text was how
 * this produced its worst answers: nothing in "Output validation failed for
 * accommodation.discover" matches any of the substrings below, so a Skill
 * rejecting its own valid output fell through to the default and told the
 * traveller a healthy supplier was down. It is the same failure as
 * `docs/shared-agent-findings.md` #21, where a quota message containing
 * "limit: 25000" was read as a 5xx by a regex over the message.
 *
 * The default stays `UPSTREAM_FAILURE` — an unclassifiable foreign error is
 * more likely an upstream one — but every code we can actually name now gets
 * named before we reach it.
 */
export function classifyError(err: unknown): ServiceGapCode {
  if (err instanceof SkillError) {
    switch (err.code) {
      case "TIMEOUT":
        return "UPSTREAM_TIMEOUT";
      case "RATE_LIMITED":
        return "RATE_LIMITED";
      case "NETWORK":
      case "UPSTREAM_5XX":
      case "UPSTREAM_FAILURE":
        return "UPSTREAM_FAILURE";
      // Our contract, not the supplier's health. The provider may well have
      // answered correctly and had its answer refused on the way out.
      case "INPUT_INVALID":
      case "OUTPUT_INVALID":
      case "SCHEMA_PARSE":
      case "SKILL_VERSION_MISMATCH":
      case "PLAN_VALIDATION_FAILED":
      case "UNKNOWN_SKILL":
        return "SKILL_CONTRACT_VIOLATION";
      // The call was refused before it left: authority, scope, or a missing
      // snapshot. Repaired by completing the request, not by retrying.
      case "POLICY_DENIED":
      case "TOOL_NOT_ALLOWED":
      case "SNAPSHOT_REQUIRED":
      case "SEARCH_PREFERENCES_STALE":
        return "SEARCH_CONSTRAINTS_INCOMPLETE";
    }
  }
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (message.includes("timeout")) return "UPSTREAM_TIMEOUT";
  if (message.includes("rate")) return "RATE_LIMITED";
  if (message.includes("upstream")) return "UPSTREAM_FAILURE";
  if (message.includes("not_configured") || message.includes("not configured")) return "NOT_CONFIGURED";
  if (message.includes("policy")) return "SEARCH_CONSTRAINTS_INCOMPLETE";
  return "UPSTREAM_FAILURE";
}

export const serviceGapSchema = z.object({
  capability: serviceCapabilitySchema,
  code: serviceGapCodeSchema,
  destinationId: z.string().min(1).max(64).optional(),
}).strict();

export type ServiceCapabilityInput = z.infer<typeof serviceCapabilitySchema>;
export type ServiceGapInput = z.infer<typeof serviceGapSchema>;

export interface RecordResearchResultInput {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
  status: (typeof researchResultStatusEnum.enumValues)[number];
  serviceGaps: ServiceGapInput[];
  resultPlanId?: string;
  /**
   * Why this run produced a research summary instead of a plan. NULL on
   * legacy rows and on runs that did carry a plan. The four values match
   * the SQL CHECK constraint `planning_research_results_summary_reason_check`.
   */
  summaryReason?: ResearchSummaryReason | null;
}

export const RECORD_RESEARCH_RESULT_MAX_GAPS = 32;

/**
 * Persist a research result row + audit row in one transaction. Idempotent
 * on `(agentTaskRunId)` thanks to the partial unique index. The caller
 * (planning-service handler) decides whether `status` is `COMPLETE` or
 * `COMPLETED_WITH_GAPS` based on whether any service gap is present.
 */
export async function recordPlanningResearchResult(input: RecordResearchResultInput): Promise<string> {
  if (input.serviceGaps.length > RECORD_RESEARCH_RESULT_MAX_GAPS) {
    throw new Error(`recordPlanningResearchResult: too many serviceGaps (${input.serviceGaps.length} > ${RECORD_RESEARCH_RESULT_MAX_GAPS})`);
  }
  // Validate gaps up front; never persist malformed data.
  const gaps = input.serviceGaps.map((g) => serviceGapSchema.parse(g));
  const [row] = await db.transaction(async (tx) => {
    const insertValues = {
      tripId: input.tripId,
      snapshotId: input.snapshotId,
      agentTaskRunId: input.agentTaskRunId ?? null,
      status: input.status,
      serviceGaps: gaps,
      resultPlanId: input.resultPlanId ?? null,
      summaryReason: input.summaryReason ?? null,
    };
    const [inserted] = await tx.insert(planningResearchResults).values(insertValues)
      .onConflictDoUpdate({
        target: planningResearchResults.agentTaskRunId,
        set: {
          status: insertValues.status,
          serviceGaps: insertValues.serviceGaps,
          resultPlanId: insertValues.resultPlanId,
          summaryReason: insertValues.summaryReason,
        },
      })
      .returning({ id: planningResearchResults.id });
    await recordAudit({
      ctx: input.ctx,
      action: "RESEARCH_RESULT_RECORDED",
      tripId: input.tripId,
      summary: {
        status: input.status,
        gapCount: gaps.length,
        capabilities: sortedCapabilities(gaps),
      },
      tx,
    });
    return [inserted];
  });
  return row.id;
}

function sortedCapabilities(gaps: ReadonlyArray<{ capability: string }>): string[] {
  return [...new Set(gaps.map((g) => g.capability))].sort();
}

/**
 * Reduce a list of gaps into a stable, model-safe DTO. The web client
 * receives this through `/api/v1/trips/{tripId}/research/latest` and renders
 * the `RESEARCH_SUMMARY` banner.
 */
export function toResearchResultDto(row: {
  id: string;
  tripId: string;
  snapshotId: string;
  agentTaskRunId: string | null;
  status: ResearchResultStatus;
  serviceGaps: Array<{ capability: ServiceCapability; code: ServiceGapCode; destinationId?: string }>;
  resultPlanId: string | null;
  summaryReason: ResearchSummaryReason | null;
  createdAt: Date;
}): PlanningResearchResult {
  return {
    id: row.id,
    tripId: row.tripId,
    snapshotId: row.snapshotId,
    agentTaskRunId: row.agentTaskRunId,
    status: row.status,
    serviceGaps: row.serviceGaps as PlanningResearchResult["serviceGaps"],
    resultPlanId: row.resultPlanId,
    summaryReason: row.summaryReason,
    createdAt: row.createdAt.toISOString(),
  };
}

export function isGapOnlyStatus(gaps: ReadonlyArray<ServiceGapInput>): boolean {
  return gaps.length > 0;
}
