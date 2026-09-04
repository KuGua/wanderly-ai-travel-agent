// Server-side postprocessing for the LLM-suggested thread title.
//
// Per docs/thread-title-lifecycle-implementation.md §9.2 this is the
// **last** line of defence before the title is written to the database.
// Every rule fails closed: any rejection leaves the existing row untouched
// and the route reports `applied: false, reason: "REJECTED"`. The pure
// function shape keeps this module trivially testable and side-effect free.

const URL_OR_EMAIL_REGEX = /(https?:\/\/|\S+@\S+\.\S+)/u;
const LONG_DIGIT_RUN_REGEX = /\d{6,}/u;
const PRIVATE_USE_AREA_REGEX = /[\u{E0000}-\u{E0FFF}]/u;
// Emoji-related property classes: pictographic + symbol blocks most common on
// keyboards. We strip before truncation so the 40-char cap applies to the
// final visible text, not to invisible code points.
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const CONTROL_CHARS_REGEX = /[\p{Cc}\p{Cf}]/gu;
const WHITESPACE_RUN_REGEX = /\s+/gu;

const MAX_TITLE_CODE_POINTS = 40;

export type PostprocessResult =
  | { ok: true; title: string }
  | { ok: false; reason: "REJECTED" };

/**
 * Returns the cleaned title or `{ ok: false }` if any rule rejects the
 * candidate. `sourceMessages` are the user messages the skill saw; titles
 * that echo them verbatim would surface raw private content in the rail.
 */
export function postprocessThreadTitle(
  raw: string,
  sourceMessages: ReadonlyArray<{ text: string }>,
): PostprocessResult {
  // 1. Convert tabs / newlines / carriage returns to single spaces BEFORE
  //    stripping controls, so we don't lose word separators.
  const lineFolded = raw
    .normalize("NFKC")
    .replace(/[\t\r\n]+/gu, " ");

  // 2. Drop other control characters (format / line / paragraph separators
  //    and the like) but keep printable space.
  const cleaned = lineFolded.replace(CONTROL_CHARS_REGEX, "");

  // 2. Drop emoji and private-use-area code points.
  const noEmoji = cleaned
    .replace(EMOJI_REGEX, "")
    .replace(PRIVATE_USE_AREA_REGEX, "")
    .replace(WHITESPACE_RUN_REGEX, " ")
    .trim();

  if (!noEmoji) {
    return { ok: false, reason: "REJECTED" };
  }

  // 3. Hard truncate to 40 code points (grapheme clusters approximate this
  // well enough for the rail; we accept the small risk of a partial CJK
  // glyph rather than a complex segmenter dependency).
  const truncated = Array.from(noEmoji).slice(0, MAX_TITLE_CODE_POINTS).join("");

  if (!truncated) {
    return { ok: false, reason: "REJECTED" };
  }

  // 4. Reject URLs and email addresses.
  if (URL_OR_EMAIL_REGEX.test(truncated)) {
    return { ok: false, reason: "REJECTED" };
  }

  // 5. Reject long digit runs (likely card / document / order numbers).
  if (LONG_DIGIT_RUN_REGEX.test(truncated)) {
    return { ok: false, reason: "REJECTED" };
  }

  // 6. Reject titles that echo or contain a source message verbatim — this
  // would surface raw private content in the rail.
  for (const message of sourceMessages) {
    if (!message.text) continue;
    if (truncated === message.text || message.text.includes(truncated)) {
      return { ok: false, reason: "REJECTED" };
    }
  }

  return { ok: true, title: truncated };
}
