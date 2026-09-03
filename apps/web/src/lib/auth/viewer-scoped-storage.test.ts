import { afterEach, describe, expect, it } from "vitest";

import { clearViewerScopedStorage, viewerScopedKey } from "./viewer-scoped-storage";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("clearViewerScopedStorage", () => {
  it("drops the pointers that would otherwise follow one traveller to the next", () => {
    localStorage.setItem("wanderly.privateChatActiveRunId.v1", "run-id");
    localStorage.setItem("wanderly.sharedPlan.lastSeen.trip-a", "7");
    localStorage.setItem("wanderly.sharedPlan.lastSeen.trip-b", "3");
    sessionStorage.setItem("research.realProviderAcked.serpapi|nuitee", "1");

    clearViewerScopedStorage();

    expect(localStorage.getItem("wanderly.privateChatActiveRunId.v1")).toBeNull();
    expect(localStorage.getItem("wanderly.sharedPlan.lastSeen.trip-a")).toBeNull();
    expect(localStorage.getItem("wanderly.sharedPlan.lastSeen.trip-b")).toBeNull();
    expect(sessionStorage.getItem("research.realProviderAcked.serpapi|nuitee")).toBeNull();
  });

  it("leaves everything else alone, the auth keys included", () => {
    // Auth clears its own session; this must not reach past its remit and
    // wipe unrelated state a browser happens to be holding.
    localStorage.setItem("wanderly_auth_token", "token");
    localStorage.setItem("wanderly_remember_me", "1");
    localStorage.setItem("some.other.app", "keep");

    clearViewerScopedStorage();

    expect(localStorage.getItem("wanderly_auth_token")).toBe("token");
    expect(localStorage.getItem("wanderly_remember_me")).toBe("1");
    expect(localStorage.getItem("some.other.app")).toBe("keep");
  });

  it("clears every match, not every other one", () => {
    // Removing while walking the index shifts the entries underneath, which
    // silently leaves half of them behind.
    for (let index = 0; index < 6; index += 1) {
      localStorage.setItem(`wanderly.sharedPlan.lastSeen.trip-${index}`, String(index));
    }

    clearViewerScopedStorage();

    const left = Object.keys(localStorage).filter((key) => key.startsWith("wanderly.sharedPlan."));
    expect(left).toEqual([]);
  });
});

describe("viewerScopedKey", () => {
  function signIn(username: string) {
    localStorage.setItem("wanderly_auth_user", JSON.stringify({ username }));
  }

  it("gives two accounts on one browser separate slots", () => {
    signIn("guolufei");
    const forFirst = viewerScopedKey("wanderly.privateChatActiveRunId.v1");
    signIn("mike");
    const forSecond = viewerScopedKey("wanderly.privateChatActiveRunId.v1");

    expect(forFirst).not.toBe(forSecond);
  });

  it("does not hand the next account the previous one's value", () => {
    // The whole point: signing in as someone else must not surface a run id
    // that answers 403, whether or not the first account signed out cleanly.
    signIn("guolufei");
    localStorage.setItem(viewerScopedKey("wanderly.privateChatActiveRunId.v1"), "guolufei-run");
    signIn("mike");

    expect(localStorage.getItem(viewerScopedKey("wanderly.privateChatActiveRunId.v1"))).toBeNull();
  });

  it("keeps a signed-out reader in a slot of their own", () => {
    localStorage.removeItem("wanderly_auth_user");
    expect(viewerScopedKey("k")).toBe("k@anon");
  });

  it("falls back to the shared slot rather than throwing on unreadable state", () => {
    localStorage.setItem("wanderly_auth_user", "{not json");
    expect(viewerScopedKey("k")).toBe("k@anon");
  });
});
