import type { ConversationPlace } from "../types/schemas.js";

export type TripBriefProposal = {
  departureCities?: string[];
  destinationCandidates?: string[];
  travelDateStart?: string;
  travelDays?: number;
};

/** Extracts only explicit, current-turn facts; never history or a persisted question. */
export function proposeTripBriefFromTurn(question: string, place?: ConversationPlace): TripBriefProposal | null {
  // Chinese durations are written in Chinese numerals far more often than in
  // digits — "玩三天", not "玩3天". Normalizing first means every pattern below
  // reads one alphabet instead of two, and fixes the duration and the
  // destination together: the destination pattern ends at the duration, so a
  // duration it cannot see is a duration the destination swallows whole.
  const text = normalizeChineseNumerals(question);
  const travelDays = extractDays(text);
  const destination = place?.name.trim() || extractDestination(text);
  const departure = extractDeparture(text);
  const travelDateStart = extractDate(text);
  if (!departure && !destination && !travelDateStart && travelDays === undefined) return null;
  return {
    ...(departure ? { departureCities: [departure] } : {}),
    ...(destination ? { destinationCandidates: [destination] } : {}),
    ...(travelDateStart ? { travelDateStart } : {}),
    ...(travelDays !== undefined ? { travelDays } : {}),
  };
}

const CHINESE_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * Rewrites Chinese numerals 1–99 as digits, but only where a counter word makes
 * the intent unambiguous.
 *
 * The guard matters more than the arithmetic: "三" is a number in "三天" and a
 * syllable in "三亚". Requiring the counter keeps place names intact — rewriting
 * them would turn a destination into nonsense, which is worse than missing a
 * duration.
 */
function normalizeChineseNumerals(text: string): string {
  return text.replace(/[〇零一二两三四五六七八九十]+(?=\s*[天晚夜日号月人位个])/gu, (run) => {
    const tenIndex = run.indexOf("十");
    if (tenIndex === -1) {
      // A bare run of digits: 三 → 3. Multi-digit runs like 二〇 are read
      // positionally, which is how years are written.
      let value = 0;
      for (const char of run) {
        const digit = CHINESE_DIGITS[char];
        if (digit === undefined) return run;
        value = value * 10 + digit;
      }
      return String(value);
    }
    // 十 = 10, 十五 = 15, 三十 = 30, 三十五 = 35.
    const head = run.slice(0, tenIndex);
    const tail = run.slice(tenIndex + 1);
    if (head.length > 1 || tail.length > 1) return run;
    const tens = head === "" ? 1 : CHINESE_DIGITS[head];
    const ones = tail === "" ? 0 : CHINESE_DIGITS[tail];
    if (tens === undefined || ones === undefined) return run;
    return String(tens * 10 + ones);
  });
}

function extractDays(question: string): number | undefined {
  const match = question.match(/(?:\bfor\s+)?([1-9]\d{0,2})\s*(?:days?\b|天)/iu);
  const days = match ? Number(match[1]) : NaN;
  return days >= 1 && days <= 365 ? days : undefined;
}

/**
 * "Shanghai to Suzhou" — a route written without a verb, which the verb-led
 * patterns below cannot see. Only read at the very start of the turn, and only
 * when the left side is not itself a travel verb, so "go to Suzhou" keeps its
 * existing reading instead of proposing "go" as a departure city.
 */
const ROUTE_WITHOUT_VERB =
  /^\s*([A-Za-z][A-Za-z .'-]{0,63}?)\s+to\s+([A-Za-z][A-Za-z .'-]{0,63}?)(?=\s+(?:on|for|in|from|around|next|this)\b|[,.!?]|$)/iu;
/**
 * Checked against the LAST word of the left side, not the whole of it: "I want
 * to go to Kyoto" otherwise proposes "I want" as a departure city.
 */
const NOT_A_PLACE = /^(?:go|going|travel|travelling|traveling|visit|visiting|head|heading|fly|flying|get|getting|want|wants|wanted|like|would|plan|planning|hoping|hope|need|i|we|they|he|she|it|you|trip|trips|flight|flights|way|how|take|taking)$/i;

function routeWithoutVerb(question: string): { from: string; to: string } | null {
  const match = question.match(ROUTE_WITHOUT_VERB);
  if (!match) return null;
  const from = match[1].trim();
  const to = match[2].trim();
  const lastWord = from.split(/\s+/).at(-1) ?? "";
  if (!from || !to || NOT_A_PLACE.test(lastWord)) return null;
  return { from, to };
}

function extractDestination(question: string): string | undefined {
  const english = question.match(/\b(?:go|going|travel|travelling|traveling|visit|visiting|head|heading)\s+to\s+([A-Za-z][A-Za-z .'-]{0,63}?)(?=\s+(?:for\s+)?[1-9]\d{0,2}\s+days?\b|[,.!?]|$)/iu);
  // The activity verb terminates the destination whether or not a duration
  // follows it. It used to appear only inside the duration branch, so "去纽约玩，
  // 帮我规划15天" — where the 玩 is separated from its 天 by the rest of the
  // sentence — ran past it to the comma and proposed 纽约玩 as the city.
  const chinese = question.match(/(?:去|前往|想去|目的地(?:是|为)?)\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z .'-]{0,63}?)(?=\s*(?:玩|待|住|旅行)?\s*[1-9]\d{0,2}\s*天|\s*(?:玩|待|住|旅行)|[，。！？]|$)/u);
  const value = (english?.[1] ?? chinese?.[1] ?? routeWithoutVerb(question)?.to)
    ?.trim().replace(/\s+/g, " ");
  return value && value.length <= 64 ? value : undefined;
}

function extractDeparture(question: string): string | undefined {
  const english = question.match(/\bfrom\s+([A-Za-z][A-Za-z .'-]{0,63}?)(?=\s+(?:to|for|on)\b|[,.!?]|$)/iu);
  // "从上海出发" and the equally common "上海出发" — the 从 is optional in
  // speech, and requiring it silently dropped the departure city from the
  // acceptance case in docs/personal-and-planning-boundaries.md §9.
  // 从 is a boundary, never part of the city: "我从上海出发" must yield 上海.
  // The 从-led form is tried first so it wins over the bare form, which then
  // only has to cover "上海出发" — the 从 people leave out in speech.
  const chinese = question.match(/从\s*([\p{Script=Han}A-Za-z][^\s，。！？从]{0,63}?)\s*(?=出发|起飞)/u)
    ?? question.match(/(?:^|[，。！？\s])(?!从)([\p{Script=Han}A-Za-z][^\s，。！？从]{0,63}?)\s*(?=出发|起飞)/u)
    // A destination marker ends the departure city just as surely as 走 does.
    // Without them "我想从新加坡去纽约玩，…" ran to the comma and proposed the
    // whole route — 新加坡去纽约玩 — as the departure city, which then also put
    // the destination into the departure field on the brief card.
    ?? question.match(/从\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z .'-]{0,63}?)(?=\s*(?:走|去|到|往|飞)|[，。！？]|$)/u);
  const value = (english?.[1] ?? chinese?.[1] ?? routeWithoutVerb(question)?.from)
    ?.trim().replace(/\s+/g, " ");
  if (!value || value.length > 64) return undefined;
  // "就按 12 月 10 日出发" ends in 出发 too, and the bare form happily read the
  // 日 before it as a city. A departure city never contains a digit or a date
  // unit, and is never one character long in the phrasings this reads.
  if (/[0-9\u5e74\u6708\u65e5\u53f7\u5929]/u.test(value)) return undefined;
  if ([...value].length < 2) return undefined;
  return value;
}

/** Recognises explicit month/day input; relative wording is never made into a date fact. */
function extractDate(question: string): string | undefined {
  // An explicit ISO date is already the answer; no month-name table needed.
  const iso = question.match(/\b(20\d{2})-(1[0-2]|0[1-9])-(3[01]|[12]\d|0[1-9])\b/u);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const chinese = question.match(/(?:(20\d{2})\s*年\s*)?(1[0-2]|0?[1-9])\s*月\s*(3[01]|[12]\d|0?[1-9])\s*(?:日|号)?/u);
  const english = question.match(/\b(?:on\s+)?(?:(20\d{2})\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(3[01]|[12]\d|[1-9])\b/iu);
  if (!chinese && !english) return undefined;
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const yearText = chinese?.[1] ?? english?.[1];
  const month = chinese ? Number(chinese[2]) : months[english![2].toLowerCase()];
  const day = chinese ? Number(chinese[3]) : Number(english![3]);
  const now = new Date();
  let year = yearText ? Number(yearText) : now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return undefined;
  if (!yearText && candidate < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) year += 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
