import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/database.js";
import { consentGrants, preferenceFacts, tripConstraintFacts } from "../db/schema.js";

/**
 * Fingerprint of everything a snapshot's memory projection was built from
 * (docs/long-term-memory-implementation.md §6, planning commit row).
 *
 * A planning run reads memory once, then spends time in the model. Between
 * those points a member can revoke consent, edit a preference or change a trip
 * override. Without a check the run would happily activate a plan built on
 * memory that no longer exists.
 *
 * The fingerprint is recorded on the snapshot at creation and recomputed inside
 * the commit transaction. Any difference means the sources moved and the plan
 * must not become authoritative.
 *
 * It deliberately hashes *identities and versions*, never values: the snapshot
 * is readable by anyone who can read a plan, and a value hash would leak
 * whether a member's preference changed to a particular thing.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MemorySourceFingerprintInput = {
  tripId: string;
  memberUserIds: string[];
  tx?: Tx;
};

/**
 * Stable hash over the projection's inputs.
 *
 * Rows are sorted before hashing so the result does not depend on the order the
 * database happened to return them.
 */
export async function computeMemorySourceFingerprint(
  input: MemorySourceFingerprintInput,
): Promise<string> {
  const target = input.tx ?? db;
  const members = [...input.memberUserIds].sort();
  if (members.length === 0) return createHash("sha256").update("empty").digest("hex").slice(0, 32);

  // Consent decides what may be projected at all, so a grant flipping off has
  // to invalidate the run even though no fact changed.
  const grants = await target.select({
    id: consentGrants.id,
    userId: consentGrants.userId,
    scope: consentGrants.scope,
    granted: consentGrants.granted,
    fieldList: consentGrants.fieldList,
  })
    .from(consentGrants)
    .where(and(
      eq(consentGrants.tripId, input.tripId),
      inArray(consentGrants.userId, members),
    ));

  const facts = await target.select({
    id: preferenceFacts.id,
    userId: preferenceFacts.userId,
    fieldKey: preferenceFacts.fieldKey,
    updatedAt: preferenceFacts.updatedAt,
  })
    .from(preferenceFacts)
    .where(and(
      inArray(preferenceFacts.userId, members),
      eq(preferenceFacts.status, "ACTIVE"),
    ));

  const tripFacts = await target.select({
    id: tripConstraintFacts.id,
    kind: tripConstraintFacts.kind,
    fieldKey: tripConstraintFacts.fieldKey,
    revision: tripConstraintFacts.revision,
  })
    .from(tripConstraintFacts)
    .where(and(
      eq(tripConstraintFacts.tripId, input.tripId),
      eq(tripConstraintFacts.status, "ACTIVE"),
    ));

  const parts = [
    ...grants.map((row) =>
      `c:${row.id}:${row.userId}:${row.scope}:${row.granted}:${(row.fieldList ?? []).slice().sort().join(",")}`),
    ...facts.map((row) => `f:${row.id}:${row.userId}:${row.fieldKey}:${row.updatedAt.toISOString()}`),
    ...tripFacts.map((row) => `t:${row.id}:${row.kind}:${row.fieldKey}:${row.revision}`),
  ].sort();

  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/** Raised when the projection sources moved between snapshot and commit. */
export class MemorySourceChangedError extends Error {
  constructor(readonly snapshotId: string) {
    super("Memory projection sources changed after the snapshot was taken");
    this.name = "MemorySourceChangedError";
  }
}

/** Reads the fingerprint recorded on a snapshot, or `null` for older rows. */
export function fingerprintFromSnapshot(authorizedData: unknown): string | null {
  if (!authorizedData || typeof authorizedData !== "object") return null;
  const meta = (authorizedData as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>).memorySourceFingerprint;
  return typeof value === "string" ? value : null;
}
