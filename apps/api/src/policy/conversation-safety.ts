import type { ConversationPlace } from "../types/schemas.js";
import type { ConversationReply } from "../providers/model-gateway.js";
import { getLocationReferenceSource } from "../location-reference/location-reference-source.js";

const TRAVEL_INVENTORY_TERMS = [
  "flight", "flights", "hotel", "hotels", "room", "rooms", "seat", "seats",
  "ticket", "tickets", "stay", "stays", "inventory",
  // Chinese: travel-inventory objects whose current state is a provider fact.
  "航班", "班机", "酒店", "房", "座位", "票", "住宿", "客栈",
];
const BOOKING_STATUS_TERMS = [
  "availability", "available", "status", "confirmed", "confirmation", "pending", "cancelled", "canceled",
  // Chinese: booking-status verbs.
  "已订", "已确认", "待确认", "取消", "退订", "改签",
];
// Genuine real-time flight STATUS words only (delayed/on-time/cancelled).
// Deliberately excludes generic schedule words like "起飞"/"到达" (depart/
// arrive) — those describe a flight's scheduled time, which is legitimate
// content a completed flight.search result can answer; only its *current*
// on-time/delayed/cancelled status is unverifiable here.
const FLIGHT_STATUS_TERMS = [
  "status", "delayed", "delay", "late", "cancelled", "canceled", "on time",
  // Chinese: flight on-time / disruption terms.
  "准点", "晚点", "延误", "取消",
];
// Visa / entry / passport — a closed set that has no provider path. Both
// English and Chinese forms must be intercepted on the input and output sides.
const VISA_TERMS = [
  "visa", "visas",
  "签证", "护照", "入境", "免签", "落地签",
];
const ENTRY_RULE_TERMS = [
  "rule", "rules", "require", "requires", "required", "requirement", "requirements",
  "need", "needs", "eligible", "eligibility", "valid", "allowed", "without",
  // Chinese: requirement / eligibility phrasing.
  "需要", "要求", "必须", "能不能", "可以", "允许", "资格",
];

export async function resolveConversationPlace(place: ConversationPlace | undefined): Promise<ConversationPlace | undefined> {
  if (!place) return undefined;

  try {
    const reference = await getLocationReferenceSource().resolve(place.latitude, place.longitude);
    if (reference.outcome === "REFERENCE") {
      return {
        sourceId: [reference.countryCode, reference.admin1Code, reference.nearestCity]
          .filter((value): value is string => Boolean(value))
          .join(":") || undefined,
        name: reference.nearestCity ?? reference.country,
        latitude: place.latitude,
        longitude: place.longitude,
        sourceType: "REFERENCE",
      };
    }
  } catch {
    // Soft-degrade to INSPIRATION on any source failure (resolver throw, sidecar
    // down/timeout/schema-drift, or disabled mode). Documented in
    // `apps/api/src/location-reference/SIDECAR.md` §"Failure modes".
  }

  return {
    ...place,
    sourceType: "INSPIRATION",
  };
}

export interface OperationalRequestOptions extends OperationalClaimOptions {
  /**
   * Unused — the price/live/inventory/availability gate this flag used to
   * bypass was removed (demo-scope simplification). Kept only so existing
   * call sites don't need to change.
   */
  userConfirmed?: boolean;
}

export function requestsUnsupportedOperationalFacts(question: string, opts?: OperationalRequestOptions): boolean {
  const text = normalizePolicyText(question);
  void opts;

  if (hasAnyTerm(text, VISA_TERMS)) return true;
  if (
    hasAnyTerm(text, ["entry", "enter", "immigration", "passport"])
    && hasAnyTerm(text, ENTRY_RULE_TERMS)
  ) return true;

  if (
    hasAnyTerm(text, ["booking", "bookings", "reservation", "reservations", "预订", "订"])
    && hasAnyTerm(text, BOOKING_STATUS_TERMS)
  ) return true;
  if (
    hasAnyTerm(text, ["book", "booking", "bookings", "reserve", "reservation", "reservations", "订", "预订"])
    && hasAnyTerm(text, [...TRAVEL_INVENTORY_TERMS, "this", "it", "now", "现在", "今天"])
  ) return true;
  // Chinese booking-status questions ("已确认机票") need their own rule
  // because the booking-verb + status-term gate does not fire when only
  // the status word is present.
  if (
    hasAnyTerm(text, ["已确认", "已订", "待确认", "退订", "改签"])
    && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)
  ) return true;

  return hasFlightReference(text) && hasAnyTerm(text, FLIGHT_STATUS_TERMS);
}

export interface OperationalClaimOptions {
  /**
   * Unused — the price/availability gate this flag used to unlock was
   * removed (demo-scope simplification: the model may now state prices /
   * availability in prose regardless of whether a tool call backs it this
   * turn). Kept only so existing call sites don't need to change. Visa,
   * booking-status and flight-status rules still fire unconditionally.
   */
  evidenceBacked?: boolean;
}

export function containsUnsupportedOperationalClaim(content: string, opts?: OperationalClaimOptions): boolean {
  const text = normalizePolicyText(content);
  void opts;

  // Chat has no authoritative visa provider path. Conservatively reject every
  // MODEL response that introduces visa facts, including unfamiliar phrasing.
  if (hasAnyTerm(text, VISA_TERMS)) return true;
  if (
    hasAnyTerm(text, ["entry", "enter", "immigration", "passport"])
    && hasAnyTerm(text, [
      "require", "requires", "required", "requirement", "requirements", "need", "needs", "must",
      "eligible", "eligibility", "ineligible", "allowed", "not allowed", "valid", "invalid", "without",
      "需要", "要求", "必须", "资格",
    ])
  ) return true;

  // The booking-status output check was removed (demo-scope simplification):
  // it matched topic words ("预订"/booking) and status words ("取消"/cancel)
  // anywhere in the WHOLE reply independently, so a normal multi-offer
  // summary describing each hotel's own cancellation policy ("提供免费取消
  // 政策" in one bullet, "预订政策为不可退款" in another) would false-positive
  // as the model claiming a status about the user's OWN booking, when it was
  // just describing third-party offers' policies — exactly what topOffers is
  // for. The narrower concern (the model claiming "您的预订已确认" about a
  // booking transaction that never happened here) hasn't been observed and
  // is a hallucination-prevention nicety, not a safety boundary.

  return hasFlightReference(text) && hasAnyTerm(text, FLIGHT_STATUS_TERMS);
}

export function safeConversationRefusal(): ConversationReply {
  return {
    content:
      "I can help with general destination inspiration and qualitative comparisons, but this chat cannot verify current prices, inventory or availability, visa or entry requirements, booking status, flight status, or other real-time provider facts. Please check the relevant official provider or government source.",
    responseMode: "SAFE_REFUSAL",
  };
}

/**
 * Returned when the LLM gateway exhausted its retry budget on transient
 * upstream errors. Distinct from `SAFE_REFUSAL` (which is policy-driven):
 * `FALLBACK` means "the model never produced a usable answer" and the UI is
 * expected to surface this as a system-degradation notice rather than treat
 * it as a model response. Content respects the same safety boundary as the
 * system prompt (no price / inventory / visa / booking / flight-status claims).
 */
export function safeConversationFallback(): ConversationReply {
  return {
    content: "I can't reach the conversation model right now — please try again in a moment.",
    responseMode: "FALLBACK",
  };
}

function normalizePolicyText(value: string): string {
  // NFKC collapses variant kanji + half-width digits into canonical form.
  // Chinese / Japanese terms are matched by substring (see `hasTerm`) so we
  // intentionally do NOT insert artificial spaces between CJK characters —
  // doing so would fragment multi-character terms like "签证" into
  // "签 证" and break detection.
  return value.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$€£¥]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTerm(text: string, term: string): boolean {
  // Chinese (CJK) terms use substring matching because Chinese has no
  // inter-word spaces; the term "签证" must match "我需要签证" even though
  // there's no space around it. English / Latin terms keep the
  // space-bounded semantics so "visa" does not match "television".
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)) {
    return text.includes(term);
  }
  return ` ${text} `.includes(` ${term} `);
}

function hasAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some(term => hasTerm(text, term));
}

function hasFlightReference(text: string): boolean {
  return hasAnyTerm(text, ["flight", "flights", "航班", "班机"])
    || /\b[a-z]{2,3}\s?\d{1,4}\b/i.test(text);
}
