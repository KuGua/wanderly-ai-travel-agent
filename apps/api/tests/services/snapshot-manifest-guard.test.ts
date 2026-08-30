import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { extractSnapshotV2Meta } from "../../src/services/planning-service.js";
import {
  assertSnapshotManifestStable,
  hashProjectionManifest,
} from "../../src/services/snapshot-manifest-guard.js";

describe("snapshot-manifest-guard", () => {
  const sampleAuthorizedData = {
    _meta: {
      schemaVersion: 2,
      projectionManifest: [
        { sourceId: "src-a", revision: 1, visibility: "TEAM_VISIBLE" },
        { sourceId: "src-b", revision: 3, visibility: "ORCHESTRATOR_CONFIDENTIAL" },
      ],
    },
  };

  it("hashes projection manifest deterministically (sort + sha256)", () => {
    const h1 = hashProjectionManifest(sampleAuthorizedData);
    const h2 = hashProjectionManifest({
      ...sampleAuthorizedData,
      _meta: {
        ...sampleAuthorizedData._meta,
        // Same entries in different order — hash must match.
        projectionManifest: [
          { sourceId: "src-b", revision: 3, visibility: "ORCHESTRATOR_CONFIDENTIAL" },
          { sourceId: "src-a", revision: 1, visibility: "TEAM_VISIBLE" },
        ],
      },
    });
    expect(h1).toBe(h2);
    // sha256 hex → 64 chars
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash changes when a tuple is added", () => {
    const before = hashProjectionManifest(sampleAuthorizedData);
    const after = hashProjectionManifest({
      _meta: {
        schemaVersion: 2,
        projectionManifest: [
          ...sampleAuthorizedData._meta.projectionManifest,
          { sourceId: "src-c", revision: 1, visibility: "TEAM_VISIBLE" },
        ],
      },
    });
    expect(after).not.toBe(before);
  });

  it("hash is stable for empty / missing projectionManifest", () => {
    const empty = hashProjectionManifest({ _meta: { schemaVersion: 2 } });
    const missing = hashProjectionManifest({});
    expect(empty).toBe(missing);
  });

  it("matches the manual sha256 of the sorted tuple list", () => {
    const tuples: string[] = [];
    const meta = extractSnapshotV2Meta(sampleAuthorizedData);
    for (const entry of meta?.projectionManifest ?? []) {
      tuples.push(`${entry.sourceId}|${entry.revision}|${entry.visibility}`);
    }
    tuples.sort();
    const expected = createHash("sha256").update(tuples.join("\n")).digest("hex");
    expect(hashProjectionManifest(sampleAuthorizedData)).toBe(expected);
  });
});

describe("assertSnapshotManifestStable", () => {
  // Real DB tests live in the orchestrator integration suite; this block
  // verifies the helper's error semantics with a stub fetch via a custom
  // getSnapshot wrapper would belong here. Keeping it lightweight — the
  // function is exercised end-to-end by `personal-trip-orchestrator` tests.
  it("exports a stable API surface", () => {
    expect(typeof assertSnapshotManifestStable).toBe("function");
    expect(typeof hashProjectionManifest).toBe("function");
  });
});