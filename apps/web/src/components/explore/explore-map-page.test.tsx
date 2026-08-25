import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureMapAttribution, ExploreMapPage } from "./explore-map-page";
import { OPEN_FREEMAP_LIBERTY_LAYERS } from "./__fixtures__/openfreemap-liberty-layers";
import { renderWithIntl } from "@/test/render";

function resetDevHook() {
  delete (window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap;
}

function mockGlobeStyleFetch() {
  vi.stubGlobal("fetch", vi.fn((input: string) => Promise.resolve({
    ok: true,
    json: async () => input === "https://tiles.openfreemap.org/planet"
      ? { tiles: ["https://tiles.openfreemap.org/planet/versioned/{z}/{x}/{y}.pbf"] }
      : { version: 8, sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } }, layers: [] },
  })));
}

const mapMock = vi.hoisted(() => {
  const REQUIRED_LAYER_IDS = [
    "boundary_2",
    "boundary_3",
    "label_country_1",
    "label_country_2",
    "label_country_3",
    "label_state",
    "label_city",
    "label_city_capital",
  ];
  return {
    handlers: new Map<string, (event: unknown) => void>(),
    layers: [] as string[],
    redrawCalls: 0,
    layoutChanges: [] as Array<{ id: string; visibility: string }>,
    queryResults: [] as Array<{ properties: Record<string, unknown> }>,
    markerButtons: [] as HTMLButtonElement[],
    removedMarkers: [] as string[],
    easeCalls: [] as Array<{
      padding?: { top: number; right: number; bottom: number; left: number };
      zoom?: number;
    }>,
    geography: {
      source: true,
      layers: new Set<string>([...REQUIRED_LAYER_IDS]),
    },
  };
});

/** Simulate a MapLibre `sourcedata` event being delivered to the registered handler. */
function fireSourcedata(event: { sourceId: string; isSourceLoaded: boolean; sourceDataType?: string }) {
  const handler = mapMock.handlers.get("sourcedata");
  handler?.(event);
}

vi.mock("maplibre-gl", () => {
  class MapMock {
    addControl() {}
    easeTo(options: { padding?: { top: number; right: number; bottom: number; left: number }; zoom?: number }) {
      mapMock.easeCalls.push(options);
    }
    getCenter() { return { lng: 103.8198, lat: 1.3521 }; }
    getZoom() { return 2.25; }
    addLayer(layer: { id: string }) { mapMock.layers.push(layer.id); }
    flyTo() {}
    getLayer(id: string) {
      return mapMock.geography.layers.has(id) ? { id } : undefined;
    }
    getSource(id?: string) {
      if (id === undefined) return mapMock.geography.source ? {} : undefined;
      return id === "openmaptiles" && mapMock.geography.source ? {} : undefined;
    }
    getStyle() {
      return {
        layers: mapMock.geography.source
          ? [{ source: "openmaptiles", "source-layer": "boundary" }, { source: "openmaptiles", "source-layer": "place" }]
          : [],
      };
    }
    queryRenderedFeatures() { return mapMock.queryResults; }
    remove() {}
    redraw() { mapMock.redrawCalls += 1; }
    setPaintProperty() {}
    setLayoutProperty(id: string, _name: string, visibility: string) { mapMock.layoutChanges.push({ id, visibility }); }
    setProjection() {}
    once(event: string, callback: () => void) {
      if (event === "style.load") callback();
    }
    on(event: string, callback: (event: unknown) => void) {
      mapMock.handlers.set(event, callback);
    }
    off(event: string, callback: (event: unknown) => void) {
      const stored = mapMock.handlers.get(event);
      if (stored === callback) mapMock.handlers.delete(event);
    }
  }

  class MarkerMock {
    private label = "marker";
    constructor(options: { element: HTMLElement }) {
      this.label = options.element.textContent ?? "marker";
      const button = options.element.querySelector("button");
      if (button) mapMock.markerButtons.push(button);
    }
    addTo() {
      return this;
    }
    setLngLat() {
      return this;
    }
    remove() {
      mapMock.removedMarkers.push(this.label);
    }
  }

  return {
    AttributionControl: class {},
    Map: MapMock,
    Marker: MarkerMock,
    NavigationControl: class {},
  };
});

afterEach(cleanup);

describe("ExploreMapPage private inspirations", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetDevHook();
  });

  beforeEach(() => {
    mapMock.handlers.clear();
    mapMock.markerButtons.length = 0;
    mapMock.layers.length = 0;
    mapMock.redrawCalls = 0;
    mapMock.layoutChanges.length = 0;
    mapMock.queryResults.length = 0;
    mapMock.geography.source = true;
    mapMock.geography.layers = new Set<string>([
      "boundary_2",
      "boundary_3",
      "label_country_1",
      "label_country_2",
      "label_country_3",
      "label_state",
      "label_city",
      "label_city_capital",
    ]);
    mapMock.removedMarkers.length = 0;
    mapMock.easeCalls.length = 0;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    mockGlobeStyleFetch();
  });

  it("keeps multiple pins and supports individual and batch deletion", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    await waitFor(() => expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined());
    const clickMap = mapMock.handlers.get("click");
    expect(clickMap).toBeDefined();

    act(() => {
      clickMap?.({ lngLat: { lng: -71.584, lat: 4.407 } });
      clickMap?.({ lngLat: { lng: 139.692, lat: 35.69 } });
      clickMap?.({ lngLat: { lng: -9.139, lat: 38.722 } });
    });

    expect(screen.queryByRole("heading", { name: "Explore the world" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Private inspiration list" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Manage pins" }));
    expect(screen.getByRole("button", { name: "Current area" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "All pins (3)" }));
    const list = screen.getByRole("list", { name: "Private inspiration list" });
    expect(within(list).getByText("Pinned place 1")).toBeInTheDocument();
    expect(within(list).getByText("Pinned place 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Pinned place 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Pinned place 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected (2)" }));

    expect(within(list).queryByText("Pinned place 1")).not.toBeInTheDocument();
    expect(within(list).getByText("Pinned place 3")).toBeInTheDocument();
    expect(mapMock.removedMarkers).toHaveLength(2);
  });

  it("opens pin context on the first chat click and the preview on the second", async () => {
    renderWithIntl(<ExploreMapPage />);
    await waitFor(() => expect(mapMock.markerButtons.length).toBeGreaterThanOrEqual(3));

    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    const tokyoMarker = mapMock.markerButtons.find((button) => button.getAttribute("aria-label") === "Explore Tokyo, Japan");
    expect(tokyoMarker).toBeDefined();

    act(() => tokyoMarker?.click());
    expect(screen.getByRole("dialog", { name: "Wanderly Agent conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask about Tokyo · Japan" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tokyo" })).not.toBeInTheDocument();

    act(() => tokyoMarker?.click());
    expect(screen.queryByRole("dialog", { name: "Wanderly Agent conversation" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tokyo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    expect(screen.queryByRole("heading", { name: "Tokyo" })).not.toBeInTheDocument();
  });

  it("moves the globe into the uncovered landscape area without enlarging it", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("orientation: portrait") ? false : true,
    }));
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));

    await waitFor(() => expect(mapMock.easeCalls.length).toBeGreaterThan(0));
    const camera = mapMock.easeCalls.at(-1);
    expect(camera?.padding?.right).toBeGreaterThan(0);
    expect(camera?.padding?.bottom).toBe(0);
    expect(camera?.zoom).toBeLessThanOrEqual(2.25);
  });

  it("selects a city label without creating a private inspiration", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    await waitFor(() => expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined());
    mapMock.queryResults.push({ properties: { class: "city", "name:zh": "东京", "name:en": "Tokyo" } });

    act(() => {
      mapMock.handlers.get("click")?.({ lngLat: { lng: 139.692, lat: 35.69 }, point: { x: 10, y: 10 } });
    });

    expect(screen.getByRole("heading", { name: "东京" })).toBeInTheDocument();
    expect(screen.getByText("Map location")).toBeInTheDocument();
    expect(screen.queryByText("1 private pin on this map")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Countries" })).toHaveAttribute("aria-pressed", "true");
    expect(mapMock.layoutChanges).toContainEqual({ id: "label_city", visibility: "visible" });
  });

  it("keeps the layer panel visible but disabled with a source-missing caption when the style lacks OpenMapTiles", async () => {
    mapMock.geography.source = false;
    mapMock.geography.layers = new Set<string>();
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    await waitFor(() => expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined());

    const group = screen.getByRole("group", { name: "Map detail layers" });
    expect(group).toHaveAttribute("data-readiness", "missing-source");
    expect(within(group).getByRole("button", { name: "Countries" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "States / Provinces" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "Cities" })).toBeDisabled();
    expect(within(group).getByRole("status")).toHaveTextContent(/does not expose the openmaptiles source/);
    expect(mapMock.layoutChanges).toHaveLength(0);
  });

  it("keeps country, regional, and city controls available after opening a destination drawer", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    await waitFor(() => expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /^Tokyo$/ }));

    const countryControl = screen.getByRole("button", { name: "Countries" });
    expect(countryControl).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(countryControl);
    expect(countryControl).toHaveAttribute("aria-pressed", "false");
    expect(mapMock.layoutChanges).toContainEqual({ id: "boundary_2", visibility: "none" });
  });
});

describe("ExploreMapPage readiness diagnostics", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetDevHook();
  });

  beforeEach(() => {
    mapMock.handlers.clear();
    mapMock.layers.length = 0;
    mapMock.redrawCalls = 0;
    mapMock.layoutChanges.length = 0;
    mapMock.queryResults.length = 0;
    mapMock.geography.source = true;
    mapMock.geography.layers = new Set<string>([
      "boundary_2",
      "boundary_3",
      "label_country_1",
      "label_country_2",
      "label_country_3",
      "label_state",
      "label_city",
      "label_city_capital",
    ]);
    mapMock.removedMarkers.length = 0;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    mockGlobeStyleFetch();
  });

  it("shows the layer panel disabled with a missing-layer caption when some layers are absent", async () => {
    mapMock.geography.source = true;
    mapMock.geography.layers = new Set<string>(["boundary_2", "label_country_1"]);
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    await waitFor(() => expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined());

    const group = screen.getByRole("group", { name: "Map detail layers" });
    expect(group).toHaveAttribute("data-readiness", "missing-layers");
    expect(within(group).getByRole("button", { name: "Countries" })).toBeDisabled();
    const status = within(group).getByRole("status");
    expect(status.textContent).toMatch(/missing layers:.*\blabel_state\b/);
    expect(status.textContent).toMatch(/\blabel_city_capital\b/);
  });

  it("exposes window.__wanderlyMap in dev mode with the current readiness snapshot", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: true });
    await waitFor(() => expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined());

    const handle = (window as unknown as {
      __wanderlyMap?: {
        readiness: { kind: string; styleUrl: string };
        missingLayers: readonly string[];
        sourcePresent: boolean;
        styleUrl: string;
        stage: string;
        retry: () => void;
      };
    }).__wanderlyMap;

    expect(handle).toBeDefined();
    expect(handle?.readiness.kind).toBe("ready-supported");
    expect(handle?.missingLayers).toEqual([]);
    expect(handle?.sourcePresent).toBe(true);
    expect(handle?.styleUrl).toBe(OPEN_FREEMAP_LIBERTY_LAYERS.styleUrl);
    expect(handle?.stage).toBe("ready");
    expect(typeof handle?.retry).toBe("function");
  });
});

describe("ExploreMapPage style-load lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetDevHook();
  });

  beforeEach(() => {
    mapMock.handlers.clear();
    mapMock.layers.length = 0;
    mapMock.redrawCalls = 0;
    mapMock.layoutChanges.length = 0;
    mapMock.queryResults.length = 0;
    mapMock.geography.source = true;
    mapMock.geography.layers = new Set<string>([
      "boundary_2",
      "boundary_3",
      "label_country_1",
      "label_country_2",
      "label_country_3",
      "label_state",
      "label_city",
      "label_city_capital",
    ]);
    mapMock.removedMarkers.length = 0;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    mockGlobeStyleFetch();
  });

  it("renders the layer panel as soon as the style loads, before tiles finish", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));

    await waitFor(() => expect(screen.getByRole("group", { name: "Map detail layers" })).toBeInTheDocument());
    expect((window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap).toBeDefined();
  });

  it("records only OpenMapTiles source events without changing readiness", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    await waitFor(() => expect(screen.getByRole("group", { name: "Map detail layers" })).toBeInTheDocument());

    fireSourcedata({ sourceId: "unrelated-source", isSourceLoaded: true });
    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: false });

    const handle = (window as unknown as {
      __wanderlyMap?: { readiness: { kind: string }; sourceEvents: Array<{ isSourceLoaded: boolean | null }> };
    }).__wanderlyMap;
    expect(handle?.readiness.kind).toBe("ready-supported");
    expect(handle?.sourceEvents).toEqual([{ sourceDataType: null, isSourceLoaded: false }]);
  });

  it("redraws when OpenMapTiles metadata arrives", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireSourcedata({ sourceId: "openmaptiles", sourceDataType: "metadata", isSourceLoaded: false });

    expect(mapMock.redrawCalls).toBe(1);
  });

  it("does not treat isSourceLoaded=false as a loading failure", async () => {
    renderWithIntl(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));

    fireSourcedata({ sourceId: "openmaptiles", isSourceLoaded: false });
    await waitFor(() => expect(screen.getByRole("group", { name: "Map detail layers" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /globe could not load/i })).not.toBeInTheDocument();
  });

  it("does not transition to unavailable-network when no sourcedata event arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderWithIntl(<ExploreMapPage />);

      // Drain microtasks (dynamic import resolution) and run any pending 0ms timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Click handler must be wired synchronously after the import resolves.
      expect(mapMock.handlers.get("click")).toBeTypeOf("function");

      // Source data can be slow; it is diagnostics only and cannot fail readiness.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_500);
      });

      expect(screen.queryByRole("heading", { name: /globe could not load/i })).not.toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Map detail layers" })).toBeInTheDocument();
      const handle = (window as unknown as { __wanderlyMap?: { stage: string } }).__wanderlyMap;
      expect(handle?.stage).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("configureMapAttribution", () => {
  it("starts compact attribution closed and toggles it from the info control", () => {
    const root = document.createElement("div");
    const attribution = document.createElement("details");
    const toggle = document.createElement("summary");
    attribution.open = true;
    attribution.className = "maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show";
    toggle.className = "maplibregl-ctrl-attrib-button";
    attribution.append(toggle);
    root.append(attribution);

    configureMapAttribution(root);

    expect(attribution).not.toHaveAttribute("open");
    expect(attribution).not.toHaveClass("maplibregl-compact-show");
    expect(attribution).toHaveClass("maplibregl-compact");
    expect(attribution).toHaveAttribute("data-wanderly-expanded", "false");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    toggle.click();
    expect(attribution).toHaveAttribute("open");
    expect(attribution).toHaveClass("maplibregl-compact-show");
    expect(attribution).toHaveAttribute("data-wanderly-expanded", "true");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    toggle.click();
    expect(attribution).not.toHaveAttribute("open");
    expect(attribution).not.toHaveClass("maplibregl-compact-show");
    expect(attribution).toHaveAttribute("data-wanderly-expanded", "false");
  });
});
