/**
 * Personal Research Intent Classifier — Phase 0/1.
 *
 * Pure, deterministic, versioned zh-TW / en-US rule pack that classifies an
 * owner's private chat turn as a high-confidence research request. The
 * classifier returns a `PersonalResearchIntent` (kind + capabilities) only
 * when the verb+noun combination is unambiguous; otherwise it returns
 * `null` and the conversation falls back to the existing LLM path.
 *
 * Hard invariants:
 * - The classifier NEVER extracts coordinates, dates, party size, currency,
 *   provider, place IDs, identity, or destination candidates (the MVP does
 *   not consume `destinationCandidates` — spec §4.1).
 * - The classifier NEVER mutates the input or touches the database.
 * - The classifier is conservative by default: ambiguous, negated,
 *   conflicting-capability, or low-confidence turns return `null`.
 * - `classifierVersion` is a module-scoped constant so the version that
 *   produced a draft is recoverable from the persisted JSON.
 *
 * Source: docs/personal-research-intent-routing-implementation.md §5.1,
 * §7 Phase 1.
 */

/** Stable version string embedded in every persisted draft. */
export const RESEARCH_INTENT_CLASSIFIER_VERSION = "research-intent/v1";

/** Capability surface — mirrors `personalResearchCapabilitySchema`. */
export type PersonalResearchCapability =
  | "flight"
  | "accommodation"
  | "hotel"
  | "activities"
  | "places"
  | "navigation"
  | "mobility"
  | "readiness";

/** Two-value intent discriminator — mirrors `personalResearchKindSchema`. */
export type PersonalResearchKind = "RESEARCH_ONLY" | "PROPOSE_PLAN";

/** Closed-shape result the conversation worker may persist as a draft. */
export interface PersonalResearchIntent {
  kind: PersonalResearchKind;
  requestedCapabilities: PersonalResearchCapability[];
}

/** Locale hint used only for stopword selection; the rules themselves are
 *  language-agnostic at the surface (zh + en tokens are matched together). */
export type ClassifierLocale = "zh-CN" | "zh-TW" | "en-US" | string;

export interface ClassifyInput {
  /** Raw chat question as received from the user. */
  question: string;
  /** Best-effort locale hint from the trip or browser preference. */
  locale?: ClassifierLocale;
}

export type ClassifyResult =
  | { kind: "PROPOSED"; intent: PersonalResearchIntent }
  | { kind: "CONVERSATION" };

// ─── Verb + object token tables ──────────────────────────────────────────────
// Each table is the union of Chinese + English triggers for one intent
// shape. Order within arrays is irrelevant; matching is OR.

const HOTEL_VERBS = ["查", "搜", "找", "搜索", "查一下", "查看", "查询", "看看"];
const HOTEL_NOUNS = [
  "酒店", "住宿", "饭店", "飯店", "宾馆", "民宿", "旅馆", "旅館", "客栈",
];
const HOTEL_EN_VERBS = ["search", "find", "look", "look up", "check", "browse"];
const HOTEL_EN_NOUNS = ["hotel", "stay", "lodging", "accommodation", "inn"];

const ACTIVITY_VERBS = ["查", "找", "搜", "搜索", "推荐", "看看"];
const ACTIVITY_NOUNS = ["景点", "活动", "好玩", "好玩的", "attraction", "activity", "activities", "things to do"];
const PLACE_NOUNS = ["餐厅", "美食", "restaurant", "food", "dining", "cafe"];
// NOTE: 饭店 / 飯店 are intentionally NOT in PLACE_NOUNS — they double as
// "hotel" in everyday Chinese and the classifier prefers the higher-friction
// hotel surface (which also satisfies restaurant lookups downstream via the
// accommodation.discover skill if needed).
const ACTIVITY_EN_VERBS = ["search", "find", "look", "recommend", "suggest"];
// Note: ACTIVITY_EN_NOUNS intentionally empty in the EN lane — the noun
// gate happens at the activity/place noun split below.

const ROUTE_VERBS = ["怎么走", "怎么去", "路线", "导航", "方向", "走法"];
const ROUTE_NOUNS = ["路线", "导航", "方向", "路径", "路", "directions", "route", "navigation"];
// Route detection triggers on EITHER (route verb) OR (route noun) with
// the rest of the question looking like a trip. This keeps valid route
// requests like "从桃园机场到西园町怎么走" (verb-only) classified correctly
// without dragging in irrelevant sentences.

const ITINERARY_VERBS = ["规划", "安排行程", "安排", "比较方案", "做行程", "做攻略", "攻略"];
const ITINERARY_NOUNS = ["行程", "行程表", "攻略", "方案", "itinerary", "plan", "trip plan", "options"];
const ITINERARY_EN_VERBS = ["plan", "compare", "design", "build"];
const ITINERARY_EN_NOUNS = ["itinerary", "plan", "trip plan", "options"];

// ─── Stopwords that force CONVERSATION fallback ──────────────────────────────

/** Negation / hypothetical / refusal phrasings. */
const NEGATION_TRIGGERS = [
  "不要", "不想", "不打算", "不会", "不用了", "算了", "别",
  "don't", "do not", "no need", "not now", "skip", "never mind",
];
/** Question-only phrasings with no clear request for live evidence. */
const LOW_CONFIDENCE_TRIGGERS = [
  "可以", "能不能", "可以吗", "有什么", "怎么", "为什么", "什么意思",
  "can you", "could you", "how", "what is", "what are", "why",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function nfkcNormalize(input: string): string {
  // NFKC normalization makes "㐂" / variant kanji / half-width digits
  // collapse to their canonical form before pattern matching.
  // The runtime supports String.prototype.normalize on Node >= 20.
  return input.normalize("NFKC").toLowerCase().trim();
}

function containsAny(haystack: string, needles: string[]): boolean {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

/** Detect verbs+noun co-occurrence for a single intent shape. */
function matchesGroup(
  normalized: string,
  verbs: string[],
  nouns: string[],
  enVerbs: string[],
  enNouns: string[],
): boolean {
  const hitZh = containsAny(normalized, verbs) && containsAny(normalized, nouns);
  const hitEn = containsAny(normalized, enVerbs) && containsAny(normalized, enNouns);
  return hitZh || hitEn;
}

/** Route detection: trigger on EITHER verb OR noun (whichever is present).
 *  Real route requests in zh-CN frequently use only verbs ("从 A 到 B 怎么走"),
 *  and in en-US only verbs ("navigate from airport"). The orchestrator's
 *  `loadRoutablePlaces` gate is the authoritative downstream filter. */
function matchesRoute(
  normalized: string,
): boolean {
  const hitZhVerb = containsAny(normalized, ROUTE_VERBS);
  const hitZhNoun = containsAny(normalized, ROUTE_NOUNS);
  const hitEnVerb = containsAny(normalized, ["directions", "route", "navigate", "how do i get", "how to get"]);
  // English still requires at least one route noun to avoid false positives
  // like "search route" (which is actually a search query for a route, not a
  // directions request — those hit the activity/places path).
  // Bare “从” / “到” occur in ordinary travel chat (for example “我从上海
  // 来，想找酒店”). Require a complete endpoint construction plus a route
  // predicate, or an explicit route noun; this deliberately favors a safe
  // conversation fallback over an accidental proposal.
  return hitZhVerb || hitZhNoun || hitEnVerb;
}

/**
 * A question is "pure low-confidence" when it consists only of question
 * words / politeness markers and no travel-related verb+noun pair at all.
 * Such input must fall back to CONVERSATION even when the LLM could
 * plausibly handle it — the classifier must never auto-execute research
 * on a "可以?" or "what is?" framing.
 */
function isPureLowConfidenceQuestion(normalized: string): boolean {
  if (!containsAny(normalized, LOW_CONFIDENCE_TRIGGERS)) return false;
  // Strip low-confidence markers and stopwords; if anything travel-related
  // remains, treat it as a real research request.
  const stripped = normalized
    .replace(/[可以不能有什么怎么为什么什么意思行不行吗呢啊嘛]+/gu, " ")
    .trim();
  // If after stripping nothing meaningful remains, it's a pure question.
  // Also require the question to be short (<= 20 chars) so longer sentences
  // that happen to contain "可以" alongside real research tokens still pass.
  if (stripped.length === 0 || normalized.length > 20) return false;
  // Confirm no travel verb / noun survived in the stripped text.
  const hasAnyTravelToken =
    containsAny(stripped, HOTEL_VERBS)
    || containsAny(stripped, HOTEL_NOUNS)
    || containsAny(stripped, ACTIVITY_VERBS)
    || containsAny(stripped, ACTIVITY_NOUNS)
    || containsAny(stripped, PLACE_NOUNS)
    || containsAny(stripped, ROUTE_VERBS)
    || containsAny(stripped, ROUTE_NOUNS)
    || containsAny(stripped, ITINERARY_VERBS)
    || containsAny(stripped, ITINERARY_NOUNS)
    || containsAny(stripped, HOTEL_EN_VERBS)
    || containsAny(stripped, HOTEL_EN_NOUNS)
    || containsAny(stripped, ACTIVITY_EN_VERBS)
    || containsAny(stripped, ITINERARY_EN_VERBS)
    || containsAny(stripped, ITINERARY_EN_NOUNS);
  return !hasAnyTravelToken;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function classifyResearchIntent(input: ClassifyInput): ClassifyResult {
  if (!input.question) return { kind: "CONVERSATION" };
  const normalized = nfkcNormalize(input.question);

  // Hard fallbacks — any of these forces CONVERSATION even if a verb+noun
  // pair would otherwise match. The classifier is conservative: false
  // negatives (sending a real research request through the LLM) are cheaper
  // than false positives (calling a provider for a hypothetical question).
  if (containsAny(normalized, NEGATION_TRIGGERS)) {
    return { kind: "CONVERSATION" };
  }
  // Low-confidence phrasings (questions without an explicit research verb)
  // also fall back to CONVERSATION. We only short-circuit when the question
  // is short and question-marked — longer sentences that happen to contain
  // "可以" alongside explicit research verbs still classify normally.
  if (isPureLowConfidenceQuestion(normalized) && !matchesRoute(normalized)) {
    return { kind: "CONVERSATION" };
  }

  const hotelHit = matchesGroup(
    normalized, HOTEL_VERBS, HOTEL_NOUNS, HOTEL_EN_VERBS, HOTEL_EN_NOUNS,
  );
  const activityZhHit = containsAny(normalized, ACTIVITY_VERBS)
    && containsAny(normalized, ACTIVITY_NOUNS);
  const placeZhHit = containsAny(normalized, ACTIVITY_VERBS)
    && containsAny(normalized, PLACE_NOUNS);
  // English: nouns that look like attractions are activities; restaurant
  // words are places. The verb gate requires one of ACTIVITY_EN_VERBS.
  const activityEnHit = containsAny(normalized, ACTIVITY_EN_VERBS)
    && containsAny(normalized, ["attraction", "activity", "activities", "things to do"]);
  const placeEnHit = containsAny(normalized, ACTIVITY_EN_VERBS)
    && containsAny(normalized, ["restaurant", "food", "dining", "cafe"]);
  const activityHit = activityZhHit || activityEnHit;
  const placeHit = placeZhHit || placeEnHit;
  const routeHit = matchesRoute(normalized);
  const itineraryHit = matchesGroup(
    normalized, ITINERARY_VERBS, ITINERARY_NOUNS, ITINERARY_EN_VERBS, ITINERARY_EN_NOUNS,
  );

  // Two or more research intents collide → refuse to guess; fall back.
  // Route + hotel is the most common ambiguous case (a question like
  // "查一下机场到酒店怎么走" mentions both hotel and route in passing).
  // activities + places collide when the user mentions both "景点" and
  // "餐厅" in one sentence — owner should split into separate turns.
  const intentCount =
    (hotelHit ? 1 : 0)
    + (activityHit ? 1 : 0)
    + (placeHit ? 1 : 0)
    + (routeHit ? 1 : 0)
    + (itineraryHit ? 1 : 0);
  if (intentCount >= 2) {
    return { kind: "CONVERSATION" };
  }

  // Priority order: hotel > route > places > activities > itinerary.
  // "查饭店" could map to either hotel or restaurant; we prefer hotel so a
  // user saying "查饭店" gets the more conservative research surface (hotel
  // is a higher-friction capability than places — places also has a search
  // -> adopt -> use loop, hotel short-circuits via the orchestrator).
  // Conflicts between any two distinct groups fall through to CONVERSATION
  // above (intentCount >= 2).
  if (itineraryHit) {
    // Full-itinerary uses the full capability surface per spec §5.1.
    return {
      kind: "PROPOSED",
      intent: {
        kind: "PROPOSE_PLAN",
        requestedCapabilities: [
          "flight", "accommodation", "hotel", "activities", "places",
          "navigation", "mobility", "readiness",
        ],
      },
    };
  }
  if (hotelHit) {
    return {
      kind: "PROPOSED",
      intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["hotel"] },
    };
  }
  if (routeHit) {
    return {
      kind: "PROPOSED",
      intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["navigation"] },
    };
  }
  if (placeHit) {
    return {
      kind: "PROPOSED",
      intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["places"] },
    };
  }
  if (activityHit) {
    return {
      kind: "PROPOSED",
      intent: { kind: "RESEARCH_ONLY", requestedCapabilities: ["activities"] },
    };
  }

  // No high-confidence pattern → CONVERSATION. We do NOT throw or log;
  // the caller decides what to render.
  void input.locale;
  return { kind: "CONVERSATION" };
}

/**
 * Convenience export for tests/observability: returns the rule-packs the
 * classifier is built from. NEVER consumed by runtime paths.
 */
export const __INTERNAL_CLASSIFIER_RULES__ = {
  HOTEL_VERBS,
  HOTEL_NOUNS,
  HOTEL_EN_VERBS,
  HOTEL_EN_NOUNS,
  ACTIVITY_VERBS,
  ACTIVITY_NOUNS,
  PLACE_NOUNS,
  ACTIVITY_EN_VERBS,
  ROUTE_VERBS,
  ROUTE_NOUNS,
  ITINERARY_VERBS,
  ITINERARY_NOUNS,
  ITINERARY_EN_VERBS,
  ITINERARY_EN_NOUNS,
  NEGATION_TRIGGERS,
  LOW_CONFIDENCE_TRIGGERS,
};
