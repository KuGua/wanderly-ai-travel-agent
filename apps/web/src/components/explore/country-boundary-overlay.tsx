"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { CHINA_COUNTRY_BOUNDARY_DATA_URL, GLOBAL_COUNTRY_BOUNDARY_DATA_URL } from "./map-surface-style";

type Projector = (coordinates: [number, number]) => { x: number; y: number };
type BoundaryData = {
  global: GeoJSON.FeatureCollection;
  china: GeoJSON.FeatureCollection | null;
};

const CHINA_NATURAL_EARTH_CODES = new Set(["CHN", "TWN"]);

export function globalBoundariesWithoutChina(collection: GeoJSON.FeatureCollection) {
  return {
    ...collection,
    features: collection.features.filter((feature) => {
      const code = feature.properties?.ADM0_A3;
      return typeof code !== "string" || !CHINA_NATURAL_EARTH_CODES.has(code);
    }),
  } satisfies GeoJSON.FeatureCollection;
}

export function projectCountryBoundaryPaths(
  collection: GeoJSON.FeatureCollection,
  project: Projector,
  viewportWidth: number,
  isVisible: (coordinates: [number, number]) => boolean = () => true,
): string[] {
  return collection.features.flatMap((feature) => {
    if (!feature.geometry) return [];
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [];
    return polygons.map((polygon) => pathForPolygon(polygon, project, viewportWidth, isVisible)).filter((path): path is string => Boolean(path));
  });
}

export function isCoordinateOnVisibleHemisphere(coordinates: [number, number], center: [number, number]) {
  const longitudeDelta = degreesToRadians(coordinates[0] - center[0]);
  const latitude = degreesToRadians(coordinates[1]);
  const centerLatitude = degreesToRadians(center[1]);
  return Math.sin(latitude) * Math.sin(centerLatitude)
    + Math.cos(latitude) * Math.cos(centerLatitude) * Math.cos(longitudeDelta) >= 0;
}

function pathForPolygon(
  coordinates: number[][][],
  project: Projector,
  viewportWidth: number,
  isVisible: (coordinates: [number, number]) => boolean,
) {
  return coordinates.map((ring) => {
    let previousCoordinate: [number, number] | null = null;
    let previousPoint: { x: number; y: number } | null = null;
    let previousVisible = false;

    return ring.reduce<string>((path, coordinate) => {
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
  }).join("");
}

function appendProjectedPoint(
  path: string,
  point: { x: number; y: number },
  previous: { x: number; y: number } | null,
  viewportWidth: number,
  preferredCommand: "L" | "M",
) {
  const wrapsAcrossGlobe = previous && Math.abs(point.x - previous.x) > viewportWidth * 0.45;
  const command = path === "" || !previous || wrapsAcrossGlobe ? "M" : preferredCommand;
  return path + command + formatPoint(point) + " ";
}

function formatPoint(point: { x: number; y: number }) {
  return point.x.toFixed(2) + " " + point.y.toFixed(2);
}

function findVisibilityIntersection(
  start: [number, number],
  end: [number, number],
  isVisible: (coordinates: [number, number]) => boolean,
) {
  const startVisible = isVisible(start);
  let visiblePoint = startVisible ? start : end;
  let hiddenPoint = startVisible ? end : start;

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const midpoint = interpolateCoordinate(visiblePoint, hiddenPoint, 0.5);
    if (isVisible(midpoint)) {
      visiblePoint = midpoint;
    } else {
      hiddenPoint = midpoint;
    }
  }

  return interpolateCoordinate(visiblePoint, hiddenPoint, 0.5);
}

function interpolateCoordinate(start: [number, number], end: [number, number], progress: number): [number, number] {
  const rawLongitudeDelta = end[0] - start[0];
  const normalizedDelta = normalizeLongitude(rawLongitudeDelta);
  const longitudeDelta = normalizedDelta === -180 && rawLongitudeDelta > 0 ? 180 : normalizedDelta;
  return [
    normalizeLongitude(start[0] + longitudeDelta * progress),
    start[1] + (end[1] - start[1]) * progress,
  ];
}

function normalizeLongitude(longitude: number) {
  return ((longitude + 540) % 360) - 180;
}

function degreesToRadians(value: number) {
  return value * Math.PI / 180;
}

export function CountryBoundaryOverlay({ map, visible }: { map: MapLibreMap | null; visible: boolean }) {
  const [data, setData] = useState<BoundaryData | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const globalPathRef = useRef<SVGPathElement>(null);
  const chinaPathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetchBoundaryCollection(GLOBAL_COUNTRY_BOUNDARY_DATA_URL),
      fetchBoundaryCollection(CHINA_COUNTRY_BOUNDARY_DATA_URL).catch(() => null),
    ]).then(([global, china]) => {
      if (active) setData({ global, china });
    })
      .catch(() => {
        if (active) setData(null);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!map || !data || !visible) return;

    const redraw = () => {
      const container = map.getContainer();
      const center = map.getCenter();
      const project = (collection: GeoJSON.FeatureCollection) => projectCountryBoundaryPaths(
        collection,
        (coordinates) => map.project(coordinates),
        container.clientWidth,
        (coordinates) => isCoordinateOnVisibleHemisphere(coordinates, [center.lng, center.lat]),
      ).join("");

      svgRef.current?.setAttribute("viewBox", "0 0 " + container.clientWidth + " " + container.clientHeight);
      globalPathRef.current?.setAttribute("d", project(data.china ? globalBoundariesWithoutChina(data.global) : data.global));
      chinaPathRef.current?.setAttribute("d", data.china ? project(data.china) : "");
    };

    redraw();
    // The render event runs after MapLibre updates its camera matrices but
    // before browser paint, keeping this SVG on the WebGL globe's visual frame.
    map.on("render", redraw);
    map.on("resize", redraw);
    return () => {
      map.off("render", redraw);
      map.off("resize", redraw);
    };
  }, [data, map, visible]);

  if (!map || !data || !visible) return null;
  return (
    <svg ref={svgRef} data-wanderly-country-boundaries="true" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-hidden" viewBox={"0 0 " + map.getContainer().clientWidth + " " + map.getContainer().clientHeight}>
      <g data-boundary-source="natural-earth">
        <path ref={globalPathRef} fill="none" stroke="#073d50" strokeOpacity="0.92" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </g>
      <g data-boundary-source="datav-china">
        <path ref={chinaPathRef} fill="none" stroke="#073d50" strokeOpacity="1" strokeWidth="1.9" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

async function fetchBoundaryCollection(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Country boundary data request failed (" + response.status + ")");
  const collection = await response.json() as GeoJSON.FeatureCollection;
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("Country boundary data is not a GeoJSON FeatureCollection");
  }
  return collection;
}
