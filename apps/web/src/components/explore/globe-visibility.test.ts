import { describe, expect, it } from "vitest";

import { destinationAtAngularDistance, globeClipFrom, screenRectIsInsideGlobe } from "./globe-visibility";

describe("globe overlay visibility", () => {
  it("builds a closed screen-space horizon polygon", () => {
    const clip = globeClipFrom({
      getCenter: () => ({ lng: 0, lat: 0 }),
      project: ([longitude, latitude]) => ({ x: longitude + 200, y: latitude + 150 }),
    }, 8);

    expect(clip?.points).toHaveLength(8);
    expect(clip?.path).toMatch(/^M.* Z$/);
    expect(destinationAtAngularDistance([0, 0], 90, 90)[0]).toBeCloseTo(90, 6);
  });

  it("rejects a label box that reaches beyond the globe silhouette", () => {
    const clip = { path: "", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };

    expect(screenRectIsInsideGlobe({ left: 10, right: 90, top: 10, bottom: 90 }, clip)).toBe(true);
    expect(screenRectIsInsideGlobe({ left: 80, right: 110, top: 10, bottom: 30 }, clip)).toBe(false);
  });
});
