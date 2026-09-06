import { afterEach, describe, expect, it, vi } from "vitest";
import { clearViewerScopedStorage } from "@/lib/auth/viewer-scoped-storage";
import { readRecentTrip, rememberRecentTrip } from "./recent-trip";

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
describe("recent trip navigation pointer", () => {
  it("keeps only the latest ID per viewer and clears it on sign-out", () => {
    rememberRecentTrip("alice", "first");
    rememberRecentTrip("alice", "second");
    expect(readRecentTrip("alice")).toBe("second");
    expect(readRecentTrip("bob")).toBeNull();
    clearViewerScopedStorage();
    expect(readRecentTrip("alice")).toBeNull();
  });
  it("does not block navigation when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    expect(() => rememberRecentTrip("alice", "first")).not.toThrow();
    expect(readRecentTrip("alice")).toBeNull();
  });
});
