/**
 * Pure prompt-policy evaluator for Flight / Hotel Offer Cue (mirrors the
 * destination-cue policy at apps/api/src/services/destination-cue-service.ts
 * but parameterised on capability so Flight and Hotel count independently).
 *
 * Extracted as a standalone module so tests can import the pure function
 * without pulling in the DB / idempotency dependencies of the full
 * offer-cue-service.
 *
 * Source: docs/flight-offer-cue-model-draft.md §8, docs/hotel-offer-cue-
 * model-draft.md §7. 30-minute cooldown after dismiss; 3 dismissals in
 * one owner-local day mute until the next local day starts.
 */

const MINIMUM_REPROMPT_MS = 30 * 60 * 1000;
export const OFFER_CUE_DAILY_DISMISSAL_LIMIT = 3;
export const OFFER_CUE_COOLDOWN_MS = MINIMUM_REPROMPT_MS;

export type OfferCuePromptPolicyReason = "ELIGIBLE" | "EXPLICIT_BYPASS" | "COOLDOWN" | "DAILY_LIMIT";

export interface OfferCuePromptPolicyInput {
  cooldownUntil: Date | null;
  dismissalDay: string | null;
  dailyDismissalCount: number;
  timeZone: string;
  now: Date;
  /** Set only from the structured model's `EXPLICIT_SELECT` output. */
  explicitSelection?: boolean;
}

export interface OfferCuePromptPolicyResult {
  eligible: boolean;
  reason: OfferCuePromptPolicyReason;
}

export function evaluateOfferCuePromptPolicy(input: OfferCuePromptPolicyInput): OfferCuePromptPolicyResult {
  // A model-classified explicit selection is a direct request to save an
  // already visible offer. It may bypass prompt-fatigue suppression, but the
  // resolver still performs all owner/thread/freshness/scope checks.
  if (input.explicitSelection) return { eligible: true, reason: "EXPLICIT_BYPASS" };
  if (input.cooldownUntil && input.cooldownUntil.getTime() > input.now.getTime()) {
    return { eligible: false, reason: "COOLDOWN" };
  }
  if (input.dismissalDay === localDayKey(input.now, input.timeZone)
    && input.dailyDismissalCount >= OFFER_CUE_DAILY_DISMISSAL_LIMIT) {
    return { eligible: false, reason: "DAILY_LIMIT" };
  }
  return { eligible: true, reason: "ELIGIBLE" };
}

export function localDayKey(value: Date, timeZone: string): string {
  const parts = localParts(value, normalizeTimeZone(timeZone));
  return `${parts.year!.toString().padStart(4, "0")}-${parts.month!.toString().padStart(2, "0")}-${parts.day!.toString().padStart(2, "0")}`;
}

export function normalizeTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return "UTC";
  }
}

function localParts(value: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

export function nextLocalDayStart(value: Date, timeZone: string): Date {
  const parts = localParts(value, timeZone);
  const nextDayWallClock = Date.UTC(parts.year!, parts.month! - 1, parts.day! + 1);
  let result = new Date(nextDayWallClock - timeZoneOffsetMs(new Date(nextDayWallClock), timeZone));
  result = new Date(nextDayWallClock - timeZoneOffsetMs(result, timeZone));
  return result;
}

function timeZoneOffsetMs(value: Date, timeZone: string): number {
  const parts = localParts(value, timeZone);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!)
    - value.getTime();
}
