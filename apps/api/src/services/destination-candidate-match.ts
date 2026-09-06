/**
 * Whether a model-supplied `destinationId` names one of a snapshot's
 * destination candidates.
 *
 * The snapshot holds whatever the place resolver wrote, and that is not a
 * canonical identifier — one production trip carried `Xi’an` with U+2019, the
 * typographic apostrophe GeoNames uses. A model asked for "one controlled
 * destination" writes `Xi'an` with U+0027, because that is how the name is
 * spelled everywhere else. Exact `Array.includes` refused it on every turn
 * until the run spent its whole tool budget and failed with no plan.
 *
 * The fold is deliberately narrow: NFKC plus the apostrophe-like characters,
 * and nothing else.
 *
 * - **No case folding.** These are proper nouns from several producers; two
 *   candidates differing only in case are more likely two different records
 *   than one place written twice.
 * - **No transliteration.** `旧金山` and `San Francisco` are both real values
 *   in this column, and quietly treating them as equal would let a tool search
 *   a destination the traveller never confirmed. When they disagree the right
 *   answer is a refusal the model can read, not a guess.
 *
 * The primary defence is upstream: every destination-taking tool now names the
 * exact candidate strings in its description, so the model copies rather than
 * spells. This is the second layer, for the turns where it paraphrases anyway.
 */

/** Apostrophe-like code points that stand for the same mark in a place name. */
const APOSTROPHE_FORMS = /[‘’ʻʼʹ′]/g;

/** One candidate reduced to the form both sides can be compared in. */
export function foldDestinationName(value: string): string {
  return value.normalize("NFKC").replace(APOSTROPHE_FORMS, "'").trim();
}

export function matchesSnapshotDestination(
  candidates: readonly string[],
  value: string,
): boolean {
  const folded = foldDestinationName(value);
  return candidates.some((candidate) => foldDestinationName(candidate) === folded);
}
