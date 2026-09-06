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
// Visa / entry / passport.
//
// Mentioning one of these is not the problem; *deciding* one is. The rule used
// to reject any reply containing any of these words, which threw away ordinary
// planning answers — "remember to check the visa requirements", "make sure the
// passport has six months left", even "we can rest in the city after arrival"
// (入境). Since a Chinese itinerary almost always mentions travel preparation,
// the gate fired on the very turn where planning begins.
const VISA_TOPIC_TERMS = [
  "visa", "visas", "passport",
  "签证", "护照",
];
/**
 * Words that only sometimes mean entry policy. 入境 is ordinary itinerary
 * language for "after you arrive", so pairing it with a word as common as 可以
 * rejected "入境后可以先在市区休整一天" — a sentence about resting, not rules.
 * These need an unambiguous eligibility word before they count.
 */
const VISA_WEAK_TOPIC_TERMS = ["入境", "immigration", "entry"];
/**
 * Conclusions in their own right: naming one is asserting an outcome this
 * chat has no provider to stand behind, whatever surrounds it.
 */
const VISA_CONCLUSION_TERMS = [
  "visa-free", "visa free", "visa on arrival", "no visa required", "without a visa",
  "免签", "落地签", "无需签证", "不需要签证", "不用签证", "不用办签证",
];
/**
 * Words that turn a visa mention into a claim about the traveller's own
 * eligibility.
 */
const VISA_ASSERTION_TERMS = [
  "require", "requires", "required", "need", "needs", "must", "have to", "has to",
  "eligible", "eligibility", "exempt", "allowed", "can enter", "obtain a",
  "do not need", "don't need",
  "需要", "必须", "可以", "能够", "符合", "有资格", "不用", "无须", "无需", "办理",
];
/** The subset that carries eligibility on its own, with no help from context. */
const VISA_STRICT_ASSERTION_TERMS = [
  "require", "requires", "required", "need", "needs", "must", "have to", "has to",
  "eligible", "eligibility", "exempt", "do not need", "don't need",
  "需要", "必须", "符合", "有资格", "不用", "无须", "无需",
];
/**
 * Deferral wins over assertion. "Check the visa requirements before you go" and
 * "confirm with the destination's official guidance" contain requirement words
 * but decide nothing — they are the behaviour the product wants, and the point
 * of the rule is to leave the answer to an official source.
 */
const VISA_DEFERRAL_TERMS = [
  "check", "confirm", "verify", "official", "consulate", "embassy", "may vary",
  "确认", "核实", "核对", "查询", "查证", "以官方", "官方口径", "官网", "领事", "使馆", "为准", "自行",
];

/** True when the text decides a visa outcome rather than pointing at one. */
function assertsVisaOutcome(text: string): boolean {
  if (hasAnyTerm(text, VISA_CONCLUSION_TERMS)) return true;
  if (hasAnyTerm(text, VISA_DEFERRAL_TERMS)) return false;
  if (hasAnyTerm(text, VISA_TOPIC_TERMS)) return hasAnyTerm(text, VISA_ASSERTION_TERMS);
  if (hasAnyTerm(text, VISA_WEAK_TOPIC_TERMS)) return hasAnyTerm(text, VISA_STRICT_ASSERTION_TERMS);
  return false;
}

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

  // Asking about a visa is a fair question, and refusing it before the model
  // is even called meant a canned policy recital where the traveller wanted
  // help. The model answers now — the prompt requires it to say plainly that
  // this chat cannot confirm entry rules and to send them to the official
  // source — and the output gate below still stops it deciding anything.

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
  /**
   * True only for a server-issued follow-up after a confirmed Trip mutation.
   * Ordinary model conversation has no authority to claim that a requested
   * origin, destination, date, flight, or hotel change already happened.
   */
  tripMutationBacked?: boolean;
}

/**
 * Completion claims, matched against `normalizePolicyText` output.
 *
 * That normalizer strips every apostrophe and every sentence terminator, so
 * these patterns must be written for the stripped form: `I've` arrives as
 * `i ve`, and a `[^.!?]` window is really `.` — it spans the whole reply. Both
 * mistakes were live: the English rule never fired at all, and the Chinese one
 * matched across a full sentence, flagging 已经识别到这项行程修改 where 修改
 * is the noun "change" rather than a verb that happened.
 *
 * The Chinese rule therefore accepts a completion marker only when the verb
 * either follows it directly (已更新, 已为你保存) or carries a result marker
 * of its own (更新为, 保存好, 记录到). A verb sitting loose in a noun phrase
 * further along the sentence no longer counts.
 *
 * The window is `[^ ]` rather than `.` on purpose. The normalizer turns every
 * 。！？；、 into a single space, so refusing to cross one is what remains of
 * clause boundaries — without it the marker in 我已经识别到这项行程修改 reached
 * the 保存到 two clauses later, and the gate rejected its own replacement text.
 */
const CHINESE_TRIP_COMPLETION =
  /(?:已|已经|现已)(?:经)?(?:为你|帮你|替你|成功)?(?:把|将)?(?:(?:更新|修改|设置|保存|记录|设|改|列)|[^ ]{1,24}?(?:更新|修改|设置|保存|记录|设|改|列)(?:为|成|到|好|了|完))/u;
const ENGLISH_TRIP_COMPLETION =
  /\b(?:i|we)\s+(?:ve\s+|have\s+)?(?:now\s+|just\s+)?(?:updated|saved|set|recorded|changed)\b/u;
const ENGLISH_TRIP_COMPLETION_PASSIVE =
  /\b(?:trip|itinerary|destination|departure|origin|travel dates?|flight|hotel)\b.{0,80}?\b(?:has|have)\s+been\s+(?:updated|saved|set|recorded|changed)\b/u;

export function containsUnbackedTripMutationClaim(
  content: string,
  opts?: OperationalClaimOptions,
): boolean {
  if (opts?.tripMutationBacked === true) return false;
  const text = normalizePolicyText(content);
  const namesTripField = hasAnyTerm(text, [
    "trip", "itinerary", "destination", "departure", "origin", "travel date", "travel dates",
    "flight", "hotel", "行程", "旅行", "目的地", "出发地", "出发城市", "日期", "天数", "航班", "酒店",
  ]);
  if (!namesTripField) return false;
  return CHINESE_TRIP_COMPLETION.test(text) || ENGLISH_TRIP_COMPLETION.test(text)
    || ENGLISH_TRIP_COMPLETION_PASSIVE.test(text);
}

export function containsUnsupportedOperationalClaim(content: string, opts?: OperationalClaimOptions): boolean {
  const text = normalizePolicyText(content);
  const evidenceBacked = opts?.evidenceBacked === true;

  if (containsUnbackedTripMutationClaim(text, opts)) return true;

  // Chat has no authoritative visa provider, so it may not decide a visa
  // outcome. Naming one is fine — and necessary: travel preparation is part
  // of a plan. `assertsVisaOutcome` separates the two, and treats a deferral
  // to the official source as the safe answer it is.
  if (assertsVisaOutcome(text)) return true;

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

/**
 * The last resort, not the usual answer.
 *
 * This used to recite the policy — "cannot claim live prices, inventory, visa
 * conclusions, booking status or flight status" — which read as an accusation
 * about what the traveller had asked. Someone who typed "let's start planning"
 * was told the chat would not give them visa conclusions. The reply now speaks
 * only to the question at hand: the answer could not be established here, it
 * would not be reliable if guessed, and it is worth checking at the source.
 *
 * Reaching this at all means the model's own attempt was withheld, so the
 * prompt asks the model to say this in its own words first — see the
 * unverifiable-question rule in the conversation prompt.
 */
export function safeConversationRefusal(question?: string): ConversationReply {
  const chinese = question !== undefined && /[\p{Script=Han}]/u.test(question);
  return {
    content: chinese
      ? "这个我暂时没法在对话里给你一个靠得住的答案——就算给了也不一定准确，建议你再到官方渠道核实一下。行程本身我们可以继续往下聊。"
      : "I can't get you a reliable answer to that one here — anything I guessed might not be accurate, so it's worth confirming at the official source. We can keep going on the trip itself in the meantime.",
    responseMode: "SAFE_REFUSAL",
  };
}

/** A truthful replacement for an ordinary reply that claimed a Trip write. */
export function pendingTripMutationReply(question?: string): ConversationReply {
  const chinese = question !== undefined && /[\p{Script=Han}]/u.test(question);
  return {
    content: chinese
      ? "我已经识别到这项行程修改；请在下方确认卡片后再保存到本次行程。"
      : "I recognized that trip change. Please confirm the card below before it is saved to this trip.",
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
export function safeConversationFallback(locale: "en" | "zh" = "en"): ConversationReply {
  return {
    content: locale === "zh"
      ? "暂时无法连接对话模型，请稍后再试。"
      : "I can't reach the conversation model right now — please try again in a moment.",
    responseMode: "FALLBACK",
  };
}

/**
 * The degradation notice for a turn whose tools DID run. Only the summarising
 * model call failed, so the search itself completed and its results are already
 * persisted and rendered as offer cards. Reusing the generic "can't reach the
 * model" line here contradicts the cards sitting next to it on screen and hides
 * work that actually succeeded. Same safety boundary as above: it points at the
 * results without making any price / inventory claim of its own.
 */
export function evidenceBackedConversationFallback(locale: "en" | "zh" = "en"): ConversationReply {
  return {
    content: locale === "zh"
      ? "搜索已经完成，结果也已保存在下方，但我刚才没能生成总结；如果需要，我可以稍后再为你梳理。"
      : "Your search finished and the results below are saved, but I couldn't write the summary just now — please ask again if you'd like me to walk through them.",
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

/**
 * Three-letter currency codes have exactly the shape of a flight designator
 * followed by a number, so "CNY 691" read as a flight reference. Paired with
 * a hotel's own "不可取消" — which `FLIGHT_STATUS_TERMS` matches — that made
 * the flight-status rule refuse an evidence-backed hotel summary that
 * mentioned no flight at all. The same offers written "约 691 CNY/晚" passed,
 * so identical answers succeeded or failed on the model's phrasing alone.
 */
const CURRENCY_CODES = [
  "cny", "usd", "jpy", "eur", "gbp", "sgd", "hkd", "krw", "aud", "cad",
  "twd", "thb", "myr", "nzd", "chf", "idr", "php", "vnd", "inr", "rub",
];

function hasFlightReference(text: string): boolean {
  if (hasAnyTerm(text, ["flight", "flights", "航班", "班机"])) return true;
  // A real designator still counts: only the currency reading is excluded.
  for (const match of text.matchAll(/\b([a-z]{2,3})\s?\d{1,4}\b/gi)) {
    if (!CURRENCY_CODES.includes(match[1].toLowerCase())) return true;
  }
  return false;
}
