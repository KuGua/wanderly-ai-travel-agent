"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";

import { CHINA_MARITIME_LINE_DATA_URL, COUNTRY_BOUNDARY_LOD_DATA_URLS } from "./map-surface-style";

type Projector = (coordinates: [number, number]) => { x: number; y: number };
type BoundaryLod = keyof typeof COUNTRY_BOUNDARY_LOD_DATA_URLS;
type LongitudeRange = [number, number];
/**
 * Latitude band plus one or two longitude ranges (two when the view straddles
 * the antimeridian) describing what the camera can currently see.
 */
export type ViewportBounds = { south: number; north: number; longitudeRanges: LongitudeRange[] };
type BoundaryLine = { coordinates: number[][]; bbox: [number, number, number, number] };

// Below this zoom the camera already sees a whole hemisphere, so culling by
// viewport would reject nothing and only cost bbox comparisons.
const VIEWPORT_CULLING_MIN_ZOOM = 3;
// Keep a margin of the visible span on every side so strokes just outside the
// frame still enter the path and joins near the edge stay continuous.
const VIEWPORT_CULLING_MARGIN = 0.25;

const boundaryLineCache = new WeakMap<GeoJSON.FeatureCollection, BoundaryLine[]>();

const COUNTRY_BOUNDARY_LODS: ReadonlyArray<{ id: BoundaryLod; minZoom: number }> = [
  { id: "lod0", minZoom: 0 },
  { id: "lod1", minZoom: 3.4 },
  { id: "lod2", minZoom: 5.5 },
];

export function countryBoundaryLodForZoom(zoom: number): BoundaryLod {
  return [...COUNTRY_BOUNDARY_LODS].reverse().find((lod) => zoom >= lod.minZoom)?.id ?? "lod0";
}

export function projectCountryBoundaryPaths(
  collection: GeoJSON.FeatureCollection,
  project: Projector,
  viewportWidth: number,
  isVisible: (coordinates: [number, number]) => boolean = () => true,
  viewportBounds?: ViewportBounds | null,
): string[] {
  return boundaryLines(collection)
    .filter((line) => !viewportBounds || intersectsViewport(line.bbox, viewportBounds))
    .map((line) => pathForLine(line.coordinates, project, viewportWidth, isVisible))
    .filter(isPath);
}

/**
 * Flattens every ring and line of a boundary collection once and remembers the
 * result: redraws run on every map render, and re-walking the geometry tree
 * per frame is the difference between projecting the visible sliver of the
 * mesh and projecting the whole planet.
 */
function boundaryLines(collection: GeoJSON.FeatureCollection): BoundaryLine[] {
  const cached = boundaryLineCache.get(collection);
  if (cached) return cached;
  const lines = collection.features
    .flatMap((feature) => geometryLines(feature.geometry))
    .map((coordinates) => ({ coordinates, bbox: lineBoundingBox(coordinates) }));
  boundaryLineCache.set(collection, lines);
  return lines;
}

function geometryLines(geometry: GeoJSON.Geometry | null): number[][][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "LineString": return [geometry.coordinates];
    case "MultiLineString": return geometry.coordinates;
    case "Polygon": return geometry.coordinates;
    case "MultiPolygon": return geometry.coordinates.flat();
    default: return [];
  }
}

function lineBoundingBox(coordinates: number[][]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of coordinates) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

function intersectsViewport([west, south, east, north]: [number, number, number, number], bounds: ViewportBounds): boolean {
  if (north < bounds.south || south > bounds.north) return false;
  return bounds.longitudeRanges.some(([rangeWest, rangeEast]) => west <= rangeEast && east >= rangeWest);
}

/**
 * Reads the camera's visible extent as a latitude band plus longitude ranges,
 * or null when culling cannot help (zoomed out, or the view wraps the globe).
 */
export function viewportBoundsFrom(
  bounds: { west: number; south: number; east: number; north: number },
  zoom: number,
): ViewportBounds | null {
  if (zoom < VIEWPORT_CULLING_MIN_ZOOM) return null;
  const longitudeSpan = bounds.east - bounds.west;
  if (!Number.isFinite(longitudeSpan) || longitudeSpan >= 360) return null;
  const latitudeMargin = Math.abs(bounds.north - bounds.south) * VIEWPORT_CULLING_MARGIN;
  const longitudeMargin = Math.abs(longitudeSpan <= 0 ? longitudeSpan + 360 : longitudeSpan) * VIEWPORT_CULLING_MARGIN;
  const west = bounds.west - longitudeMargin;
  const east = bounds.east + longitudeMargin;
  if (east - west >= 360) return null;
  return {
    south: bounds.south - latitudeMargin,
    north: bounds.north + latitudeMargin,
    longitudeRanges: splitLongitudeRange(west, east),
  };
}

function splitLongitudeRange(west: number, east: number): LongitudeRange[] {
  const normalizedWest = normalizeLongitude(west);
  const normalizedEast = normalizeLongitude(east);
  // A view straddling the antimeridian becomes two ranges against the
  // [-180, 180] coordinates the mesh is stored in.
  if (normalizedWest > normalizedEast) return [[normalizedWest, 180], [-180, normalizedEast]];
  return [[normalizedWest, normalizedEast]];
}

function isPath(path: string): path is string {
  return path.length > 0;
}

export function isCoordinateOnVisibleHemisphere(coordinates: [number, number], center: [number, number]) {
  const longitudeDelta = degreesToRadians(coordinates[0] - center[0]);
  const latitude = degreesToRadians(coordinates[1]);
  const centerLatitude = degreesToRadians(center[1]);
  return Math.sin(latitude) * Math.sin(centerLatitude)
    + Math.cos(latitude) * Math.cos(centerLatitude) * Math.cos(longitudeDelta) >= 0;
}

function pathForLine(coordinates: number[][], project: Projector, viewportWidth: number, isVisible: (coordinates: [number, number]) => boolean) {
  let previousCoordinate: [number, number] | null = null;
  let previousPoint: { x: number; y: number } | null = null;
  let previousVisible = false;

  return coordinates.reduce<string>((path, coordinate) => {
    const position: [number, number] = [coordinate[0], coordinate[1]];
    const visible = isVisible(position);

    if (!previousCoordinate) {
      previousCoordinate = position;
      previousVisible = visible;
      if (!visible) return path;
      previousPoint = project(position);
      return path + "M" + formatPoint(previousPoint) + " ";
    }
    if (previousVisible && !visible) {
      const horizonPoint = project(findVisibilityIntersection(previousCoordinate, position, isVisible));
      path = appendProjectedPoint(path, horizonPoint, previousPoint, viewportWidth, "L");
      previousPoint = null;
    } else if (!previousVisible && visible) {
      const horizonPoint = project(findVisibilityIntersection(previousCoordinate, position, isVisible));
      path = path + "M" + formatPoint(horizonPoint) + " ";
      const point = project(position);
      path = appendProjectedPoint(path, point, horizonPoint, viewportWidth, "L");
      previousPoint = point;
    } else if (visible) {
      const point = project(position);
      path = appendProjectedPoint(path, point, previousPoint, viewportWidth, "L");
      previousPoint = point;
    } else {
      previousPoint = null;
    }
    previousCoordinate = position;
    previousVisible = visible;
    return path;
  }, "");
}

function appendProjectedPoint(path: string, point: { x: number; y: number }, previous: { x: number; y: number } | null, viewportWidth: number, preferredCommand: "L" | "M") {
  const wrapsAcrossGlobe = previous && Math.abs(point.x - previous.x) > viewportWidth * 0.45;
  const command = path === "" || !previous || wrapsAcrossGlobe ? "M" : preferredCommand;
  return path + command + formatPoint(point) + " ";
}

function formatPoint(point: { x: number; y: number }) {
  return point.x.toFixed(2) + " " + point.y.toFixed(2);
}

function findVisibilityIntersection(start: [number, number], end: [number, number], isVisible: (coordinates: [number, number]) => boolean) {
  const startVisible = isVisible(start);
  let visiblePoint = startVisible ? start : end;
  let hiddenPoint = startVisible ? end : start;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const midpoint = interpolateCoordinate(visiblePoint, hiddenPoint, 0.5);
    if (isVisible(midpoint)) visiblePoint = midpoint;
    else hiddenPoint = midpoint;
  }
  return interpolateCoordinate(visiblePoint, hiddenPoint, 0.5);
}

function interpolateCoordinate(start: [number, number], end: [number, number], progress: number): [number, number] {
  const rawLongitudeDelta = end[0] - start[0];
  const normalizedDelta = normalizeLongitude(rawLongitudeDelta);
  const longitudeDelta = normalizedDelta === -180 && rawLongitudeDelta > 0 ? 180 : normalizedDelta;
  return [normalizeLongitude(start[0] + longitudeDelta * progress), start[1] + (end[1] - start[1]) * progress];
}

function normalizeLongitude(longitude: number) {
  return ((longitude + 540) % 360) - 180;
}

function degreesToRadians(value: number) {
  return value * Math.PI / 180;
}

export function CountryBoundaryOverlay({ map, visible }: { map: MapLibreMap | null; visible: boolean }) {
  const [lods, setLods] = useState<Partial<Record<BoundaryLod, GeoJSON.FeatureCollection>>>({});
  const [maritimeLine, setMaritimeLine] = useState<GeoJSON.FeatureCollection | null>(null);
  const [zoom, setZoom] = useState(0);
  const requestedLods = useRef(new Set<BoundaryLod>());
  const svgRef = useRef<SVGSVGElement>(null);
  const globalPathRef = useRef<SVGPathElement>(null);
  const maritimePathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    let active = true;
    requestedLods.current.add("lod0");
    void Promise.all([fetchBoundaryCollection(COUNTRY_BOUNDARY_LOD_DATA_URLS.lod0), fetchBoundaryCollection(CHINA_MARITIME_LINE_DATA_URL)])
      .then(([lod0, maritime]) => {
        if (!active) return;
        setLods({ lod0 });
        setMaritimeLine(maritime);
      })
      .catch(() => {
        if (!active) return;
        setLods({});
        setMaritimeLine(null);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!map) return;
    let active = true;
    const loadLodForCurrentZoom = () => {
      const currentZoom = map.getZoom();
      setZoom(currentZoom);
      const lod = countryBoundaryLodForZoom(currentZoom);
      if (requestedLods.current.has(lod)) return;
      requestedLods.current.add(lod);
      void fetchBoundaryCollection(COUNTRY_BOUNDARY_LOD_DATA_URLS[lod]).then((collection) => {
        if (active) setLods((current) => ({ ...current, [lod]: collection }));
      }).catch(() => requestedLods.current.delete(lod));
    };
    loadLodForCurrentZoom();
    map.on("zoomend", loadLodForCurrentZoom);
    return () => {
      active = false;
      map.off("zoomend", loadLodForCurrentZoom);
    };
  }, [map]);

  const currentBoundary = useMemo(() => {
    if (!map) return null;
    const desired = countryBoundaryLodForZoom(zoom);
    return lods[desired] ?? lods.lod1 ?? lods.lod0 ?? null;
  }, [lods, map, zoom]);

  useEffect(() => {
    if (!map || !currentBoundary || !visible) return;
    const redraw = () => {
      const container = map.getContainer();
      const center = map.getCenter();
      const viewportBounds = visibleViewportBounds(map);
      const project = (collection: GeoJSON.FeatureCollection) => projectCountryBoundaryPaths(
        collection,
        (coordinates) => map.project(coordinates),
        container.clientWidth,
        (coordinates) => isCoordinateOnVisibleHemisphere(coordinates, [center.lng, center.lat]),
        viewportBounds,
      ).join("");
      svgRef.current?.setAttribute("viewBox", "0 0 " + container.clientWidth + " " + container.clientHeight);
      globalPathRef.current?.setAttribute("d", project(currentBoundary));
      maritimePathRef.current?.setAttribute("d", maritimeLine ? project(maritimeLine) : "");
    };
    redraw();
    map.on("render", redraw);
    map.on("resize", redraw);
    return () => {
      map.off("render", redraw);
      map.off("resize", redraw);
    };
  }, [currentBoundary, map, maritimeLine, visible]);

  if (!map || !currentBoundary || !visible) return null;
  return (
    <svg ref={svgRef} data-wanderly-country-boundaries="true" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-hidden" viewBox={"0 0 " + map.getContainer().clientWidth + " " + map.getContainer().clientHeight}>
      <g data-boundary-source="natural-earth-shared-mesh">
        <path ref={globalPathRef} fill="none" stroke="#073d50" strokeOpacity="0.92" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </g>
      <g data-boundary-source="china-maritime-line">
        <path ref={maritimePathRef} fill="none" stroke="#073d50" strokeOpacity="1" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

function visibleViewportBounds(map: MapLibreMap): ViewportBounds | null {
  try {
    const bounds = map.getBounds();
    return viewportBoundsFrom(
      { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() },
      map.getZoom(),
    );
  } catch {
    // A style or projection that cannot report bounds must still draw borders.
    return null;
  }
}

async function fetchBoundaryCollection(url: string) {  const response = await fetch(url);
  if (!response.ok) throw new Error("Country boundary data request failed (" + response.status + ")");
  const collection = await response.json() as GeoJSON.FeatureCollection;
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("Country boundary data is not a GeoJSON FeatureCollection");
  }
  return collection;
}
