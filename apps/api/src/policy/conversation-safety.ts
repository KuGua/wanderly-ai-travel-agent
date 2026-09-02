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
/**
 * Phrases that describe what a rate allows, not what an order is doing.
 * Only consulted for an evidence-backed reply, where the wording came from
 * the supplier's own cancellation policy.
 */
const CANCELLATION_POLICY_TERMS = [
  "free cancellation", "non-refundable", "nonrefundable", "refundable",
  "cancellation policy", "cancellation until", "cancel by", "cancel before",
  "免费取消", "可免费取消", "不可退款", "不可退订", "可退款", "可取消", "退订政策",
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
   * No longer gates the price/availability check — that gate was removed
   * (demo-scope simplification: the model may state prices / availability in
   * prose regardless of whether a tool call backs it this turn). Still read,
   * narrowly, to admit a supplier's own cancellation-policy wording in the
   * booking-status check below — see `CANCELLATION_POLICY_TERMS`. Visa and
   * flight-status rules never consult this flag.
   */
  evidenceBacked?: boolean;
}

export function containsUnsupportedOperationalClaim(content: string, opts?: OperationalClaimOptions): boolean {
  const text = normalizePolicyText(content);
  const evidenceBacked = opts?.evidenceBacked === true;

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

  // The standalone price/availability gate was removed on purpose (demo-scope
  // simplification, explicit request): the model may state prices, fares and
  // availability in prose regardless of whether a tool call backs them this
  // turn. `PRICE_TERMS`/`AVAILABILITY_TERMS`/`LIVE_TERMS` and the numeric/
  // currency helpers that only fed that gate were removed with it.
  //
  // The booking-status check below is a SEPARATE rule and stays: it is not
  // about prices, it is about the model claiming a status of the traveller's
  // OWN reservation ("您的预订已确认") that never happened in this chat.
  // Booking status means the state of a reservation the traveller holds. A
  // rate's cancellation terms are a property of the offer — "free
  // cancellation until the 30th", "non-refundable" — and describing one is
  // not claiming an order exists. Evidence-backed replies quote those terms
  // verbatim from the supplier, so the rule needs the traveller's own
  // booking in view, not merely the word "cancel" anywhere in the answer
  // (which is what made a normal multi-offer summary — "提供免费取消政策" in
  // one bullet, "预订政策为不可退款" in another — false-positive before).
  const mentionsCancellationTerms = evidenceBacked
    && hasAnyTerm(text, CANCELLATION_POLICY_TERMS);
  if (
    !mentionsCancellationTerms
    && hasAnyTerm(text, ["booking", "bookings", "reservation", "reservations", "已订", "已确认", "待确认", "取消"])
    && hasAnyTerm(text, BOOKING_STATUS_TERMS)
  ) return true;

  return hasFlightReference(text) && hasAnyTerm(text, FLIGHT_STATUS_TERMS);
}

export function safeConversationRefusal(question?: string): ConversationReply {
  const chinese = question !== undefined && /[\p{Script=Han}]/u.test(question);
  return {
    content: chinese
      ? "我可以协助整理旅行想法和确认规划条件，但不能在对话中声称实时价格、库存、签证结论、预订状态或航班动态。你的查询条件已收到；确认行程信息后即可在受控流程中生成完整方案。"
      : "I can help organize travel ideas and confirm planning details, but this chat cannot claim live prices, inventory, visa conclusions, booking status, or flight status. Your search details are noted; once the trip details are confirmed, Wanderly can generate a complete plan through its controlled planning flow.",
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
