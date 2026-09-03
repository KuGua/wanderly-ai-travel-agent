/**
 * Browser state that belongs to whoever is signed in, and has to go when they
 * leave.
 *
 * The React Query cache is already handled: `sessionRevision` rebuilds the
 * client on every sign-in and sign-out, so no private response survives an
 * account switch. What it does not reach is the handful of pointers written
 * straight to `localStorage` / `sessionStorage`, none of which carry a user in
 * their key:
 *
 *   - `wanderly.privateChatActiveRunId.v1` — the run the chat is following.
 *     Left behind, the next traveller polls a run that is not theirs, gets 403
 *     forever, and the composer never comes back.
 *   - `wanderly.sharedPlan.lastSeen.<tripId>` — how far the *reader* has read.
 *     Inherited, someone new to a trip starts with no unread badge for plans
 *     they have never seen.
 *   - `research.realProviderAcked.<providers>` — an acknowledgement that the
 *     next search hits real suppliers. This one is consent, not preference:
 *     inheriting it means acting on an acknowledgement the current traveller
 *     never gave.
 *
 * Prefix-matched rather than listed key by key, so a pointer added later is
 * covered by naming it, not by remembering to edit this file. Auth's own keys
 * are cleared by the auth service itself and are deliberately absent here.
 */
const VIEWER_SCOPED_PREFIXES = [
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

/** Never throws: a browser that refuses storage must not block signing out. */
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
