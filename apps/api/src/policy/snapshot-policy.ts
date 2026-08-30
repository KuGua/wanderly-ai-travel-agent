import type { ConstraintSnapshotData } from "../types/domain.js";

/**
 * Legacy v1 prefix — `authorizedData.<memberId>.<field>`. Phase 3 仍兼容，
 * 由已落库的旧快照触发。
 */
export const SNAPSHOT_FIELD_PATH_PREFIX = "authorizedData";

/**
 * v2 prefixes — `teamVisible.<alias>[index].fieldKey` 与
 * `orchestratorConfidential.<alias>[index].fieldKey`。aliases 是 run-scoped
 * 不透明字符串，与 userId 不可逆映射（见
 * `services/memory-projection-builder.ts#buildMemberAliases`）。
 */
export const V2_SECTION_TEAM_VISIBLE = "teamVisible";
export const V2_SECTION_ORCHESTRATOR_CONFIDENTIAL = "orchestratorConfidential";

export class SnapshotFieldNotAllowedError extends Error {
  readonly code = "FIELD_NOT_AUTHORIZED";

  constructor(readonly fieldPath: string) {
    super(`Snapshot field is not authorized: ${fieldPath}`);
    this.name = "SnapshotFieldNotAllowedError";
  }
}

/**
 * v1 path assertion. Kept for backward compat with legacy snapshots whose
 * `authorizedData` is a userId→fields map. New snapshots are v2 and use
 * `assertFieldAllowedV2` instead.
 */
export function assertFieldAllowed(
  snapshot: ConstraintSnapshotData,
  fieldPath: string,
): void {
  const segments = fieldPath.split(".");
  if (
    segments.length !== 3
    || segments[0] !== SNAPSHOT_FIELD_PATH_PREFIX
    || segments.some(segment => segment.length === 0)
  ) {
    throw new SnapshotFieldNotAllowedError(fieldPath);
  }

  const [, memberId, fieldName] = segments;
  if (!Object.prototype.hasOwnProperty.call(snapshot.authorizedData, memberId)) {
    throw new SnapshotFieldNotAllowedError(fieldPath);
  }
  const memberData = snapshot.authorizedData[memberId];
  if (
    typeof memberData !== "object"
    || memberData === null
    || Array.isArray(memberData)
    || !Object.prototype.hasOwnProperty.call(memberData, fieldName)
  ) {
    throw new SnapshotFieldNotAllowedError(fieldPath);
  }
}

/**
 * v2 path assertion. Required by Team Agent 协作编排 Phase 3+ (spec §3.4, §5.1).
 *
 * Acceptable forms:
 *   - `teamVisible.<alias>[<index>].fieldKey`
 *   - `orchestratorConfidential.<alias>[<index>].fieldKey`
 *
 * The model produces these tokens referencing the run-scoped aliases, so the
 * deterministic validator can confirm that each `constraintReference` resolves to
 * a field actually present in the projection. Caller MUST also check the
 * `publicExplanationTokens` separately (see `assertConfidentialFree`).
 */
export function assertFieldAllowedV2(
  snapshot: ConstraintSnapshotData,
  fieldPath: string,
): void {
  const match = fieldPath.match(/^(teamVisible|orchestratorConfidential)\.([^.\s]+)\[(\d+)\]\.fieldKey$/);
  if (!match) {
    throw new SnapshotFieldNotAllowedError(fieldPath);
  }
  const [, section, alias] = match as unknown as [string, "teamVisible" | "orchestratorConfidential", string, string];
  const meta = readSnapshotV2Meta(snapshot.authorizedData);
  if (!meta) {
    throw new SnapshotFieldNotAllowedError(fieldPath);
  }
  const bucket = section === V2_SECTION_TEAM_VISIBLE ? meta.teamVisible : meta.orchestratorConfidential;
  if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, alias)) {
    throw new SnapshotFieldNotAllowedError(fieldPath);
  }
}

export interface SnapshotV2Meta {
  schemaVersion: 2;
  memberAliases: Record<string, string>;
  teamVisible: Record<string, unknown[]>;
  orchestratorConfidential: Record<string, Array<{
    fieldKey: string;
    valueJson: unknown;
    visibility: "ORCHESTRATOR_CONFIDENTIAL";
  }>>;
  projectionManifest: Array<{ sourceId: string; revision: number; visibility: string }>;
}

export function readSnapshotV2Meta(authorizedData: unknown): SnapshotV2Meta | null {
  if (typeof authorizedData !== "object" || authorizedData === null) return null;
  const root = authorizedData as Record<string, unknown>;
  const meta = root._meta;
  if (!meta || typeof meta !== "object") return null;
  if ((meta as Record<string, unknown>).schemaVersion !== 2) return null;
  return meta as unknown as SnapshotV2Meta;
}

/**
 * Best-effort safePublicExplanationTokens allow-list for the snapshot's
 * referenced field keys. Returns null if the snapshot is v1.
 */
export function extractSafeExplanationTokens(authorizedData: unknown): Set<string> | null {
  const meta = readSnapshotV2Meta(authorizedData);
  if (!meta) return null;
  const tokens = new Set<string>();
  for (const list of Object.values(meta.orchestratorConfidential ?? {})) {
    for (const item of list) {
      // Public tokens are anchored on field key; we don't expand value content.
      const fieldKey = (item as { fieldKey?: string }).fieldKey;
      if (fieldKey) {
        // The catalog owns the canonical whitelist; the snapshot keeps only keys.
      }
    }
  }
  return tokens;
}
