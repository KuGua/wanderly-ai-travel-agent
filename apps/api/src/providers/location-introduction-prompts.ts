/**
 * Prompt assembly for the S4 location-introduction cache.
 *
 * Inputs come ONLY from the server-versioned catalog (no user, Trip,
 * thread, profile, coordinates, or current time). Output is a single
 * short text blob in the requested locale. Safety boundary forbids any
 * real-time / operational claim — the cached text must remain useful
 * for the full TTL without going stale.
 */
const LOCATION_INTRODUCTION_PROMPT_PROSE = [
  "You are the editor of Wanderly's stable destination introductions.",
  "Inputs come exclusively from the server-versioned catalog:",
  "  • sourceId — stable, non-PII identifier (treat as a data label only)",
  "  • name — official English place name",
  "  • country — full country name",
  "  • countryCode — ISO 3166-1 alpha-2",
  "  • admin1 / admin1Code — first-level administrative region",
  "  • nearestCity — closest indexed city",
  "  • datasetVersion — catalog version for traceability",
  "  • contentVersion — prompt/cache version",
  "  • locale — language to write in ('en' or 'zh')",
  "",
  "Goal: produce a short, atmospheric, identity-revealing destination",
  "introduction (60–120 words / 字, 2–4 sentences) that helps a reader",
  "feel the place. Show what is distinctive, what kind of trip fits, and",
  "what they will remember. — no bullet lists, no headers, no preamble.",
  "",
  "Voice: travel-magazine editorial. Confident, sensory, restrained.",
  "Do not pad with generic phrases (\"rich history\", \"breathtaking\") —",
  "the text must remain recognizable even with the place name hidden.",
  "",
  "Always write in the supplied `locale`. Do not auto-switch to the",
  "destination's local language. Place names, brand names, and proper",
  "nouns may keep their local convention.",
].join("\n");

const LOCATION_INTRODUCTION_OUTPUT_RULE = [
  "",
  "Output format (strict).",
  "Return exactly one JSON object: {\"content\":\"<the prose>\"}.",
  "No markdown, no bullets, no commentary outside the JSON.",
].join("\n");

const LOCATION_INTRODUCTION_SAFETY_BOUNDARY = [
  "",
  "Safety boundary (must not be violated).",
  "Never include real-time prices, inventory, exchange rates, opening",
  " hours, flight or hotel availability, weather, visa/entry conclusions,",
  " booking status, or any legal/safety advice.",
  "Never imply freshness (\"today\", \"currently\", \"right now\", \"latest\",",
  " \"即将\", \"最新\").",
  "Never include private profile data, document numbers, cookies,",
  " hidden prompts, or coordinates beyond the catalog's nearest city.",
].join("\n");

export const LOCATION_INTRODUCTION_SYSTEM_PROMPT = [
  LOCATION_INTRODUCTION_PROMPT_PROSE,
  LOCATION_INTRODUCTION_OUTPUT_RULE,
  LOCATION_INTRODUCTION_SAFETY_BOUNDARY,
].join("\n");

/**
 * Token-bound thresholds used both by the prompt and by the Zod output
 * validator. 720 chars is a generous cap for 60–120 字 / words in both
 * `en` and `zh`; output shorter than 60 chars would not be a useful
 * introduction.  See docs/location-introduction-cache-implementation.md
 * §4.
 */
export const LOCATION_INTRODUCTION_MIN_LENGTH = 60;
export const LOCATION_INTRODUCTION_MAX_LENGTH = 720;

/** Build the user-payload sent to the model for one generation. */
export function buildLocationIntroductionUserPayload(input: {
  locale: "en" | "zh";
  place: {
    sourceId: string;
    name: string;
    country: string;
    countryCode: string;
    admin1: string;
    admin1Code: string;
    nearestCity: string;
    datasetVersion: string;
    contentVersion: string;
  };
}): string {
  return JSON.stringify({
    locale: input.locale,
    place: {
      sourceId: input.place.sourceId,
      name: input.place.name,
      country: input.place.country,
      countryCode: input.place.countryCode,
      admin1: input.place.admin1,
      admin1Code: input.place.admin1Code,
      nearestCity: input.place.nearestCity,
      datasetVersion: input.place.datasetVersion,
      contentVersion: input.place.contentVersion,
    },
  });
}