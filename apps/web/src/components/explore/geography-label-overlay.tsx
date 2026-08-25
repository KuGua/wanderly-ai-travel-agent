"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useState } from "react";

import { isCoordinateOnVisibleHemisphere } from "./country-boundary-overlay";
import type { GeographyVisibility } from "./map-geography-layers";

type LabelKind = "continent" | "country" | "capital" | "city" | "region";

export type GeographyLabel = {
  key: string;
  name: string;
  coordinates: [number, number];
  kind: LabelKind;
  rank: number;
};

type PositionedLabel = GeographyLabel & { x: number; y: number; fontSize: number };
type PlaceFeature = GeoJSON.Feature<GeoJSON.Point>;

export const GEOGRAPHY_LABEL_DATA_URL = "/map-data/geography-labels.geojson";

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
  const [labels, setLabels] = useState<PositionedLabel[]>([]);

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

  useEffect(() => {
    if (!map || features.length === 0) return;
    let frame: number | null = null;
    const redraw = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        try {
          const container = map.getContainer();
          const center = map.getCenter();
          const zoom = map.getZoom();
          const candidates = geographyLabelsFromFeatures(
            features,
            zoom,
            locale,
            visibility,
          );
          if (process.env.NODE_ENV !== "production") container.dataset.wanderlyLabelStatus = `features:${features.length};candidates:${candidates.length}`;
          const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
          const next: PositionedLabel[] = [];
          for (const candidate of candidates) {
            if (!isCoordinateOnVisibleHemisphere(candidate.coordinates, [center.lng, center.lat])) continue;
            const point = map.project(candidate.coordinates);
            const fontSize = labelFontSize(candidate.kind, zoom);
            const width = Math.max(fontSize * 2, [...candidate.name].length * fontSize * 0.62);
            const bounds = {
              left: point.x - width / 2 - 5,
              right: point.x + width / 2 + 5,
              top: point.y - fontSize * 0.75 - 4,
              bottom: point.y + fontSize * 0.55 + 4,
            };
            if (bounds.right < 0 || bounds.left > container.clientWidth || bounds.bottom < 0 || bounds.top > container.clientHeight) continue;
            if (occupied.some((existing) => intersects(existing, bounds))) continue;
            occupied.push(bounds);
            next.push({ ...candidate, x: point.x, y: point.y, fontSize });
          }
          setLabels(next);
        } catch (error) {
          if (process.env.NODE_ENV !== "production") {
            map.getContainer().dataset.wanderlyLabelStatus = error instanceof Error ? `error:${error.message}` : "error:unknown";
          }
          setLabels([]);
        }
      });
    };
    redraw();
    map.on("move", redraw);
    map.on("resize", redraw);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      map.off("move", redraw);
      map.off("resize", redraw);
    };
  }, [features, locale, map, visibility]);

  if (!map || labels.length === 0) return null;
  return (
    <svg
      data-wanderly-geography-labels="true"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[4] size-full overflow-hidden"
      viewBox={`0 0 ${map.getContainer().clientWidth || 1} ${map.getContainer().clientHeight || 1}`}
    >
      {labels.map((label) => (
        <g key={label.key} data-label-kind={label.kind} transform={`translate(${label.x.toFixed(2)} ${label.y.toFixed(2)})`}>
          {label.kind === "capital" ? <circle cx={-label.fontSize * 0.45} cy={-label.fontSize * 0.3} r="2.2" fill="#f4a340" stroke="#fffdf9" strokeWidth="1.2" /> : null}
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill="#073d50"
            fillOpacity={label.kind === "continent" ? 0.72 : 0.96}
            stroke="#fffdf9"
            strokeOpacity="0.94"
            strokeWidth={label.kind === "continent" ? 4 : 3}
            strokeLinejoin="round"
            style={{ fontSize: label.fontSize, fontWeight: label.kind === "city" || label.kind === "region" ? 700 : 800, letterSpacing: label.kind === "continent" ? "0.08em" : undefined, paintOrder: "stroke" }}
          >
            {label.name}
          </text>
        </g>
      ))}
    </svg>
  );
}

function labelKind(className: string, capital: boolean, rank: number, zoom: number, visibility: GeographyVisibility): LabelKind | null {
  if (className === "continent" && visibility.countries && zoom < 3.6) return "continent";
  if (className === "country" && visibility.countries && zoom >= 1.1 && rank <= (zoom < 2.2 ? 1 : zoom < 3 ? 2 : zoom < 4 ? 3 : 6)) return "country";
  if (className === "capital" && visibility.cities && zoom >= 2.6) return "capital";
  if (className === "city" && visibility.cities && capital && zoom >= 2.6) return "capital";
  if (className === "city" && visibility.cities && zoom >= 2.8 && rank <= (zoom < 3.5 ? 2 : zoom < 5 ? 5 : 10)) return "city";
  if ((className === "region" || className === "state" || className === "province") && visibility.regions && zoom >= 4.2 && rank <= (zoom < 5 ? 2 : 6)) return "region";
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
