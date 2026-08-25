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
 * Why the layer panel should render disabled (or `null` if it should be
 * fully interactive). Two failure kinds share the same panel-visible UI
 * but need different caption text.
 */
export function panelDisabledReason(readiness: MapReadiness): null | "missing-source" | "missing-layers" {
  if (readiness.kind === "ready-style-unsupported-source") return "missing-source";
  if (readiness.kind === "ready-style-missing-layers") return "missing-layers";
  return null;
}

/**
 * Structural descriptor for the layer-panel caption. The UI layer is
 * responsible for resolving the descriptor into a localized string via
 * `useTranslations("explore").t("layerPanel.captionMissingSource" | "captionMissingLayers")`.
 * Keeping the function i18n-agnostic means the readiness lifecycle stays
 * unit-testable without a React tree.
 */
export type LayerCaption =
  | null
  | { kind: "missing-source" }
  | { kind: "missing-layers"; layers: readonly string[] };

export function layerCaptionFor(
  reason: null | "missing-source" | "missing-layers",
  missing: readonly string[],
): LayerCaption {
  if (reason === "missing-source") return { kind: "missing-source" };
  if (reason === "missing-layers") return { kind: "missing-layers", layers: missing };
  return null;
}

/**
 * Where the map is in its mount lifecycle, separate from `MapReadiness.kind`.
 *
 * `mounting`          — mapRef created, style JSON not yet parsed.
 * `ready`             — style inspected, geography initialized, UI shows the layer panel.
 * `unavailable`       — terminal failure; UI shows the globe error fallback.
 *
 * Exposed on `window.__wanderlyMap.stage` in dev mode so future debugging can
 * tell at a glance whether the map is stuck mounting instead of having to
 * inspect MapLibre internals.
 */
export type MapStage = "mounting" | "ready" | "unavailable";

export function mapReadinessStage(readiness: MapReadiness, _styleLoaded: boolean): MapStage {
  if (readiness.kind === "loading") return "mounting";
  if (readiness.kind === "unavailable-network") return "unavailable";
  return "ready";
}