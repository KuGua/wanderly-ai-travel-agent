/**
 * Setup follow-up generator — high-level wrapper around the bounded LLM
 * call (`LLMGateway.generateSetupFollowup`) with a deterministic
 * template fallback. Used by the conversation worker when a classified
 * Personal Research intent draft carries `readiness = NEEDS_SETUP` and
 * the conversational setup session is open.
 *
 * Contract (docs/personal-research-intent-routing-implementation.md §9):
 *   * Never blocks the conversation task: any LLM failure or schema
 *     rejection falls back to a deterministic template.
 *   * Never echoes owner PII: the LLM call is bounded and gated; the
 *     fallback only ever references the server-known missing codes.
 *   * Emits low-cardinality metrics `personal_research_setup_followup_total`
 *     with `outcome` ∈ `model | fallback` and an optional `reason`.
 */

import { metrics } from "../observability/metrics.js";
import { recordAudit } from "./audit-service.js";
import {
  assertSetupFollowupOutputSafe,
  setupFollowupOutputSchema,
} from "../providers/setup-followup-schema.js";
import {
  SETUP_FOLLOWUP_MAX_PROMPT_LENGTH,
} from "../providers/setup-followup-prompts.js";
import type { RequestContext } from "../utils/context.js";
import { modelGateway } from "../providers/gateway-factory.js";
import type {
  ConversationFollowupFallback,
  SetupFollowupResult,
} from "./setup-followup-types.js";

type MissingCode =
  | "TRIP_NOT_ACTIVE"
  | "DESTINATION_NOT_CONFIGURED"
  | "DATES_MISSING"
  | "FLIGHT_PREFERENCES_MISSING"
  | "STAY_PREFERENCES_MISSING"
  | "HOTEL_PROVIDER_NOT_APPROVED"
  | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING"
  | "ROUTE_ENDPOINTS_UNCONFIRMED"
  | "MODE_NOT_CHOSEN";

interface GenerateInput {
  ctx: RequestContext;
  tripId: string;
  ownerUserId: string;
  locale: "zh-CN" | "zh-TW" | "en-US";
  requestedMissing: MissingCode[];
  filledFieldNames: string[];
  signal?: AbortSignal;
}

const FALLBACK_LABELS: Record<MissingCode, { zh: string; en: string }> = {
  TRIP_NOT_ACTIVE: { zh: "行程尚未激活", en: "the trip is not yet active" },
  DESTINATION_NOT_CONFIGURED: { zh: "尚未选择目的地", en: "no destination is set yet" },
  DATES_MISSING: { zh: "入住与离店日期", en: "check-in and check-out dates" },
  FLIGHT_PREFERENCES_MISSING: { zh: "机票偏好", en: "flight preferences" },
  STAY_PREFERENCES_MISSING: { zh: "住宿偏好", en: "stay preferences" },
  HOTEL_PROVIDER_NOT_APPROVED: { zh: "酒店供应商授权", en: "hotel provider authorization" },
  QUOTE_NATIONALITY_AUTHORIZATION_MISSING: { zh: "酒店供应商的国籍授权", en: "hotel provider nationality authorization" },
  ROUTE_ENDPOINTS_UNCONFIRMED: { zh: "路线端点", en: "route endpoints" },
  MODE_NOT_CHOSEN: { zh: "出行方式", en: "transport mode" },
};

const FALLBACK_PROMPTS: Record<MissingCode, { zh: string; en: string }> = {
  TRIP_NOT_ACTIVE: {
    zh: "请先在行程页激活本次行程，再继续。",
    en: "Please activate the trip before continuing.",
  },
  DESTINATION_NOT_CONFIGURED: {
    zh: "请先在行程页选定目的地，再继续。",
    en: "Please pick a destination before continuing.",
  },
  DATES_MISSING: {
    zh: "你打算什么时候入住、什么时候离店？",
    en: "When are you checking in and checking out?",
  },
  FLIGHT_PREFERENCES_MISSING: {
    zh: "这次机票你倾向哪种舱位 / 几个人？",
    en: "What cabin and party size should I search flights for?",
  },
  STAY_PREFERENCES_MISSING: {
    zh: "这次酒店需要几间房、每间几位成人、用哪个币种？",
    en: "How many rooms and adults per room, and which currency?",
  },
  HOTEL_PROVIDER_NOT_APPROVED: {
    zh: "当前没有可用的酒店供应商，请在偏好页开通后再继续。",
    en: "No hotel provider is enabled — open the preferences page to enable one.",
  },
  QUOTE_NATIONALITY_AUTHORIZATION_MISSING: {
    zh: "酒店供应商需要你确认一次国籍授权，请在偏好页完成。",
    en: "The hotel provider needs you to confirm a one-time nationality authorization.",
  },
  ROUTE_ENDPOINTS_UNCONFIRMED: {
    zh: "请在路线卡片里确认出发地和目的地。",
    en: "Please confirm the origin and destination in the route card.",
  },
  MODE_NOT_CHOSEN: {
    zh: "请选择一种出行方式（步行 / 驾车 / 骑行）。",
    en: "Please pick a transport mode (walk / drive / cycle).",
  },
};

function pickFirstMissing(missing: MissingCode[]): MissingCode | null {
  for (const code of missing) {
    if (FALLBACK_PROMPTS[code]) return code;
  }
  return null;
}

function deterministicFallback(
  missing: MissingCode[],
  locale: "zh-CN" | "zh-TW" | "en-US",
): ConversationFollowupFallback | null {
  const code = pickFirstMissing(missing);
  if (!code) return null;
  const prompt = locale === "en-US" ? FALLBACK_PROMPTS[code].en : FALLBACK_PROMPTS[code].zh;
  return {
    questionCode: code,
    promptText: prompt.slice(0, SETUP_FOLLOWUP_MAX_PROMPT_LENGTH),
    source: "fallback",
  };
}

/**
 * Bounded LLM-driven follow-up question. On any failure path (model
 * unavailable, schema rejection, PII / live-fact hit, invalid code,
 * empty missing list) returns the deterministic template. Never throws.
 */
export async function generateSetupFollowup(input: GenerateInput): Promise<ConversationFollowupFallback | null> {
  if (input.requestedMissing.length === 0) {
    metrics.inc("personal_research_setup_followup_total", { outcome: "fallback", reason: "empty" });
    return null;
  }

  const gateway = modelGateway();
  if (!gateway.generateSetupFollowup) {
    const fb = deterministicFallback(input.requestedMissing, input.locale);
    metrics.inc("personal_research_setup_followup_total", { outcome: "fallback", reason: "no_gateway" });
    if (fb) await recordFollowupFallbackAudit(input, "no_gateway");
    return fb;
  }

  try {
    const result: SetupFollowupResult = await gateway.generateSetupFollowup({
      locale: input.locale,
      requestedMissing: input.requestedMissing,
      filledFieldNames: input.filledFieldNames,
      missingCodeLabels: FALLBACK_LABELS,
      ...(input.signal ? { signal: input.signal } : {}),
      ctx: input.ctx,
    });
    // Re-validate on the route boundary even though the gateway ran Zod.
    const parsed = setupFollowupOutputSchema.safeParse({
      questionCode: result.questionCode,
      promptText: result.promptText,
    });
    if (!parsed.success) {
      const fb = deterministicFallback(input.requestedMissing, input.locale);
      metrics.inc("personal_research_setup_followup_total", { outcome: "fallback", reason: "schema" });
      if (fb) await recordFollowupFallbackAudit(input, "schema");
      return fb;
    }
    if (!input.requestedMissing.includes(parsed.data.questionCode as MissingCode)) {
      const fb = deterministicFallback(input.requestedMissing, input.locale);
      metrics.inc("personal_research_setup_followup_total", { outcome: "fallback", reason: "invalid_code" });
      if (fb) await recordFollowupFallbackAudit(input, "invalid_code");
      return fb;
    }
    try {
      assertSetupFollowupOutputSafe(parsed.data);
    } catch {
      const fb = deterministicFallback(input.requestedMissing, input.locale);
      metrics.inc("personal_research_setup_followup_total", { outcome: "fallback", reason: "pii" });
      if (fb) await recordFollowupFallbackAudit(input, "pii");
      return fb;
    }
    metrics.inc("personal_research_setup_followup_total", { outcome: "model", reason: "model" });
    await recordAudit({
      ctx: input.ctx,
      action: "PERSONAL_RESEARCH_SETUP_FOLLOWUP_GENERATED",
      actorUserId: input.ownerUserId,
      tripId: input.tripId,
      summary: {
        questionCode: parsed.data.questionCode,
        promptLength: parsed.data.promptText.length,
      },
    });
    return {
      questionCode: parsed.data.questionCode,
      promptText: parsed.data.promptText,
      source: "model",
    };
  } catch {
    const fb = deterministicFallback(input.requestedMissing, input.locale);
    metrics.inc("personal_research_setup_followup_total", { outcome: "fallback", reason: "model_error" });
    if (fb) await recordFollowupFallbackAudit(input, "model_error");
    return fb;
  }
}

async function recordFollowupFallbackAudit(input: GenerateInput, reason: string): Promise<void> {
  await recordAudit({
    ctx: input.ctx,
    action: "PERSONAL_RESEARCH_SETUP_FOLLOWUP_FELLBACK",
    actorUserId: input.ownerUserId,
    tripId: input.tripId,
    summary: { reason, missingCount: input.requestedMissing.length },
  });
}
