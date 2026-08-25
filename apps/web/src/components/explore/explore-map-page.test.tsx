import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureMapAttribution, ExploreMapPage } from "./explore-map-page";

const mapMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: { lngLat: { lng: number; lat: number } }) => void>(),
  markerButtons: [] as HTMLButtonElement[],
  removedMarkers: [] as string[],
  easeCalls: [] as Array<{ padding?: { top: number; right: number; bottom: number; left: number }; zoom?: number }>,
  mobile: true,
}));

vi.mock("maplibre-gl", () => {
  class MapMock {
    addControl() {}
    easeTo(options: { padding?: { top: number; right: number; bottom: number; left: number }; zoom?: number }) {
      mapMock.easeCalls.push(options);
    }
    flyTo() {}
    getCenter() { return { lng: 103.8198, lat: 1.3521 }; }
    getZoom() { return 2.25; }
    remove() {}
    setProjection() {}
    once(event: string, callback: () => void) {
      if (event === "style.load") callback();
    }
    on(event: string, callback: (event: { lngLat: { lng: number; lat: number } }) => void) {
      mapMock.handlers.set(event, callback);
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
  beforeEach(() => {
    mapMock.handlers.clear();
    mapMock.markerButtons.length = 0;
    mapMock.removedMarkers.length = 0;
    mapMock.easeCalls.length = 0;
    mapMock.mobile = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query.includes("orientation: portrait") ? mapMock.mobile : false }));
  });

  it("keeps multiple pins and supports individual and batch deletion", async () => {
    render(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
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
    render(<ExploreMapPage />);
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

  it("moves the globe into the uncovered desktop area without enlarging it", async () => {
    mapMock.mobile = false;
    render(<ExploreMapPage />);

    await waitFor(() => expect(mapMock.handlers.get("click")).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));

    await waitFor(() => {
      const camera = mapMock.easeCalls.at(-1);
      expect(camera?.padding?.right).toBeGreaterThan(0);
      expect(camera?.padding?.bottom).toBe(0);
      expect(camera?.zoom).toBeLessThanOrEqual(2.25);
    });
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
