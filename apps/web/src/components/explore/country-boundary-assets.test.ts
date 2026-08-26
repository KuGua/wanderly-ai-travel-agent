import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mapDataDirectory = resolve(process.cwd(), "public/map-data");

describe("generated country boundary assets", () => {
  it("keeps the global startup mesh within the transfer budget", async () => {
    const manifest = JSON.parse(await readFile(resolve(mapDataDirectory, "boundary-manifest.json"), "utf8"));
    const lod0 = manifest.datasets.find((dataset: { id: string }) => dataset.id === "lod0");
    expect(lod0.gzipBytes).toBeLessThanOrEqual(200_000);
    expect(manifest.sources[0].version).toBe("v5.1.2");
  });

  it("contains one shared multiline mesh per LOD", async () => {
    for (const lod of ["lod0", "lod1", "lod2"]) {
      const collection = JSON.parse(await readFile(resolve(mapDataDirectory, `country-borders-${lod}.geojson`), "utf8"));
      expect(collection.features).toHaveLength(1);
      expect(collection.features[0].geometry.type).toBe("MultiLineString");
      expect(collection.metadata.topology).toContain("shared arcs");
    }
  });

  it("keeps micro states outlined at every zoom band", async () => {
    // Singapore spans ~0.4°; a single global simplification threshold used to
    // erase it below zoom 5.5, so no boundary framed the default map centre.
    for (const lod of ["lod0", "lod1", "lod2"]) {
      const collection = JSON.parse(await readFile(resolve(mapDataDirectory, `country-borders-${lod}.geojson`), "utf8"));
      const singaporePoints = (collection.features[0].geometry.coordinates as [number, number][][])
        .flat()
        .filter(([longitude, latitude]) =>
          longitude > 103.5 && longitude < 104.2 && latitude > 1.1 && latitude < 1.6);
      expect(singaporePoints.length, `${lod} lost Singapore's outline`).toBeGreaterThanOrEqual(20);
    }
  });

  it("ships the full-fidelity tiles the index advertises, each within the per-tile budget", async () => {
    const manifest = JSON.parse(await readFile(resolve(mapDataDirectory, "boundary-manifest.json"), "utf8"));
    const lod3 = manifest.datasets.find((dataset: { id: string }) => dataset.id === "lod3");
    const index = JSON.parse(await readFile(resolve(mapDataDirectory, "country-borders-lod3/index.json"), "utf8"));

    expect(index.tileSizeDegrees).toBe(lod3.tileSizeDegrees);
    expect(index.minZoom).toBe(lod3.minZoom);
    expect(index.tiles).toHaveLength(lod3.tileCount);
    // A close-up view fetches a handful of tiles, so no single one may be heavy.
    expect(lod3.largestTileGzipBytes).toBeLessThanOrEqual(150_000);

    for (const tile of index.tiles as { key: string; sha256: string }[]) {
      const serialized = await readFile(resolve(mapDataDirectory, `country-borders-lod3/${tile.key}.geojson`), "utf8");
      expect(createHash("sha256").update(serialized).digest("hex"), `${tile.key} drifted from the index`).toBe(tile.sha256);
    }
  });

  it("keeps more coastline detail in a tile than the simplified mesh it replaces", async () => {
    const inSingapore = ([longitude, latitude]: [number, number]) =>
      longitude > 103.5 && longitude < 104.2 && latitude > 1.1 && latitude < 1.6;
    const pointsIn = async (path: string) => {
      const collection = JSON.parse(await readFile(resolve(mapDataDirectory, path), "utf8"));
      return (collection.features[0].geometry.coordinates as [number, number][][]).flat().filter(inSingapore).length;
    };

    expect(await pointsIn("country-borders-lod3/100_0.geojson"))
      .toBeGreaterThan(await pointsIn("country-borders-lod2.geojson"));
  });
});
