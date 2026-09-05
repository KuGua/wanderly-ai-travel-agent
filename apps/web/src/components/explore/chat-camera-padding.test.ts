import { describe, expect, it } from "vitest";

import { chatCameraPadding, insetPadding, visibleMapWidth } from "./chat-camera-padding";
import type { CameraPadding, Rect } from "./chat-camera-padding";

const MAP: Rect = { left: 0, right: 2000, top: 0, bottom: 1146 };
/** The floating rail: 14px in from the window edge, 64px wide. */
const RAIL: Rect = { left: 14, right: 78, top: 18, bottom: 1000 };
/** The chat panel: 560px wide, 40px in from the right edge. */
const PANEL: Rect = { left: 1400, right: 1960, top: 112, bottom: 900 };

/**
 * Where MapLibre puts the projected centre for a given padding — the padded
 * box's midpoint. This is the whole point of the padding, so the assertions
 * below are written against it rather than against the padding numbers.
 */
function axisOf(map: Rect, padding: CameraPadding): number {
  return map.left + (padding.left + (map.right - map.left - padding.right)) / 2;
}

describe("chatCameraPadding", () => {
  it("centres the globe between the rail and the chat panel", () => {
    const padding = chatCameraPadding({ map: MAP, panel: PANEL, rail: RAIL, orientation: "landscape" });

    expect(axisOf(MAP, padding)).toBe((RAIL.right + PANEL.left) / 2);
  });

  it("measures the panel's real edge rather than padding its width by a constant", () => {
    // The panel sits 40px in from the window edge here and 4px in below. A
    // rule that added a fixed gap to the panel's width would land the axis in
    // the same place for both, which is how the globe drifted under the panel
    // on the breakpoints the constant was not written for.
    const snug: Rect = { ...PANEL, left: 1436, right: 1996 };

    const wide = chatCameraPadding({ map: MAP, panel: PANEL, rail: RAIL, orientation: "landscape" });
    const tight = chatCameraPadding({ map: MAP, panel: snug, rail: RAIL, orientation: "landscape" });

    expect(axisOf(MAP, wide)).toBe((RAIL.right + PANEL.left) / 2);
    expect(axisOf(MAP, tight)).toBe((RAIL.right + snug.left) / 2);
    expect(tight.right).toBeLessThan(wide.right);
  });

  it("still clears a panel it has not been able to measure yet", () => {
    const padding = chatCameraPadding({ map: MAP, panel: null, rail: RAIL, orientation: "landscape" });

    expect(padding.right).toBe(800);
    expect(axisOf(MAP, padding)).toBeLessThan(MAP.right / 2);
  });

  it("ignores a rail that is a layout column rather than an overlay", () => {
    const column: Rect = { left: 0, right: 640, top: 0, bottom: 1146 };

    const padding = chatCameraPadding({ map: MAP, panel: PANEL, rail: column, orientation: "landscape" });

    expect(padding.left).toBe(0);
  });

  it("ignores a rail the map already starts to the right of", () => {
    const beside: Rect = { left: 900, right: 980, top: 0, bottom: 1146 };

    const padding = chatCameraPadding({ map: MAP, panel: PANEL, rail: beside, orientation: "landscape" });

    expect(padding.left).toBe(0);
  });

  it("keeps a strip of map visible when the panel takes nearly the whole width", () => {
    const huge: Rect = { ...PANEL, left: 40, right: 1990 };

    const padding = chatCameraPadding({ map: MAP, panel: huge, rail: RAIL, orientation: "landscape" });

    expect(visibleMapWidth(MAP.right - MAP.left, padding)).toBeGreaterThanOrEqual(120);
    // The rail's share is given up first: the panel is the reason for the
    // shift, so it is the last claim to be cut.
    expect(padding.left).toBe(0);
  });

  it("gives the portrait panel height instead of width", () => {
    const sheet: Rect = { left: 0, right: 720, top: 700, bottom: 1200 };
    const phone: Rect = { left: 0, right: 720, top: 0, bottom: 1280 };

    const padding = chatCameraPadding({ map: phone, panel: sheet, rail: RAIL, orientation: "portrait" });

    expect(padding.bottom).toBe(phone.bottom - sheet.top);
    expect(padding.right).toBe(0);
    expect(padding.left).toBe(0);
  });
});

describe("insetPadding", () => {
  it("adds breathing room to the panel's claim instead of replacing it", () => {
    // `fitBounds` fits the bounds inside the padding it is given, so a flat
    // inset frames the pinned cities into the whole window and leaves the
    // ones on the panel's side behind it.
    const padding = chatCameraPadding({ map: MAP, panel: PANEL, rail: RAIL, orientation: "landscape" });

    const framing = insetPadding(padding, 80);

    expect(framing.right).toBe(padding.right + 80);
    expect(framing.left).toBe(padding.left + 80);
    expect(framing.top).toBe(80);
    expect(axisOf(MAP, framing)).toBe(axisOf(MAP, padding));
  });
});
