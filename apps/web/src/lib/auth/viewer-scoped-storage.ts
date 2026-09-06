/**
 * Browser state that belongs to whoever is signed in.
 *
 * The React Query cache is already handled: `sessionRevision` rebuilds the
 * client on every sign-in and sign-out, so no private response survives an
 * account switch. What it does not reach is the handful of pointers written
 * straight to `localStorage` / `sessionStorage`:
 *
 *   - the run the chat is following. Left behind, the next traveller polls a
 *     run that is not theirs, gets 403 forever, and the composer never
 *     returns.
 *   - how far the reader has read a trip's shared plans. Inherited, someone
 *     new to the trip starts with no unread badge for plans they have never
 *     seen.
 *   - an acknowledgement that the next search hits real suppliers. That one
 *     is consent rather than preference: inheriting it acts on something the
 *     current traveller never agreed to.
 *
 * These are keyed by viewer rather than cleared on the way out. Clearing only
 * covers a sign-out that goes through the app — not a replaced token, an
 * expired session, or a second account signing in over the first. A key that
 * carries the viewer is correct however the account changes, and the previous
 * traveller's value is simply never read again.
 */

/** Where the auth service keeps the signed-in user; read, never written. */
const AUTH_USER_KEY = "wanderly_auth_user";

/**
 * A stable, per-account suffix.
 *
 * Signed out reads as `anon` rather than an empty string so a signed-out
 * pointer occupies its own slot instead of colliding with a signed-in one.
 * `username` is what the auth service stores and is enough to tell two
 * accounts apart, which is all this needs to do.
 */
export function viewerScope(): string {
  if (typeof window === "undefined") return "anon";
  try {
    const raw = window.localStorage.getItem(AUTH_USER_KEY)
      ?? window.sessionStorage.getItem(AUTH_USER_KEY);
    if (!raw) return "anon";
    const parsed = JSON.parse(raw) as { username?: unknown };
    return typeof parsed.username === "string" && parsed.username ? parsed.username : "anon";
  } catch {
    // Unreadable storage or malformed JSON: fall back to the shared slot
    // rather than throwing on a path that only decides a key name.
    return "anon";
  }
}

/** `base` for the viewer signed in right now. */
export function viewerScopedKey(base: string): string {
  return `${base}@${viewerScope()}`;
}

const VIEWER_SCOPED_PREFIXES = [
  "wanderly.recentTrip.",
  "wanderly.privateChatActiveRunId.",
  "wanderly.sharedPlan.lastSeen.",
  "research.realProviderAcked.",
] as const;

function clearMatching(storage: Storage): void {
  const doomed: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && VIEWER_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      doomed.push(key);
    }
  }
  // Collected first: removing while iterating shifts the indices underneath.
  for (const key of doomed) storage.removeItem(key);
}

/**
 * Drops these pointers for every viewer, on the way out.
 *
 * Redundant with the scoping above and kept anyway: it clears the entries a
 * browser wrote before the keys carried a viewer, and it keeps one traveller's
 * pointers off a shared machine after they leave. Never throws — a browser
 * that refuses storage must not block signing out.
 */
export function clearViewerScopedStorage(): void {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      clearMatching(storage);
    } catch {
      // Private mode, disabled storage, quota errors — nothing here is worth
      // failing the sign-out over.
    }
  }
}
