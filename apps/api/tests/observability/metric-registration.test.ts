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
 * Every counter incremented anywhere in `src` must be registered.
 *
 * `metrics.inc` throws on an unregistered name, and the increments sit inside
 * request handlers — so a counter added without its registration does not
 * degrade telemetry, it 500s the route. `trip_brief_destination_resolution_total`
 * did exactly that to `PATCH /trips/:tripId/draft-brief`, which is the call
 * behind saving a destination, and the sibling `draft_command_rejected_total`
 * broke the trip workspace the same week by way of an unlisted label.
 *
 * Read from source so the build fails when the counter is written, rather
 * than a traveller's request failing when it is first reached. Names built at
 * runtime are skipped — the check only claims to cover literals, which is
 * what every call site uses today.
 */
describe("metric registration", () => {
  it("registers every counter that src increments", () => {
    const sources = everySourceFile(srcRoot).map((file) => readFileSync(file, "utf8"));
    const all = sources.join("\n");

    const registered = new Set(
      [...all.matchAll(/registerCounter\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((match) => match[1]),
    );
    const incremented = new Set(
      [...all.matchAll(/metrics\.inc\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((match) => match[1]),
    );

    expect(registered.size).toBeGreaterThan(10);
    expect(incremented.size).toBeGreaterThan(10);
    expect([...incremented].filter((name) => !registered.has(name)).sort()).toEqual([]);
  });
});
