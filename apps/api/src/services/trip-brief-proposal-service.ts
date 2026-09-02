import type { ConversationPlace } from "../types/schemas.js";

export type TripBriefProposal = {
  departureCities?: string[];
  destinationCandidates?: string[];
  travelDateStart?: string;
  travelDays?: number;
};

/** Extracts only explicit, current-turn facts; never history or a persisted question. */
export function proposeTripBriefFromTurn(question: string, place?: ConversationPlace): TripBriefProposal | null {
  const travelDays = extractDays(question);
  const destination = place?.name.trim() || extractDestination(question);
  const departure = extractDeparture(question);
  const travelDateStart = extractDate(question);
  if (!departure && !destination && !travelDateStart && travelDays === undefined) return null;
  return {
    ...(departure ? { departureCities: [departure] } : {}),
    ...(destination ? { destinationCandidates: [destination] } : {}),
    ...(travelDateStart ? { travelDateStart } : {}),
    ...(travelDays !== undefined ? { travelDays } : {}),
  };
}

function extractDays(question: string): number | undefined {
  const match = question.match(/(?:\bfor\s+)?([1-9]\d{0,2})\s*(?:days?\b|天)/iu);
  const days = match ? Number(match[1]) : NaN;
  return days >= 1 && days <= 365 ? days : undefined;
}

function extractDestination(question: string): string | undefined {
  const english = question.match(/\b(?:go|going|travel|travelling|traveling|visit|visiting|head|heading)\s+to\s+([A-Za-z][A-Za-z .'-]{0,63}?)(?=\s+(?:for\s+)?[1-9]\d{0,2}\s+days?\b|[,.!?]|$)/iu);
  const chinese = question.match(/(?:去|前往|想去|目的地(?:是|为)?)\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z .'-]{0,63}?)(?=\s*(?:玩|待|住|旅行)?\s*[1-9]\d{0,2}\s*天|[，。！？]|$)/u);
  const value = (english?.[1] ?? chinese?.[1])?.trim().replace(/\s+/g, " ");
  return value && value.length <= 64 ? value : undefined;
}

function extractDeparture(question: string): string | undefined {
  const english = question.match(/\bfrom\s+([A-Za-z][A-Za-z .'-]{0,63}?)(?=\s+(?:to|for|on)\b|[,.!?]|$)/iu);
  const chinese = question.match(/从\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z .'-]{0,63}?)(?=\s*(?:出发|走)|[，。！？]|$)/u);
  const value = (english?.[1] ?? chinese?.[1])?.trim().replace(/\s+/g, " ");
  return value && value.length <= 64 ? value : undefined;
}

/** Recognises explicit month/day input; relative wording is never made into a date fact. */
function extractDate(question: string): string | undefined {
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
