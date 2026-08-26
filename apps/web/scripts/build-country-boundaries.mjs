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
  { id: "lod1", simplificationQuantile: 0.02, minZoom: 3.4, maxZoom: 5.5 },
  { id: "lod2", simplificationQuantile: 0.035, minZoom: 5.5, maxZoom: null },
];

const source = inputPath
  ? await readFile(inputPath)
  : await downloadNaturalEarth();
const countries = JSON.parse(source.toString("utf8"));
if (countries.type !== "FeatureCollection") {
  throw new Error("Natural Earth Admin 0 input must be a GeoJSON FeatureCollection.");
}

const sourceSha256 = createHash("sha256").update(source).digest("hex");
const baseTopology = presimplify(topology({ countries }, 100_000));
const manifest = {
  schemaVersion: 1,
  generatedAt: process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString() : null,
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
  const threshold = quantile(baseTopology, lod.simplificationQuantile);
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

async function downloadNaturalEarth() {
  const response = await fetch(naturalEarthUrl);
  if (!response.ok) throw new Error(`Natural Earth download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
