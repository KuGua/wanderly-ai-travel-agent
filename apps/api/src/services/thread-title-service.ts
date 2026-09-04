export type ThreadTitleLocale = "en" | "zh";

/**
 * Default thread title for a (owner, trip) pair. Per
 * docs/thread-title-lifecycle-implementation.md §8 this string must not
 * depend on the trip brief, so brief confirmations and edits never need to
 * recompute it.
 */
export function buildDefaultThreadTitle(locale: ThreadTitleLocale): string {
  return locale === "zh" ? "行程规划" : "Trip planning";
}

/**
 * Title for an extra, non-default thread. The caller supplies the 1-based
 * index computed inside the same transaction that inserts the row, so two
 * concurrent creates cannot share an index under default isolation.
 */
export function buildIndexedThreadTitle(index: number, locale: ThreadTitleLocale): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`buildIndexedThreadTitle: index must be a positive integer, got ${index}`);
  }
  return locale === "zh" ? `新对话 ${index}` : `New chat ${index}`;
}
