"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isCoordinateOnVisibleHemisphere } from "./country-boundary-overlay";
import { globeClipFrom, screenRectIsInsideGlobe } from "./globe-visibility";
import type { GeographyVisibility } from "./map-geography-layers";
import { CITY_SELECTION_MIN_ZOOM, REGION_SELECTION_MIN_ZOOM } from "./pin-selection";

type LabelKind = "continent" | "country" | "capital" | "city" | "region";

export type GeographyLabel = {
  key: string;
  name: string;
  coordinates: [number, number];
  kind: LabelKind;
  rank: number;
};

type PlaceFeature = GeoJSON.Feature<GeoJSON.Point>;

export const GEOGRAPHY_LABEL_DATA_URL = "/map-data/geography-labels.geojson";
const LABEL_HORIZON_INSET = 0.08;

export function geographyLabelsFromFeatures(
  features: PlaceFeature[],
  zoom: number,
  locale: string,
  visibility: GeographyVisibility,
): GeographyLabel[] {
  const labels = new Map<string, GeographyLabel>();
  for (const feature of features) {
    if (feature.geometry.type !== "Point") continue;
    const properties = feature.properties as Record<string, unknown> | null;
    if (!properties) continue;
    const coordinates = feature.geometry.coordinates;
    if (coordinates.length < 2) continue;
    const name = localizedName(properties, locale);
    const className = typeof properties.class === "string" ? properties.class : "";
    const rank = numericProperty(properties.rank, 99);
    const isNationalCapital = numericProperty(properties.capital, 0) === 2;
    const kind = labelKind(className, isNationalCapital, rank, zoom, visibility);
    if (!name || !kind) continue;
    const position: [number, number] = [coordinates[0], coordinates[1]];
    const key = `${kind}:${name}:${position[0].toFixed(4)}:${position[1].toFixed(4)}`;
    labels.set(key, { key, name, coordinates: position, kind, rank });
  }
  return [...labels.values()].sort((left, right) => labelPriority(left, zoom) - labelPriority(right, zoom));
}

export function GeographyLabelOverlay({
  map,
  locale,
  visibility,
}: {
  map: MapLibreMap | null;
  locale: string;
  visibility: GeographyVisibility;
}) {
  const [features, setFeatures] = useState<PlaceFeature[]>([]);
  // Which labels exist is React state; where they sit is written straight to the
  // DOM. Routing positions through state made them lag the WebGL globe by a
  // frame, so they visibly slid behind the terrain while the map was moving.
  const [candidates, setCandidates] = useState<GeographyLabel[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const globeClipPathRef = useRef<SVGPathElement>(null);
  const labelGroupRef = useRef<SVGGElement>(null);
  const nodesRef = useRef(new Map<string, LabelNode>());
  const membershipRef = useRef("");
  const candidateCacheRef = useRef<{ key: string; labels: GeographyLabel[] } | null>(null);

  useEffect(() => {
    let active = true;
    void fetch(GEOGRAPHY_LABEL_DATA_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Geography label data request failed (${response.status})`);
        return response.json() as Promise<GeoJSON.FeatureCollection<GeoJSON.Point>>;
      })
      .then((collection) => {
        if (active && collection.type === "FeatureCollection" && Array.isArray(collection.features)) setFeatures(collection.features);
      })
      .catch(() => {
        if (active) setFeatures([]);
      });
    return () => { active = false; };
  }, []);

  const draw = useCallback(() => {
    if (!map || features.length === 0) return;
    try {
      const container = map.getContainer();
      const center = map.getCenter();
      const zoom = map.getZoom();
      const globeClip = globeClipFrom(map);
      globeClipPathRef.current?.setAttribute("d", globeClip?.path ?? "");
      if (labelGroupRef.current) labelGroupRef.current.style.display = globeClip ? "" : "none";
      if (!globeClip) {
        for (const node of nodesRef.current.values()) node.group.style.display = "none";
        return;
      }

      // The candidate set depends on zoom, locale and layer visibility but not
      // on the centre, so panning reuses it instead of rebuilding every frame.
      const cacheKey = `${zoom.toFixed(2)}|${locale}|${visibility.countries}|${visibility.regions}|${visibility.cities}`;
      let nextCandidates = candidateCacheRef.current?.key === cacheKey ? candidateCacheRef.current.labels : null;
      if (!nextCandidates) {
        nextCandidates = geographyLabelsFromFeatures(features, zoom, locale, visibility);
        candidateCacheRef.current = { key: cacheKey, labels: nextCandidates };
      }
      if (process.env.NODE_ENV !== "production") container.dataset.wanderlyLabelStatus = `features:${features.length};candidates:${nextCandidates.length}`;

      const membership = nextCandidates.map((candidate) => candidate.key).join("|");
      if (membership !== membershipRef.current) {
        membershipRef.current = membership;
        setCandidates(nextCandidates);
      }

      svgRef.current?.setAttribute("viewBox", `0 0 ${container.clientWidth || 1} ${container.clientHeight || 1}`);

      const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      const placed = new Set<string>();
      for (const candidate of nextCandidates) {
        // A node is missing only between a membership change and React's commit;
        // the layout effect repositions the whole set right after that commit.
        const node = nodesRef.current.get(candidate.key);
        if (!node) continue;

        const fontSize = labelFontSize(candidate.kind, zoom);
        let visible = isCoordinateOnVisibleHemisphere(candidate.coordinates, [center.lng, center.lat], LABEL_HORIZON_INSET);
        let point = { x: 0, y: 0 };
        if (visible) {
          point = map.project(candidate.coordinates);
          const width = Math.max(fontSize * 2, [...candidate.name].length * fontSize * 0.62);
          const bounds = {
            left: point.x - width / 2 - 5,
            right: point.x + width / 2 + 5,
            top: point.y - fontSize * 0.75 - 4,
            bottom: point.y + fontSize * 0.55 + 4,
          };
          if (bounds.right < 0 || bounds.left > container.clientWidth || bounds.bottom < 0 || bounds.top > container.clientHeight) visible = false;
          else if (!screenRectIsInsideGlobe(bounds, globeClip)) visible = false;
          else if (occupied.some((existing) => intersects(existing, bounds))) visible = false;
          else occupied.push(bounds);
        }

        if (!visible) {
          node.group.style.display = "none";
          continue;
        }
        node.group.style.display = "";
        node.group.style.fontSize = `${fontSize}px`;
        node.group.setAttribute("transform", `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
        if (node.dot) {
          node.dot.setAttribute("cx", (-fontSize * 0.45).toFixed(2));
          node.dot.setAttribute("cy", (-fontSize * 0.3).toFixed(2));
        }
        placed.add(candidate.key);
      }

      // Zooming churns the candidate set faster than React unmounts nodes. A
      // node dropped from the set still holds its last transform, so hide it now
      // rather than letting it sit at a stale position until the next commit.
      for (const [key, node] of nodesRef.current) {
        if (!placed.has(key)) node.group.style.display = "none";
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        map.getContainer().dataset.wanderlyLabelStatus = error instanceof Error ? `error:${error.message}` : "error:unknown";
      }
      for (const node of nodesRef.current.values()) node.group.style.display = "none";
    }
  }, [features, locale, map, visibility]);

  useEffect(() => {
    if (!map || features.length === 0) return;
    draw();
    // `render` fires after MapLibre updates its camera matrices and before the
    // browser paints, so labels land on the same visual frame as the globe.
    map.on("render", draw);
    map.on("resize", draw);
    return () => {
      map.off("render", draw);
      map.off("resize", draw);
    };
  }, [draw, features.length, map]);

  // Place newly mounted labels before paint; an idle map fires no render event.
  useLayoutEffect(() => { draw(); }, [candidates, draw]);

  if (!map || candidates.length === 0) return null;
  return (
    <svg
      ref={svgRef}
      data-wanderly-geography-labels="true"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[4] size-full overflow-hidden"
      viewBox={`0 0 ${map.getContainer().clientWidth || 1} ${map.getContainer().clientHeight || 1}`}
    >
      <defs><clipPath id="wanderly-globe-clip-labels"><path ref={globeClipPathRef} /></clipPath></defs>
      <g ref={labelGroupRef} clipPath="url(#wanderly-globe-clip-labels)">
        {candidates.map((label) => (
          <g
            key={label.key}
            data-label-kind={label.kind}
            data-label-key={label.key}
            style={{ display: "none" }}
            ref={(element) => {
              if (element) nodesRef.current.set(label.key, { group: element, dot: element.querySelector("circle") });
              else nodesRef.current.delete(label.key);
            }}
          >
            {label.kind === "capital" ? <circle r="2.2" fill="#f4a340" stroke="#fffdf9" strokeWidth="1.2" /> : null}
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fill="#073d50"
              fillOpacity={label.kind === "continent" ? 0.72 : 0.96}
              stroke="#fffdf9"
              strokeOpacity="0.94"
              strokeWidth={label.kind === "continent" ? 4 : 3}
              strokeLinejoin="round"
              style={{ fontFamily: "var(--font-sans)", fontSize: "inherit", fontWeight: label.kind === "city" || label.kind === "region" ? 700 : 800, letterSpacing: label.kind === "continent" ? "0.08em" : undefined, paintOrder: "stroke" }}
            >
              {label.name}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

type LabelNode = { group: SVGGElement; dot: SVGCircleElement | null };

function labelKind(className: string, capital: boolean, rank: number, zoom: number, visibility: GeographyVisibility): LabelKind | null {
  if (className === "continent" && visibility.countries && zoom < 3.6) return "continent";
  if (className === "country" && visibility.countries && zoom < REGION_SELECTION_MIN_ZOOM && rank <= (zoom < 3.5 ? 2 : 4)) return "country";
  if ((className === "region" || className === "state" || className === "province") && visibility.regions && zoom >= REGION_SELECTION_MIN_ZOOM && zoom < CITY_SELECTION_MIN_ZOOM && rank <= (zoom < 5.5 ? 2 : 4)) return "region";
  if (className === "capital" && visibility.cities && zoom >= CITY_SELECTION_MIN_ZOOM && rank <= 8) return "capital";
  if (className === "city" && visibility.cities && capital && zoom >= CITY_SELECTION_MIN_ZOOM && rank <= 8) return "capital";
  if (className === "city" && visibility.cities && zoom >= CITY_SELECTION_MIN_ZOOM && rank <= (zoom < 8 ? 5 : 10)) return "city";
  return null;
}

function localizedName(properties: Record<string, unknown>, locale: string) {
  const fields = locale.toLowerCase().startsWith("zh")
    ? ["name:zh-Hans", "name:zh", "name_zh", "name:en", "name_en", "name"]
    : ["name:en", "name_en", "name"];
  for (const field of fields) {
    const value = properties[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numericProperty(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function labelPriority(label: GeographyLabel, zoom: number) {
  const base = label.kind === "continent" ? (zoom < 2.6 ? 0 : 40)
    : label.kind === "country" ? 10
      : label.kind === "capital" ? 20
        : label.kind === "city" ? 30
          : 25;
  return base + label.rank;
}

function labelFontSize(kind: LabelKind, zoom: number) {
  if (kind === "continent") return Math.min(22, 14 + zoom * 2.2);
  if (kind === "country") return Math.min(18, 11 + zoom * 1.35);
  if (kind === "capital") return Math.min(15, 9 + zoom * 1.05);
  if (kind === "region") return Math.min(14, 8 + zoom * 0.85);
  return Math.min(14, 8 + zoom * 0.9);
}

function intersects(left: { left: number; right: number; top: number; bottom: number }, right: { left: number; right: number; top: number; bottom: number }) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}
