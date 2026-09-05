import type { ConversationPlace } from "../types/schemas.js";
import { getLocationReferenceResolver } from "../location-reference/location-reference-resolver.js";
import { isValidTripDate } from "./trip-title-service.js";

export type TripBriefProposal = {
  departureCities?: string[];
  destinationCandidates?: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
  travelDays?: number;
};

/** Why a proposal's dates were kept or dropped. Doubles as a metric label. */
export type BriefDateCoherence = "ok" | "end_before_start" | "in_past" | "malformed";

/**
 * Drops a date pair that cannot be true, keeping the rest of the proposal.
 *
 * A brief is assembled from two sources that never see each other: this file
 * parses the owner's own words, and a model supplies only what the owner
 * accepted from the assistant in the same turn. Neither validated the other,
 * so "10月1号到10月7号" became a start of 2026-10-01 from here and an end of
 * 2024-10-07 from the model — a card that answered 400 on every click, with
 * no way for the traveller to correct it. The past-date case is the same
 * fault landing on the other side of the write boundary: it validates, saves
 * silently, and titles the trip "行程规划｜1天".
 *
 * Only proposals pass through here. A creator editing the brief by hand is a
 * stated fact, not a guess, and is left to the route's own validation.
 */
export function coherentBriefDates(
  proposal: TripBriefProposal,
  now: Date = new Date(),
): { proposal: TripBriefProposal; result: BriefDateCoherence } {
  const { travelDateStart: start, travelDateEnd: end } = proposal;
  if (!start && !end) return { proposal, result: "ok" };
  const withoutDates = { ...proposal };
  delete withoutDates.travelDateStart;
  delete withoutDates.travelDateEnd;
  const drop = (result: BriefDateCoherence) => ({ proposal: withoutDates, result });

  if ((start && !isValidTripDate(start)) || (end && !isValidTripDate(end))) return drop("malformed");
  // ISO dates compare correctly as strings, which is also how the route and
  // the database order them.
  if (start && end && end < start) return drop("end_before_start");
  const today = now.toISOString().slice(0, 10);
  if ((start ?? end)! < today) return drop("in_past");
  return { proposal, result: "ok" };
}

/**
 * Combines verified owner text with the narrow scheduling facts that a model
 * may return after the owner accepts a same-turn assistant suggestion. Model
 * output is deliberately unable to create a place or departure fact.
 */
export function mergeTripBriefProposal(
  direct: TripBriefProposal | null,
  assistantAcceptance: TripBriefProposal | undefined,
  now: Date = new Date(),
): TripBriefProposal | undefined {
  const schedulingOnly = assistantAcceptance ? {
    ...(assistantAcceptance.travelDateStart ? { travelDateStart: assistantAcceptance.travelDateStart } : {}),
    ...(assistantAcceptance.travelDateEnd ? { travelDateEnd: assistantAcceptance.travelDateEnd } : {}),
    ...(assistantAcceptance.travelDays !== undefined ? { travelDays: assistantAcceptance.travelDays } : {}),
  } : {};
  // Guarded after the merge, not before: the contradiction only exists once
  // the two sources are side by side.
  const { proposal: merged } = coherentBriefDates({ ...schedulingOnly, ...direct }, now);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Folds this turn's proposal into the one the trip is already carrying.
 *
 * A brief is often given across several turns, so the card is a running
 * review of all of them — but that also means a start date from one turn can
 * meet an end date from another, and the pair has to hold together before it
 * is persisted. Returns `null` when nothing survives, which the caller stores
 * as a cleared proposal.
 */
export function mergePendingBriefProposal(
  existing: TripBriefProposal | null | undefined,
  incoming: TripBriefProposal,
  now: Date = new Date(),
): { proposal: TripBriefProposal | null; result: BriefDateCoherence } {
  const { proposal, result } = coherentBriefDates({ ...existing, ...incoming }, now);
  return { proposal: Object.keys(proposal).length > 0 ? proposal : null, result };
}

/** What the trip has already committed, for `withoutSettledFields` to subtract. */
export interface SettledTripBrief {
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart: string | null;
  travelDateEnd: string | null;
  travelDays: number | null;
}

function sameStrings(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const settled = new Set(b.map((value) => value.toLowerCase()));
  return a.every((value) => settled.has(value.toLowerCase()));
}

/**
 * Strips everything the trip already agreed to, so the review card only ever
 * asks about something the traveller has not already answered.
 *
 * The extractor fires on any one of departure, destination, dates or duration,
 * so a turn that merely repeats a settled fact still produced a proposal — and
 * a proposal is what raises the card. A traveller who had already saved Gero
 * and a 10-day length was asked "你想将这里作为目的地吗？" again, with no
 * destination in the proposal at all to name, purely because the turn happened
 * to mention "10天" a second time.
 *
 * Returns `null` when nothing new survives, which the caller stores as a
 * cleared proposal and never publishes.
 */
export function withoutSettledFields(
  proposal: TripBriefProposal | null,
  settled: SettledTripBrief,
): TripBriefProposal | null {
  if (!proposal) return null;
  const next: TripBriefProposal = { ...proposal };
  if (sameStrings(next.departureCities, settled.departureCities)) delete next.departureCities;
  if (sameStrings(next.destinationCandidates, settled.destinationCandidates)) delete next.destinationCandidates;
  if (next.travelDateStart && next.travelDateStart === settled.travelDateStart) delete next.travelDateStart;
  if (next.travelDateEnd && next.travelDateEnd === settled.travelDateEnd) delete next.travelDateEnd;
  if (next.travelDays !== undefined && next.travelDays === settled.travelDays) delete next.travelDays;
  return Object.keys(next).length > 0 ? next : null;
}

/** Extracts only explicit, current-turn facts; never history or a persisted question. */
export function proposeTripBriefFromTurn(
  question: string,
  place?: ConversationPlace,
  now: Date = new Date(),
): TripBriefProposal | null {
  // Chinese durations are written in Chinese numerals far more often than in
  // digits — "玩三天", not "玩3天". Normalizing first means every pattern below
  // reads one alphabet instead of two, and fixes the duration and the
  // destination together: the destination pattern ends at the duration, so a
  // duration it cannot see is a duration the destination swallows whole.
  const text = normalizeChineseNumerals(question);
  const travelDays = extractDays(text);
  // A conversational noun is not a destination until the server can resolve
  // it to one unambiguous city. In particular this keeps pronouns ("me") and
  // prose fragments from reaching the review card merely because they followed
  // the word "to". The canonical city label is also what the draft-brief
  // write boundary persists, so the preview cannot promise a different place
  // from the one planning later receives.
  const destination = resolveBriefDestination(place?.name.trim() || extractDestination(text));
  const departure = extractDeparture(text);
  const dates = extractDateRange(text, now);
  if (!departure && !destination && !dates && travelDays === undefined) return null;
  return {
    ...(departure ? { departureCities: [departure] } : {}),
    ...(destination ? { destinationCandidates: [destination] } : {}),
    ...(dates ? { travelDateStart: dates.start } : {}),
    ...(dates?.end ? { travelDateEnd: dates.end } : {}),
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
  // A bare "A to B" is intentionally supported for itinerary notation, but
  // only when *both* sides are known places. Without this check, ordinary
  // English such as "Introduce Shanghai to me" becomes a fabricated route.
  if (!from || !to || NOT_A_PLACE.test(lastWord)
    || !resolveBriefDestination(from) || !resolveBriefDestination(to)) return null;
  return { from, to };
}

/**
 * Converts a user-facing city spelling to the server-owned canonical city
 * label. `null` is a normal, fail-closed result for unknown or ambiguous
 * text; callers must not substitute a model or browser value.
 */
export function resolveBriefDestination(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const reference = getLocationReferenceResolver().resolveDestinationReference({
      destinationId: candidate,
      cityName: candidate,
    });
    return reference?.cityName;
  } catch {
    // The reference dataset is an allow-list, never an availability
    // dependency for chat. If it cannot load, decline the proposal rather
    // than failing the whole conversation or accepting unverified text.
    return undefined;
  }
}

/**
 * Final write-boundary normalizer for draft-brief destination input.
 * Every submitted candidate must resolve, including values supplied by a
 * stale client or a caller that did not originate from the conversation UI.
 */
export function normalizeBriefDestinations(candidates: string[]): string[] | null {
  const normalized: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolveBriefDestination(candidate);
    if (!resolved) return null;
    if (!normalized.some((existing) => existing.localeCompare(resolved, undefined, { sensitivity: "accent" }) === 0)) {
      normalized.push(resolved);
    }
  }
  return normalized;
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

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_NAME_PATTERN = "January|February|March|April|May|June|July|August|September|October|November|December";
/**
 * What separates the two ends of a spoken range. A bare hyphen is included
 * for "10月1号-7号"; the ISO pattern below requires whitespace around it so a
 * hyphen inside `2026-10-01` is never read as the connector.
 */
const RANGE_CONNECTOR = "(?:到|至|–|—|~|～|-|\\bto\\b|\\btill\\b|\\bthrough\\b)";

/** A month/day the text stated. `month` is absent in the tail of "10月1号到7号". */
type DateParts = { year?: number; month?: number; day: number };

const ISO_RANGE = new RegExp(
  `\\b(20\\d{2})-(1[0-2]|0[1-9])-(3[01]|[12]\\d|0[1-9])\\b\\s*(?:到|至|–|—|~|～|\\s-\\s|\\bto\\b|\\btill\\b|\\bthrough\\b)\\s*\\b(20\\d{2})-(1[0-2]|0[1-9])-(3[01]|[12]\\d|0[1-9])\\b`,
  "u",
);
const CHINESE_RANGE = new RegExp(
  "(?:(20\\d{2})\\s*年\\s*)?(1[0-2]|0?[1-9])\\s*月\\s*(3[01]|[12]\\d|0?[1-9])\\s*(?:日|号)?"
  + `\\s*${RANGE_CONNECTOR}\\s*`
  + "(?:(20\\d{2})\\s*年\\s*)?(?:(1[0-2]|0?[1-9])\\s*月\\s*)?(3[01]|[12]\\d|0?[1-9])\\s*(?:日|号)",
  "u",
);
const ENGLISH_RANGE = new RegExp(
  `\\b(?:on\\s+)?(?:(20\\d{2})\\s+)?(${MONTH_NAME_PATTERN})\\s+(3[01]|[12]\\d|[1-9])\\b`
  + `\\s*${RANGE_CONNECTOR}\\s*`
  + `(?:(20\\d{2})\\s+)?(?:(${MONTH_NAME_PATTERN})\\s+)?(3[01]|[12]\\d|[1-9])\\b`,
  "iu",
);

/**
 * Recognises explicit month/day input, as one date or as a range; relative
 * wording is never made into a date fact.
 *
 * The range half exists because the end date used to have only one possible
 * source — a model with no idea what year it was, which answered 2024 to
 * "10月1号到10月7号". When the owner writes both ends themselves, neither one
 * should have to be guessed.
 */
function extractDateRange(question: string, now: Date): { start: string; end?: string } | undefined {
  const range = matchDateRange(question);
  if (range) {
    const start = resolveDate(range.start, now);
    // Both ends of a spoken range live in one stretch of time: the end takes
    // the start's year unless that would put it first, which is how a New
    // Year range ("12月28号到1月3号") crosses into the next year.
    const end = start && resolveDate(
      { month: range.start.month, ...range.end },
      now,
      start,
    );
    if (start) return { start, ...(end && end >= start ? { end } : {}) };
  }
  const single = matchSingleDate(question);
  const start = single && resolveDate(single, now);
  return start ? { start } : undefined;
}

function matchDateRange(question: string): { start: DateParts; end: DateParts } | undefined {
  const iso = question.match(ISO_RANGE);
  if (iso) {
    return {
      start: { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) },
      end: { year: Number(iso[4]), month: Number(iso[5]), day: Number(iso[6]) },
    };
  }
  const chinese = question.match(CHINESE_RANGE);
  if (chinese) {
    return {
      start: { ...optionalYear(chinese[1]), month: Number(chinese[2]), day: Number(chinese[3]) },
      end: {
        ...optionalYear(chinese[4]),
        ...(chinese[5] ? { month: Number(chinese[5]) } : {}),
        day: Number(chinese[6]),
      },
    };
  }
  const english = question.match(ENGLISH_RANGE);
  if (!english) return undefined;
  return {
    start: { ...optionalYear(english[1]), month: MONTH_NAMES[english[2].toLowerCase()], day: Number(english[3]) },
    end: {
      ...optionalYear(english[4]),
      ...(english[5] ? { month: MONTH_NAMES[english[5].toLowerCase()] } : {}),
      day: Number(english[6]),
    },
  };
}

function matchSingleDate(question: string): DateParts | undefined {
  // An explicit ISO date is already the answer; no month-name table needed.
  const iso = question.match(/\b(20\d{2})-(1[0-2]|0[1-9])-(3[01]|[12]\d|0[1-9])\b/u);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const chinese = question.match(/(?:(20\d{2})\s*年\s*)?(1[0-2]|0?[1-9])\s*月\s*(3[01]|[12]\d|0?[1-9])\s*(?:日|号)?/u);
  if (chinese) return { ...optionalYear(chinese[1]), month: Number(chinese[2]), day: Number(chinese[3]) };
  const english = question.match(new RegExp(`\\b(?:on\\s+)?(?:(20\\d{2})\\s+)?(${MONTH_NAME_PATTERN})\\s+(3[01]|[12]\\d|[1-9])\\b`, "iu"));
  if (!english) return undefined;
  return { ...optionalYear(english[1]), month: MONTH_NAMES[english[2].toLowerCase()], day: Number(english[3]) };
}

function optionalYear(text: string | undefined): { year?: number } {
  return text ? { year: Number(text) } : {};
}

/**
 * Turns stated parts into an ISO date. A year the owner did not give is the
 * one that puts the date next in the future — never a past year, which is the
 * answer a model reaches for when it has only its training data to go on.
 *
 * `notBefore` anchors the tail of a range to its own head rather than to today.
 */
function resolveDate(parts: DateParts, now: Date, notBefore?: string): string | undefined {
  const { month, day } = parts;
  if (month === undefined) return undefined;
  const floor = notBefore ?? now.toISOString().slice(0, 10);
  let year = parts.year ?? Number(floor.slice(0, 4));
  const iso = (value: number) => `${value}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const real = (value: number) => {
    const candidate = new Date(Date.UTC(value, month - 1, day));
    return candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
  };
  if (!real(year)) {
    // 2月29日 in a year the owner did not choose is a leap day one year away,
    // not an invalid date — try the rollover before rejecting it.
    if (parts.year !== undefined || !real(year + 1)) return undefined;
    return iso(year + 1);
  }
  if (parts.year === undefined && iso(year) < floor) year += 1;
  return real(year) ? iso(year) : undefined;
}
