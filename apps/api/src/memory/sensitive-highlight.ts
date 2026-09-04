/**
 * Whether a free-text highlight carries something the catalogue marks
 * `FORM_ONLY`.
 *
 * Three fields — nationality, date of birth, mobility notes — are withheld
 * from the conversation on purpose: the profile form may write them, and
 * `conversation-memory-context.ts` does not send them to the model, because
 * handing them to a third party on every turn is a wider exposure than storing
 * them.
 *
 * Free-text notes went around that. Typed highlight extraction already
 * excludes `FORM_ONLY` fields, so a sentence about a passport or a bad knee
 * cannot be extracted — and the fallback then kept the whole sentence
 * verbatim, and notes go into the prompt on every turn. The guard was bypassed
 * by the fallback of the check enforcing it. Verified on screen: a note saying
 * "膝盖不好走不了长路" produced a reply opening "我会重点考虑你提到的膝盖不便的情况".
 *
 * Detection is deliberately narrow. A false positive refuses a note and tells
 * the traveller where the field belongs, which is recoverable; a false
 * negative sends a passport number to a model, which is not. Patterns match
 * the way people write these things, not every way they could.
 */
export type SensitiveHighlightCategory = "nationality" | "date_of_birth" | "mobility_notes" | "identity_document" | "contact" | "payment";

const PATTERNS: ReadonlyArray<{ category: SensitiveHighlightCategory; pattern: RegExp }> = [
  {
    category: "nationality",
    pattern: /护照|国籍|passport|nationality|citizen(ship)?|绿卡|permanent resident/iu,
  },
  {
    category: "date_of_birth",
    pattern: /出生日期|生日|出生于|date of birth|\bdob\b|born (on|in)\s+\d/iu,
  },
  {
    category: "mobility_notes",
    pattern: /轮椅|行动不便|无障碍|拄拐|助行器|膝盖|腰[伤疼痛]|走不[了动]|不能久站|wheelchair|mobility (aid|issue|impair)|accessib(le|ility) need|cannot walk|can't walk/iu,
  },
  {
    category: "identity_document",
    pattern: /\b[A-Z][0-9]{7,8}\b|\b(?:passport|证件|身份证)[\s:#号]*[A-Z0-9-]{6,}/iu,
  },
  {
    category: "contact",
    pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b(?:\+?\d[\d\s-]{7,}\d)\b|电话|手机号|email/iu,
  },
  {
    category: "payment",
    pattern: /\b(?:\d[ -]?){13,19}\b|信用卡|银行卡|cvv|card number/iu,
  },
];

/** The first category this highlight appears to carry, or null. */
export function sensitiveHighlightCategory(highlight: string): SensitiveHighlightCategory | null {
  for (const { category, pattern } of PATTERNS) {
    if (pattern.test(highlight)) return category;
  }
  return null;
}
