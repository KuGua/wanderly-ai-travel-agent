const PREFIX = "wanderly.recentTrip.";
// Only a navigation pointer. Membership is always checked against the live Trip list.
export function readRecentTrip(viewer: string): string | null {
  try { return window.sessionStorage.getItem(PREFIX + viewer); } catch { return null; }
}
export function rememberRecentTrip(viewer: string, tripId: string): void {
  try { window.sessionStorage.setItem(PREFIX + viewer, tripId); } catch { /* Optional storage. */ }
}
