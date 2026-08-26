import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

import { mesh } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, quantile, simplify } from "topojson-simplify";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "public/map-data");
const naturalEarthVersion = "v5.1.2";
const naturalEarthUrl = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${naturalEarthVersion}/geojson/ne_10m_admin_0_countries.geojson`;
const inputPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : null;

const lods = [
  { id: "lod0", simplificationQuantile: 0.005, minZoom: 0, maxZoom: 3.4 },
  { id: "lod1", simplificationQuantile: 0.035, minZoom: 3.4, maxZoom: 5.5 },
  { id: "lod2", simplificationQuantile: 0.07, minZoom: 5.5, maxZoom: null },
];
// A single global simplification threshold erases whole micro states: every
// point of Singapore's ring weighs less than the world-wide quantile, so the
// mesh kept only a degenerate stub and no Singapore outline was drawn. Every
// arc of a country whose full geometry spans less than this many degrees is
// pinned so simplification keeps it at all LODs.
const smallCountrySpanDegrees = 1.5;

const source = inputPath
  ? await readFile(inputPath)
  : await downloadNaturalEarth();
const countries = JSON.parse(source.toString("utf8"));
if (countries.type !== "FeatureCollection") {
  throw new Error("Natural Earth Admin 0 input must be a GeoJSON FeatureCollection.");
}

const sourceSha256 = createHash("sha256").update(source).digest("hex");
const baseTopology = presimplify(topology({ countries }, 100_000));
// Thresholds come from the untouched weight distribution, then the micro-state
// arcs are pinned so no LOD can drop them.
const thresholdByLod = new Map(lods.map((lod) => [lod.id, quantile(baseTopology, lod.simplificationQuantile)]));
const pinnedArcCount = pinSmallCountryArcs(baseTopology, countries, smallCountrySpanDegrees);
const manifest = {
  schemaVersion: 1,
  generatedAt: process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString() : null,
  smallCountrySpanDegrees,
  pinnedArcCount,
  sources: [{
    name: "Natural Earth Admin 0 Countries",
    version: naturalEarthVersion,
    url: naturalEarthUrl,
    sha256: sourceSha256,
    usage: "Build-time source only; browsers load the derived local line meshes.",
  }],
  datasets: [],
};

await mkdir(outputDirectory, { recursive: true });
for (const lod of lods) {
  const threshold = thresholdByLod.get(lod.id);
  const simplified = simplify(structuredClone(baseTopology), threshold);
  const borderMesh = mesh(simplified, simplified.objects.countries);
  const output = {
    type: "FeatureCollection",
    metadata: {
      source: "Natural Earth Admin 0 Countries",
      version: naturalEarthVersion,
      lod: lod.id,
      minZoom: lod.minZoom,
      maxZoom: lod.maxZoom,
      smallCountrySpanDegrees,
      topology: "shared arcs; every country border or coastline segment is emitted once",
    },
    features: [{ type: "Feature", properties: { class: "country-boundary" }, geometry: borderMesh }],
  };
  const serialized = `${JSON.stringify(output)}\n`;
  const outputPath = resolve(outputDirectory, `country-borders-${lod.id}.geojson`);
  await writeFile(outputPath, serialized);
  manifest.datasets.push({
    id: lod.id,
    path: `map-data/country-borders-${lod.id}.geojson`,
    minZoom: lod.minZoom,
    maxZoom: lod.maxZoom,
    simplificationQuantile: lod.simplificationQuantile,
    bytes: Buffer.byteLength(serialized),
    gzipBytes: gzipSync(serialized).byteLength,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

await writeFile(resolve(outputDirectory, "boundary-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.datasets.length} shared-boundary LOD files from Natural Earth ${naturalEarthVersion}.`);

function pinSmallCountryArcs(topo, source, maxSpanDegrees) {
  const smallCountries = new Set(source.features
    .filter((feature) => geometrySpanDegrees(feature.geometry) < maxSpanDegrees)
    .map((feature) => feature.properties.ADM0_A3));
  const pinned = new Set();
  for (const geometry of topo.objects.countries.geometries) {
    if (!smallCountries.has(geometry.properties.ADM0_A3)) continue;
    collectArcIndices(geometry.arcs, pinned);
  }
  for (const index of pinned) {
    for (const point of topo.arcs[index]) point[2] = Infinity;
  }
  return pinned.size;
}

function collectArcIndices(arcs, collected) {
  for (const arc of arcs) {
    if (typeof arc === "number") collected.add(arc < 0 ? ~arc : arc);
    else collectArcIndices(arc, collected);
  }
}

function geometrySpanDegrees(geometry) {
  let minLongitude = Infinity;
  let minLatitude = Infinity;
  let maxLongitude = -Infinity;
  let maxLatitude = -Infinity;
  const visit = (coordinates) => {
    if (typeof coordinates[0] === "number") {
      minLongitude = Math.min(minLongitude, coordinates[0]);
      maxLongitude = Math.max(maxLongitude, coordinates[0]);
      minLatitude = Math.min(minLatitude, coordinates[1]);
      maxLatitude = Math.max(maxLatitude, coordinates[1]);
      return;
    }
    coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
  return Math.max(maxLongitude - minLongitude, maxLatitude - minLatitude);
}

async function downloadNaturalEarth() {
  const response = await fetch(naturalEarthUrl);
  if (!response.ok) throw new Error(`Natural Earth download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
