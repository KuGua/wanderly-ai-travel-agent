import { render, waitFor } from "@testing-library/react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GeographyLabelOverlay } from "./geography-label-overlay";

const visibility = { countries: true, regions: true, cities: true };

const collection: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { class: "continent", "name:en": "Asia", rank: 1 }, geometry: { type: "Point", coordinates: [10, 10] } },
    { type: "Feature", properties: { class: "continent", "name:en": "Africa", rank: 1 }, geometry: { type: "Point", coordinates: [-12, -6] } },
  ],
};

function fakeMap(center: { lng: number; lat: number }, offset: { x: number; y: number }) {
  const handlers = new Map<string, Set<() => void>>();
  return {
    map: {
      getContainer: () => ({ clientWidth: 400, clientHeight: 300, dataset: {} }),
      getCenter: () => center,
      getZoom: () => 2,
      project: ([longitude, latitude]: [number, number]) => ({ x: longitude * 4 + offset.x + 200, y: latitude * 4 + offset.y + 150 }),
      on: (event: string, handler: () => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      },
      off: (event: string, handler: () => void) => { handlers.get(event)?.delete(handler); },
    } as unknown as MapLibreMap,
    emit: (event: string) => handlers.get(event)?.forEach((handler) => handler()),
    listenerCount: (event: string) => handlers.get(event)?.size ?? 0,
  };
}

function positionOf(container: HTMLElement, name: string) {
  const group = [...container.querySelectorAll("g[data-label-kind]")].find((node) => node.textContent === name);
  const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(group?.getAttribute("transform") ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]), hidden: (group as SVGGElement).style.display === "none" } : null;
}

describe("GeographyLabelOverlay positioning", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tracks the map on its render frame instead of lagging behind move events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => collection }));
    const offset = { x: 0, y: 0 };
    const { map, emit, listenerCount } = fakeMap({ lng: 10, lat: 10 }, offset);

    const view = render(<GeographyLabelOverlay map={map} locale="en" visibility={visibility} />);
    await waitFor(() => expect(positionOf(view.container, "Asia")).not.toBeNull());

    // Positions must come from the render frame, never from a move-driven
    // React state update, which is what made labels slide behind the globe.
    expect(listenerCount("render")).toBe(1);
    expect(listenerCount("move")).toBe(0);

    expect(positionOf(view.container, "Asia")).toMatchObject({ x: 240, y: 190 });

    // Pan the camera and emit one render frame: the label must already be there.
    offset.x = -60;
    offset.y = 25;
    emit("render");
    expect(positionOf(view.container, "Asia")).toMatchObject({ x: 180, y: 215 });
  });

  it("hides a label that leaves the visible hemisphere instead of stranding it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => collection }));
    const center = { lng: 10, lat: 10 };
    const { map, emit } = fakeMap(center, { x: 0, y: 0 });

    const view = render(<GeographyLabelOverlay map={map} locale="en" visibility={visibility} />);
    await waitFor(() => expect(positionOf(view.container, "Asia")).not.toBeNull());
    expect(positionOf(view.container, "Asia")?.hidden).toBe(false);

    // Spin the globe so Asia is on the far side.
    center.lng = -170;
    center.lat = -10;
    emit("render");
    expect(positionOf(view.container, "Asia")?.hidden).toBe(true);
  });
});
