import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewerScopedKey } from "@/lib/auth/viewer-scoped-storage";

import {
  readLastSeenVersion,
  SHARED_PLAN_LAST_SEEN_PREFIX,
  writeLastSeenVersion,
} from "./shared-plan-read-state";

const TRIP_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_TRIP_ID = "00000000-0000-4000-8000-000000000002";
const STORAGE_KEY = viewerScopedKey(`${SHARED_PLAN_LAST_SEEN_PREFIX}${TRIP_ID}`);

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("shared-plan-read-state", () => {
  it("returns 0 when no value has been written", () => {
    expect(readLastSeenVersion(TRIP_ID)).toBe(0);
  });

  it("round-trips a written value", () => {
    writeLastSeenVersion(TRIP_ID, 7);
    expect(readLastSeenVersion(TRIP_ID)).toBe(7);
    expect(readLastSeenVersion(OTHER_TRIP_ID)).toBe(0);
    // Direct key inspection keeps the contract auditable: the spec forbids
    // persisting any non-version data in this slot.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("7");
  });

  it("ignores writes below or equal to the existing pointer", () => {
    writeLastSeenVersion(TRIP_ID, 5);
    writeLastSeenVersion(TRIP_ID, 3);
    expect(readLastSeenVersion(TRIP_ID)).toBe(5);
    writeLastSeenVersion(TRIP_ID, 5);
    expect(readLastSeenVersion(TRIP_ID)).toBe(5);
  });

  it("ignores non-finite or non-positive values", () => {
    writeLastSeenVersion(TRIP_ID, Number.NaN);
    writeLastSeenVersion(TRIP_ID, -1);
    writeLastSeenVersion(TRIP_ID, 0);
    expect(readLastSeenVersion(TRIP_ID)).toBe(0);
  });

  it("falls back to 0 on a corrupt stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number");
    expect(readLastSeenVersion(TRIP_ID)).toBe(0);
  });

  it("falls back to 0 when localStorage throws (e.g. quota exceeded, sandboxed iframe)", () => {
    // Stub individual methods instead of replacing the whole object so the
    // test environment's localStorage (which may include `length` /
    // `key` / `clear`) is preserved across tests.
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    try {
      expect(readLastSeenVersion(TRIP_ID)).toBe(0);
      // Write must not throw either.
      expect(() => writeLastSeenVersion(TRIP_ID, 3)).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("scopes writes per-trip — clearing one trip's pointer does not touch another", () => {
    writeLastSeenVersion(TRIP_ID, 2);
    writeLastSeenVersion(OTHER_TRIP_ID, 9);
    window.localStorage.removeItem(STORAGE_KEY);
    expect(readLastSeenVersion(TRIP_ID)).toBe(0);
    expect(readLastSeenVersion(OTHER_TRIP_ID)).toBe(9);
  });
});