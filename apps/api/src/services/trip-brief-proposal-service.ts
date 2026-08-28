import type { ConversationPlace } from "../types/schemas.js";

export type TripBriefProposal = { destinationCandidates?: string[]; travelDays?: number };

/** Extracts only explicit, current-turn facts; never history or a persisted question. */
export function proposeTripBriefFromTurn(question: string, place?: ConversationPlace): TripBriefProposal | null {
  const travelDays = extractDays(question);
  const destination = place?.name.trim() || extractDestination(question);
  if (!destination && travelDays === undefined) return null;
  return { ...(destination ? { destinationCandidates: [destination] } : {}), ...(travelDays !== undefined ? { travelDays } : {}) };
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
