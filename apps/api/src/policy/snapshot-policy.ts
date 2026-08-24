import type { ConstraintSnapshotData } from "../types/domain.js";

export const SNAPSHOT_FIELD_PATH_PREFIX = "authorizedData";

export class SnapshotFieldNotAllowedError extends Error {
  readonly code = "FIELD_NOT_AUTHORIZED";

  constructor(readonly fieldPath: string) {
    super(`Snapshot field is not authorized: ${fieldPath}`);
    this.name = "SnapshotFieldNotAllowedError";
  }
}

/**
 * Assert that a model-declared field reference resolves to a field copied into
 * the immutable snapshot by the consent service. The path format is
 * `authorizedData.<memberId>.<fieldName>`; malformed or absent paths fail closed.
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
