import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configureMapAttribution, ExploreMapPage } from "./explore-map-page";

const mapMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: { lngLat: { lng: number; lat: number } }) => void>(),
  removedMarkers: [] as string[],
}));

vi.mock("maplibre-gl", () => {
  class MapMock {
    addControl() {}
    flyTo() {}
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

describe("ExploreMapPage private inspirations", () => {
  beforeEach(() => {
    mapMock.handlers.clear();
    mapMock.removedMarkers.length = 0;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
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

    expect(screen.getByText("3 private pins on this map")).toBeInTheDocument();
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
