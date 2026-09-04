import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function everySourceFile(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return everySourceFile(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every `operation` the Draft guard is called with must be a declared label
 * value on the counter it records the rejection to.
 *
 * `metrics.inc` refuses an undeclared value by throwing, and the guard counts
 * the rejection *before* raising its own 409 — so an unlisted operation turns
 * a clean "activate the trip first" into a 500. Six `constraint_*` operations
 * reached the guard's callers without reaching the metric, which took
 * `GET /trips/:tripId/plans` down for every Draft trip.
 *
 * Read from source rather than exercised through a request: this should fail
 * when a new caller is written, not once somebody opens a Draft.
 */
describe("draft_command_rejected_total", () => {
  it("declares every operation requireActiveTrip is called with", () => {
    const metricsSource = readFileSync(join(srcRoot, "observability", "metrics.ts"), "utf8");
    const declaration = metricsSource.slice(metricsSource.indexOf('registerCounter("draft_command_rejected_total"'));
    const operationBlock = declaration.slice(
      declaration.indexOf("operation: ["),
      declaration.indexOf("]", declaration.indexOf("operation: [")),
    );
    const declared = new Set([...operationBlock.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]));

    const used = new Set<string>();
    for (const file of everySourceFile(srcRoot)) {
      for (const match of readFileSync(file, "utf8").matchAll(/requireActiveTrip\([^,)]+,\s*"([a-z_]+)"/g)) {
        used.add(match[1]);
      }
    }

    // A guard nobody calls would pass vacuously.
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((operation) => !declared.has(operation))).toEqual([]);
  });
});
