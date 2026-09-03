/**
 * Shared Plan Surface — client-side "last seen" pointer for the
 * trip-scoped unread badge.
 *
 * Stores the highest plan `version` the caller has acknowledged for a
 * given trip. The badge (rail unread dot, §7.5 / §10.2.5) is computed as
 * `max(plans[*].version) > lastSeenVersion`. Missing / corrupt entries
 * fall back to `0`, meaning "everything is unread", which is the safe
 * default: the badge then disappears as soon as the user opens the view.
 *
 * Per spec §1.8: this is a UI preference, not business state. `localStorage`
 * loss only affects the badge, never server-side data. Never persist plan
 * content, constraint values, snapshots, run authority, or vote results.
 */

export const SHARED_PLAN_LAST_SEEN_PREFIX = "wanderly.sharedPlan.lastSeen.";
const SHARED_PLAN_LAST_SEEN_KEY = (tripId: string): string => `${SHARED_PLAN_LAST_SEEN_PREFIX}${tripId}`;

/**
 * Returns the highest plan version the caller has acknowledged for the
 * trip, or `0` if the pointer is missing, corrupt, or `localStorage` is
 * unavailable. Never throws.
 */
export function readLastSeenVersion(tripId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(SHARED_PLAN_LAST_SEEN_KEY(tripId));
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    // Disabled storage, quota, or sandboxed iframe. Treat as "never seen";
    // the badge logic handles this without blocking render.
    return 0;
  }
}

/**
 * Persists the highest plan version the caller has acknowledged. A value
 * below the existing pointer is a no-op (we never move the pointer
 * backward — a single stale tab must not "unsee" a new plan another tab
 * has already marked read).
 *
 * Non-positive or non-finite versions are ignored. Never throws.
 */
export function writeLastSeenVersion(tripId: string, version: number): void {
  if (!Number.isFinite(version) || version <= 0) return;
  if (typeof window === "undefined") return;
  try {
    const previous = readLastSeenVersion(tripId);
    if (version <= previous) return;
    window.localStorage.setItem(SHARED_PLAN_LAST_SEEN_KEY(tripId), String(version));
  } catch {
    // Best-effort: a failed write never blocks render.
  }
}