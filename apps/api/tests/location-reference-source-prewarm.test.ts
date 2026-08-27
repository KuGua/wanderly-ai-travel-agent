import { afterEach, describe, expect, it } from "vitest";

import {
  __resetLocationReferenceSourceForTests,
  getLocationReferenceSource,
} from "../src/location-reference/location-reference-source.js";

afterEach(() => {
  __resetLocationReferenceSourceForTests();
  delete process.env.LOCATION_REFERENCE_MODE;
  delete process.env.LOCATION_REFERENCE_SIDECAR_URL;
  delete process.env.LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS;
});

describe("location-reference source prewarm", () => {
  it("returns ok=true with duration for the in-process default", () => {
    const source = getLocationReferenceSource();
    const result = source.prewarm();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("in-process");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("a second prewarm is idempotent and reports a non-negative duration", () => {
    const source = getLocationReferenceSource();
    const first = source.prewarm();
    const second = source.prewarm();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.mode).toBe("in-process");
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("disabled mode is a no-op and reports duration 0", () => {
    process.env.LOCATION_REFERENCE_MODE = "disabled";
    const source = getLocationReferenceSource();
    const result = source.prewarm();
    expect(result).toEqual({ ok: true, mode: "disabled", durationMs: 0 });
  });

  it("sidecar mode is a no-op and reports duration 0", () => {
    process.env.LOCATION_REFERENCE_MODE = "sidecar";
    process.env.LOCATION_REFERENCE_SIDECAR_URL = "http://127.0.0.1:3002";
    const source = getLocationReferenceSource();
    const result = source.prewarm();
    expect(result).toEqual({ ok: true, mode: "sidecar", durationMs: 0 });
  });
});