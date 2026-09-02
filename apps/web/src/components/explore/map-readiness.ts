/**
 * Map readiness lifecycle, expressed as a discriminated union.
 *
 * Replaces the prior trio of booleans (mapReady, mapUnavailable,
 * geographyAvailable) with one explicit state so UI code can switch on
 * `kind` and any new failure mode shows up in the type system before it
 * ships.
 *
 * `mapAttempt` lives outside this union because it drives effect re-entry
 * (retryMap bumps it), not the user-facing lifecycle.
 */

export type MapReadiness =
  | { kind: "loading" }
  | { kind: "ready-supported"; styleUrl: string }
  | { kind: "ready-style-unsupported-source"; styleUrl: string; sourceId: string }
  | { kind: "ready-style-missing-layers"; styleUrl: string; sourceId: string; missingLayers: readonly string[] }
  | { kind: "unavailable-network"; reason: "timeout" | "error" | "exception"; styleUrl: string };

export const INITIAL_READINESS: MapReadiness = { kind: "loading" };

/**
 * Where the map is in its mount lifecycle, separate from `MapReadiness.kind`.
 *
 * `mounting`          — mapRef created, style JSON not yet parsed.
 * `ready`             — style inspected and geography initialized.
 * `unavailable`       — terminal failure; UI shows the globe error fallback.
 *
 * Exposed on `window.__wanderlyMap.stage` in dev mode so future debugging can
 * tell at a glance whether the map is stuck mounting instead of having to
 * inspect MapLibre internals.
 */
export type MapStage = "mounting" | "ready" | "unavailable";

export function mapReadinessStage(readiness: MapReadiness, styleLoaded: boolean): MapStage {
  void styleLoaded;
  if (readiness.kind === "loading") return "mounting";
  if (readiness.kind === "unavailable-network") return "unavailable";
  return "ready";
}
