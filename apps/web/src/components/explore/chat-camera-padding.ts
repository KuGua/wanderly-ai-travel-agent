/**
 * Where the globe should sit while the chat panel is open.
 *
 * The panel and the navigation rail both float *over* the map canvas, which
 * spans the whole window — so the globe's natural centre is the centre of the
 * window, not the centre of the strip the reader can actually see it in. The
 * fix is MapLibre camera padding: padding on a side pulls the projected centre
 * away from it, so the axis lands midway between the rail and the panel.
 *
 * Both edges are measured from the live rects rather than named in constants.
 * The previous version added a fixed 24px to the panel's width, which was the
 * gap on one breakpoint and wrong on the rest, and it found the panel by an
 * English `aria-label` that no localised build ever matches.
 */

export type Rect = { left: number; right: number; top: number; bottom: number };

export type CameraPadding = { top: number; right: number; bottom: number; left: number };

/**
 * Map that must stay visible beside the panel. Below this the globe is a sliver
 * and the reader loses the thing they are talking about, so the panel's claim
 * on the width is given up before this is crossed.
 */
const MIN_VISIBLE_WIDTH = 120;

/**
 * A rail wider than this is not an overlay — it is a layout column the map
 * already sits beside, and padding for it would shift the globe twice.
 */
const MAX_RAIL_FRACTION = 0.25;

/** Panel width to assume when the panel has not been measured yet. */
const UNMEASURED_PANEL_FRACTION = 0.4;

export function chatCameraPadding({
  map,
  panel,
  rail,
  orientation,
}: {
  map: Rect;
  /** The chat panel, or null before it has laid out. */
  panel: Rect | null;
  /** The floating navigation rail, or null when it is not an overlay. */
  rail: Rect | null;
  orientation: "portrait" | "landscape";
}): CameraPadding {
  const width = Math.max(0, map.right - map.left);
  const height = Math.max(0, map.bottom - map.top);
  const none: CameraPadding = { top: 0, right: 0, bottom: 0, left: 0 };

  if (orientation === "portrait") {
    // The panel is docked to the bottom edge here, so it takes height, not
    // width, and the rail is a top bar the globe is already below.
    const bottom = panel ? map.bottom - panel.top : height * 0.6;
    return { ...none, bottom: clamp(Math.round(bottom), 0, Math.max(0, height - MIN_VISIBLE_WIDTH)) };
  }

  const right = panel
    ? Math.round(map.right - panel.left)
    : Math.round(width * UNMEASURED_PANEL_FRACTION);
  const left = railOverlayWidth(map, rail, width);

  // The panel is the reason for the shift, so when the two together would
  // leave nothing to look at, the rail's share goes first and the panel's is
  // capped second.
  const cappedRight = clamp(right, 0, Math.max(0, width - MIN_VISIBLE_WIDTH));
  const cappedLeft = clamp(left, 0, Math.max(0, width - cappedRight - MIN_VISIBLE_WIDTH));
  return { ...none, right: cappedRight, left: cappedLeft };
}

function railOverlayWidth(map: Rect, rail: Rect | null, width: number): number {
  if (!rail || width <= 0) return 0;
  const overlay = Math.round(rail.right - map.left);
  if (overlay <= 0) return 0;
  // A rail that starts past the map's own left edge is beside the map, not on
  // top of it; a very wide one is a column rather than an overlay.
  if (rail.left > map.left + 1 && rail.left - map.left > width * MAX_RAIL_FRACTION) return 0;
  return overlay > width * MAX_RAIL_FRACTION ? 0 : overlay;
}

/**
 * Grows a padding box by an even inset on every side.
 *
 * `fitBounds` and `cameraForBounds` take a padding of their own, and passing a
 * bare number there *replaces* the camera's padding instead of adding to it —
 * which is how a reply naming several cities used to slide the globe back under
 * the panel it had just been moved out from.
 */
export function insetPadding(padding: CameraPadding, inset: number): CameraPadding {
  return {
    top: padding.top + inset,
    right: padding.right + inset,
    bottom: padding.bottom + inset,
    left: padding.left + inset,
  };
}

/** Width left for the globe once the padding is taken out. */
export function visibleMapWidth(mapWidth: number, padding: CameraPadding): number {
  return Math.max(MIN_VISIBLE_WIDTH, mapWidth - padding.left - padding.right);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
