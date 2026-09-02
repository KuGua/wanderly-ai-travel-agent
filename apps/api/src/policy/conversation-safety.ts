import type { ConversationPlace } from "../types/schemas.js";
import type { ConversationReply } from "../providers/model-gateway.js";
import { getLocationReferenceSource } from "../location-reference/location-reference-source.js";

const PRICE_TERMS = [
  "price", "prices", "cost", "costs", "fare", "fares", "rate", "rates",
  // Chinese equivalents — captured by the input/output gate when a user asks
  // directly for current price/fare facts. The classifier recognizes the
  // research-request shape ("查酒店") and bypasses this gate for that path;
  // these terms fire only on non-classified chat turns.
  "价格", "票价", "多少钱", "几钱", "价位",
];
const LIVE_TERMS = [
  "current", "currently", "live", "real time", "today", "tonight", "now", "latest", "up to date",
  // Chinese: live data, schedule, on-time status.
  "现在", "今天", "今晚", "实时", "最新", "此时此刻", "班次", "时刻表",
];
const TRAVEL_INVENTORY_TERMS = [
  "flight", "flights", "hotel", "hotels", "room", "rooms", "seat", "seats",
  "ticket", "tickets", "stay", "stays", "inventory",
  // Chinese: travel-inventory objects whose current state is a provider fact.
  "航班", "班机", "酒店", "房", "座位", "票", "住宿", "客栈",
];
const AVAILABILITY_TERMS = [
  "availability", "available", "unavailable", "sold out", "vacancy", "vacancies", "vacant", "left",
  // Chinese: remaining-inventory phrases.
  "有空", "没空", "满了", "售罄", "剩余", "可订", "有房",
];
const SCHEDULE_TERMS = [
  "几点的", "几时", "什么时候", "几点", "几点钟",
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
const FLIGHT_STATUS_TERMS = [
  "status", "delayed", "delay", "late", "cancelled", "canceled", "on time", "departure gate", "arrival gate",
  // Chinese: flight on-time / disruption terms.
  "准点", "晚点", "延误", "起飞", "到达", "登机口", "取消",
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
   * `true` when the user's most recent message expresses "continue search"
   * intent (e.g. 「确认搜索」/「yes, search」/「go ahead」/「执行搜索」/「do it」).
   * The conversation worker sets this when it detects a confirmation
   * pattern, so the input-side safety filter does not block a legitimate
   * "go" reply that happens to mention a currency or inventory term.
   * When `userConfirmed === true`, the PRICE/LIVE/inventory and
   * AVAILABILITY/inventory rules are bypassed (the model's prose can
   * safely describe the upcoming tool call); visa, booking-status and
   * flight-status rules still fire.
   */
  userConfirmed?: boolean;
}

export function requestsUnsupportedOperationalFacts(question: string, opts?: OperationalRequestOptions): boolean {
  const text = normalizePolicyText(question);
  const userConfirmed = opts?.userConfirmed === true;

  if (hasAnyTerm(text, VISA_TERMS)) return true;
  if (
    hasAnyTerm(text, ["entry", "enter", "immigration", "passport"])
    && hasAnyTerm(text, ENTRY_RULE_TERMS)
  ) return true;

  if (!userConfirmed) {
    if (
      hasAnyTerm(text, PRICE_TERMS)
      && (hasAnyTerm(text, [...LIVE_TERMS, ...TRAVEL_INVENTORY_TERMS]) || hasTerm(text, "how much") || hasTerm(text, "多少钱"))
    ) return true;
    if (hasTerm(text, "how much") && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
    if (hasTerm(text, "exchange rate") && hasAnyTerm(text, LIVE_TERMS)) return true;

    if (hasAnyTerm(text, AVAILABILITY_TERMS) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
    if (hasAnyTerm(text, ["are there", "is there"]) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
    if (hasAnyTerm(text, ["还有", "有空", "有房"]) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
    // Live-data schedule questions ("今天航班几点的", "今晚酒店几点开门") are
    // operational facts and must be refused even without a price/booking verb.
    if (hasAnyTerm(text, LIVE_TERMS) && hasAnyTerm(text, SCHEDULE_TERMS)) return true;
  }

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
   * `true` only when a `personal_research_evidence` row exists for the
   * current run — the conversation worker dispatches the tool and persists
   * the evidence before calling back into the gateway for the final answer.
   * In that state, the LLM is allowed to surface prices / availability
   * figures backed by the tool result; all other rules (visa, booking
   * status, flight status, schedule) keep firing unconditionally.
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

  if (!evidenceBacked) {
    if (
      hasAnyTerm(text, PRICE_TERMS)
      && (hasCurrencyValue(text) || hasNumericValue(text) || hasAnyTerm(text, [...LIVE_TERMS, "starts at", "from", "around", "approximately"]))
    ) return true;
    if (hasCurrencyValue(text) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
    if (hasAnyTerm(text, AVAILABILITY_TERMS) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
  }

  // Booking status means the state of a reservation the traveller holds. A
  // rate's cancellation terms are a property of the offer — "free
  // cancellation until the 30th", "non-refundable" — and describing one is
  // not claiming an order exists. Evidence-backed replies quote those terms
  // verbatim from the supplier, so the rule needs the traveller's own
  // booking in view, not merely the word "cancel" anywhere in the answer.
  const mentionsCancellationTerms = evidenceBacked
    && hasAnyTerm(text, CANCELLATION_POLICY_TERMS);
  if (
    !mentionsCancellationTerms
    && hasAnyTerm(text, ["booking", "bookings", "reservation", "reservations", "已订", "已确认", "待确认", "取消"])
    && hasAnyTerm(text, BOOKING_STATUS_TERMS)
  ) return true;

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

function hasCurrencyValue(text: string): boolean {
  return /(?:[$€£¥]\s?\d|\b\d[\d,.]*\s+(?:usd|eur|gbp|jpy|cny|sgd|dollars?|euros?|yen)\b)/i.test(text);
}

function hasNumericValue(text: string): boolean {
  return /\b\d[\d,.]*\b/.test(text);
}

function hasFlightReference(text: string): boolean {
  return hasAnyTerm(text, ["flight", "flights", "航班", "班机"])
    || /\b[a-z]{2,3}\s?\d{1,4}\b/i.test(text);
}
