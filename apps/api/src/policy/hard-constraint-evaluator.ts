import type { ConstraintSnapshotData, FlightOffer } from "../types/domain.js";

export type HardConstraintViolation = {
  code: "HARD_CONSTRAINT_UNSATISFIED";
  /** Never contains a value, owner id, alias, or confidential field key. */
  publicReason: "HARD_FLIGHT_TIME_CONSTRAINT_UNSATISFIED";
};

function constraints(snapshot: ConstraintSnapshotData): Array<{ fieldKey: string; valueJson: unknown; strength: string }> {
  const root = snapshot.authorizedData as Record<string, unknown>;
  const meta = root._meta as Record<string, unknown> | undefined;
  const groups = meta?.teamVisible as Record<string, unknown[]> | undefined;
  const confidential = meta?.orchestratorConfidential as Record<string, unknown[]> | undefined;
  return [...Object.values(groups ?? {}), ...Object.values(confidential ?? {})]
    .flat()
    .filter((item): item is { fieldKey: string; valueJson: unknown; strength: string } =>
      !!item && typeof item === "object" && typeof (item as { fieldKey?: unknown }).fieldKey === "string"
        && typeof (item as { strength?: unknown }).strength === "string");
}

/** Deterministic final gate. The model can propose offers but cannot waive HARD. */
export function evaluateHardConstraints(params: {
  snapshot: ConstraintSnapshotData;
  flights: FlightOffer[];
}): HardConstraintViolation[] {
  const noRedEye = constraints(params.snapshot).some((item) =>
    item.fieldKey === "no_red_eye"
      && item.strength === "HARD"
      && (item.valueJson as { enabled?: unknown })?.enabled === true,
  );
  if (!noRedEye) return [];

  const hasRedEye = params.flights.some((flight) => flight.segments.some((segment) => {
    const date = new Date(segment.departureAt);
    if (Number.isNaN(date.getTime())) return true;
    // departureAt carries an ISO offset; use that local wall-clock representation.
    const localHour = Number(segment.departureAt.slice(11, 13));
    return !Number.isInteger(localHour) || localHour >= 22 || localHour < 6;
  }));
  return hasRedEye ? [{
    code: "HARD_CONSTRAINT_UNSATISFIED",
    publicReason: "HARD_FLIGHT_TIME_CONSTRAINT_UNSATISFIED",
  }] : [];
}
