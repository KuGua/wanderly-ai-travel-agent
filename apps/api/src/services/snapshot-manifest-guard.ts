import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { constraintSnapshots } from "../db/schema.js";
import { extractSnapshotV2Meta } from "./planning-service.js";

/**
 * Phase 4 — shared snapshot-manifest guard.
 *
 * The projection-manifest hash lets the Worker detect a consent / preference
 * / trip-place mutation that landed between snapshot creation and plan
 * finalization (spec §1.7, §5.3). The hash is the canonical
 * `sha256(sorted-tuple-list)` where each tuple is
 * `${sourceId}|${revision}|${visibility}` taken from the snapshot's
 * `_meta.projectionManifest` (v2 envelope).
 *
 * Originally lived in `apps/api/src/tasks/handlers/planning-task-handler.ts`
 * — moved here so the Personal Trip Orchestrator can reuse it without
 * importing from the handler module.
 */
export function hashProjectionManifest(authorizedData: unknown): string {
  const meta = extractSnapshotV2Meta(authorizedData);
  const tuples: string[] = [];
  for (const entry of meta?.projectionManifest ?? []) {
    tuples.push(`${entry.sourceId}|${entry.revision}|${entry.visibility}`);
  }
  tuples.sort();
  return createHash("sha256").update(tuples.join("\n")).digest("hex");
}

/**
 * Phase 4 — re-reads the snapshot's `projectionManifest` and rejects when it
 * drifted mid-flight. Both the legacy PLAN/REPLAN handler and the new
 * RESEARCH orchestrator call this between research and finalization so a
 * mutation that landed in between cannot promote a stale plan.
 *
 * Throws an `Error` with `code: "STALE_SNAPSHOT_GUARD"` to mirror the legacy
 * planning-task-handler contract. Callers should catch and mark the run as
 * STALE rather than committing the result.
 */
export async function assertSnapshotManifestStable(
  snapshotId: string,
  initialHash: string,
): Promise<void> {
  const [finalSnapshot] = await db.select().from(constraintSnapshots)
    .where(eq(constraintSnapshots.id, snapshotId))
    .limit(1);
  if (finalSnapshot && hashProjectionManifest(finalSnapshot.authorizedData) !== initialHash) {
    throw Object.assign(
      new Error("Snapshot projection manifest changed during planning; result plan marked STALE"),
      { code: "STALE_SNAPSHOT_GUARD" },
    );
  }
}