import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/database.js";
import { itineraryPlans } from "../db/schema.js";
import { tripMembers } from "../db/schema.js";

/**
 * Team Agent 协作编排 — Trip-level plan listing (spec §5.2, §7).
 *
 * Spec §1.2: confidential values are removed before serialization. Every plan
 * returned here carries the validated `planData` already produced by
 * `validatePlanOutput` — which includes the `assertConfidentialFree` check
 * — so the v2 `planData` never contained raw confidential values to begin with.
 * Still, this reader performs a defense-in-depth pass to ensure no free-text
 * ride-along fields slip past.
 *
 * The response is grouped by status into `proposed / active / stale` so the
 * web client can render a comparison view across one ACTIVE + one PROPOSED
 * + last-known STALE per trip.
 */
export interface ListedPlan {
  id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "PROPOSED" | "STALE" | "SUPERSEDED";
  snapshotId: string;
  generatedAt: string;
  destination: string;
  destinationCandidatesEvaluated: string[];
  replacedByPlanId: string | null;
  staleReason: string | null;
  planData: Record<string, unknown>;
}

export async function listTripPlans(params: {
  tripId: string;
  viewerUserId: string;
}): Promise<{
  proposed: ListedPlan[];
  active: ListedPlan[];
  stale: ListedPlan[];
}> {
  const [member] = await db.select({ id: tripMembers.id })
    .from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, params.tripId),
      eq(tripMembers.userId, params.viewerUserId),
    ))
    .limit(1);
  if (!member) {
    return { proposed: [], active: [], stale: [] };
  }

  const rows = await db.select({
    id: itineraryPlans.id,
    version: itineraryPlans.version,
    status: itineraryPlans.status,
    snapshotId: itineraryPlans.snapshotId,
    planData: itineraryPlans.planData,
    replacedByPlanId: itineraryPlans.replacedByPlanId,
    staleReason: itineraryPlans.staleReason,
    createdAt: itineraryPlans.createdAt,
  }).from(itineraryPlans)
    .where(eq(itineraryPlans.tripId, params.tripId))
    .orderBy(desc(itineraryPlans.version));

  const proposed: ListedPlan[] = [];
  const active: ListedPlan[] = [];
  const stale: ListedPlan[] = [];

  for (const row of rows) {
    if (!isVisibleStatus(row.status)) continue;
    const safe = redactPlanForViewer(row.planData as Record<string, unknown>);
    const derived = derivePlanMeta(safe);
    const item: ListedPlan = {
      id: row.id,
      version: row.version,
      status: row.status,
      snapshotId: row.snapshotId,
      generatedAt: typeof safe.generatedAt === "string" ? safe.generatedAt : new Date(row.createdAt).toISOString(),
      destination: derived.destination ?? "",
      destinationCandidatesEvaluated: derived.destinationCandidatesEvaluated,
      replacedByPlanId: row.replacedByPlanId ?? null,
      staleReason: row.staleReason ?? null,
      planData: safe,
    };
    if (row.status === "PROPOSED") proposed.push(item);
    else if (row.status === "ACTIVE") active.push(item);
    else if (row.status === "STALE" || row.status === "SUPERSEDED") stale.push(item);
  }

  return { proposed, active, stale };
}

function isVisibleStatus(status: string): boolean {
  return status === "PROPOSED" || status === "ACTIVE" || status === "STALE" || status === "SUPERSEDED";
}

/**
 * Defense-in-depth redaction — strips fields that the validator already vetoed,
 * but in case an older (v1) plan arrives here we still scrub common keys.
 *
 * Exported for unit tests (spec §10.2 visibility-bleed.test.ts).
 */
export function redactPlanForViewer(planData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(planData)) {
    if (key === "_meta" || key === "orchestratorConfidential") continue;
    if (key === "constraintReferences") {
      out[key] = Array.isArray(value) ? value.filter((ref) => typeof ref === "string" && !ref.includes("private")) : [];
      continue;
    }
    if (key === "publicExplanationTokens") {
      // Allow only well-known tokens through (defensive — validator should have caught violations).
      if (Array.isArray(value)) {
        out[key] = value.filter((token): token is string =>
          typeof token === "string"
          && /^[A-Z][A-Z0-9_]+$/.test(token),
        );
      } else {
        out[key] = [];
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function derivePlanMeta(safe: Record<string, unknown>): {
  destination?: string;
  destinationCandidatesEvaluated: string[];
} {
  const destination = typeof safe.destination === "string" ? safe.destination : undefined;
  const evaluated = Array.isArray(safe.destinationCandidatesEvaluated)
    ? safe.destinationCandidatesEvaluated.filter((v): v is string => typeof v === "string")
    : [];
  return { destination, destinationCandidatesEvaluated: evaluated };
}
