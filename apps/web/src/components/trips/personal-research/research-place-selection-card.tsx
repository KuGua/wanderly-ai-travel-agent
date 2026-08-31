import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Personal Research Intent — place-selection card (Phase 4).
 *
 * Renders when a navigation/mobility draft carries `readiness =
 * "NEEDS_PLACE_SELECTION"`. The owner must pick two ACTIVE non-OWNER_PRIVATE
 * trip_places (existing or freshly adopted) AND a transport mode
 * (WALK / DRIVE / CYCLE) before the card enables confirm.
 *
 * SPEC invariants enforced here:
 * - The card NEVER calls `navigation.route` directly. The mode picker
 *   records the owner's selection client-side; the orchestrator picks
 *   the mode up via the existing `requestedCapabilities` payload.
 * - "WALK" is never auto-selected as a default. Spec §9.4 forbids the
 *   model or UI from silently defaulting "airport → city centre" to a
 *   walk.
 * - Ambiguous place names (e.g. "西园町") are never auto-picked — the
 *   server returns a candidate list with provenance and the owner
 *   chooses. Spec §9.4.
 * - The card never includes the original chat question, place names,
 *   or provider raw payloads in any state it stores.
 */
export type RouteMode = "WALK" | "DRIVE" | "CYCLE";

export function ResearchPlaceSelectionCard({
  intent,
  origin,
  destination,
  mode,
  endpoints = [],
  onSelectOrigin,
  onSelectDestination,
  onSelectMode,
  onConfirm,
  onDismiss,
  isSubmitting = false,
}: {
  intent: { kind: "RESEARCH_ONLY" | "PROPOSE_PLAN"; requestedCapabilities: string[] };
  origin: { placeId: string; displayName: string } | null;
  destination: { placeId: string; displayName: string } | null;
  mode: RouteMode | null;
  endpoints?: Array<{ placeId: string; displayName: string }>;
  onSelectOrigin: (place: { placeId: string; displayName: string }) => void;
  onSelectDestination: (place: { placeId: string; displayName: string }) => void;
  onSelectMode: (mode: RouteMode) => void;
  onConfirm: () => void;
  onDismiss: () => void;
  isSubmitting?: boolean;
}): ReactNode {
  const [showModeError, setShowModeError] = useState(false);
  const ready = origin !== null && destination !== null && mode !== null;
  return (
    <div
      data-testid="research-place-selection-card"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="mb-2 font-medium">需要先选择路线端点</p>
      <p className="mb-2 text-xs">
        路线研究需要先确定出发地、目的地以及交通方式。
      </p>
      <div className="mb-3 grid gap-1 text-xs">
        <p className="font-medium">选择出发地</p>
        <div className="flex flex-wrap gap-1">{endpoints.map((place) => <button key={`o-${place.placeId}`} type="button" onClick={() => onSelectOrigin(place)} className="rounded border border-amber-300 px-2 py-1">{place.displayName}</button>)}</div>
        <p className="mt-1 font-medium">选择目的地</p>
        <div className="flex flex-wrap gap-1">{endpoints.map((place) => <button key={`d-${place.placeId}`} type="button" onClick={() => onSelectDestination(place)} className="rounded border border-amber-300 px-2 py-1">{place.displayName}</button>)}</div>
        {endpoints.length < 2 ? <p className="italic text-muted-foreground">请先在地点流程中采纳两个有效地点。</p> : null}
      </div>
      <ul className="mb-3 space-y-1 text-xs">
        <li>出发地：{origin?.displayName ?? <span className="italic text-amber-700">未选择</span>}</li>
        <li>目的地：{destination?.displayName ?? <span className="italic text-amber-700">未选择</span>}</li>
      </ul>
      <div className="mb-3" data-testid="route-mode-picker">
        <p className="mb-1 text-xs font-medium">交通方式</p>
        <div className="flex gap-2">
          {(["WALK", "DRIVE", "CYCLE"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setShowModeError(false);
                onSelectMode(m);
              }}
              className={`min-h-11 rounded-full border px-3 text-xs font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30 ${
                mode === m
                  ? "border-amber-600 bg-amber-600 text-white"
                  : "border-amber-300 text-amber-900"
              }`}
              data-testid={`route-mode-${m}`}
            >
              {m === "WALK" ? "步行" : m === "DRIVE" ? "驾车" : "骑行"}
            </button>
          ))}
        </div>
        {showModeError ? (
          <p role="alert" className="mt-1 text-xs text-red-600">
            请先选择交通方式。
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => {
            if (!ready) {
              setShowModeError(true);
              return;
            }
            onConfirm();
          }}
          className="min-h-11 rounded-full bg-amber-600 px-3 text-xs font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
          data-testid="route-mode-confirm"
        >
          确认运行
        </button>
        <button
          type="button"
          disabled={isSubmitting}
          onClick={onDismiss}
          className="min-h-11 rounded-full border border-amber-300 px-3 text-xs font-bold text-amber-900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
        >
          关闭
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        模式：{intent.kind === "PROPOSE_PLAN" ? "研究 + 自动生成方案" : "仅研究"}
      </p>
    </div>
  );
}
