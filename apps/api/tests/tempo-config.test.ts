import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local Tempo configuration", () => {
  it("uses Tempo 2.6-compatible retention configuration", async () => {
    const config = await readFile(
      path.resolve(import.meta.dirname, "../observability/tempo-config.yaml"),
      "utf8",
    );

    expect(config).toContain("block_retention: 24h");
    expect(config).toContain("reporting_enabled: false");
    expect(config).not.toMatch(/^search_overrides:/m);
  });
});
