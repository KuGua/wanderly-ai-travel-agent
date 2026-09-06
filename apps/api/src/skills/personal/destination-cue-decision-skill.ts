import { createHash } from "node:crypto";
import { z } from "zod";

import type { Skill, SkillContext } from "../../agents/contracts.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import { getLocationReferenceResolver } from "../../location-reference/location-reference-resolver.js";

const EXPLICIT_DESTINATION_COMMAND =
  /(?:\b(?:set|make|mark|list)\b.{0,100}\b(?:as|to be)\s+(?:the\s+)?destination\b|(?:把|将).{1,100}(?:设|设置|定|列)(?:为|成)(?:(?:这|本)次旅行的?)?目的地|(?:把|将).{1,100}作为(?:(?:这|本)次旅行的?)?目的地|目的地\s*(?:设|设置|定|列|是|为))/iu;

export type DestinationCuePreflight = "MODEL" | "SKIP";

/**
 * Destination confirmation is an explicit action. A bare city can be an
 * origin, an example, or casual exploration, so it must not open a card.
 */
export function destinationCuePreflight(question?: string): DestinationCuePreflight {
  return question && EXPLICIT_DESTINATION_COMMAND.test(question) ? "MODEL" : "SKIP";
}

export interface ResolvedDestinationCueDecision {
  candidates: Array<{
    ordinal: number;
    canonicalCityName: string;
    countryCode: string;
    candidateKeyHash: string;
    intent: "DESTINATION_INTEREST" | "EXPLICIT_SET_DESTINATION";
    triggerContext:
      | "BARE_CITY"
      | "CITY_EXPLORATION"
      | "FLIGHT_DESTINATION"
      | "HOTEL_DESTINATION"
      | "EXPLICIT_DESTINATION_COMMAND";
  }>;
  modelVersion: string;
  promptVersion: string;
}

export const destinationCueDecisionInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  currentDestinations: z.array(z.string().trim().min(1).max(128)).max(5),
  locale: z.enum(["en", "zh"]),
  messageSource: z.enum(["USER_TURN", "ASSISTANT_REPLY"]).default("USER_TURN"),
}).strict();

export const destinationCueDecisionOutputSchema = z.object({
  candidates: z.array(z.object({
    ordinal: z.number().int().min(0).max(4),
    canonicalCityName: z.string().min(1).max(128),
    countryCode: z.string().length(2),
    candidateKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
    intent: z.enum(["DESTINATION_INTEREST", "EXPLICIT_SET_DESTINATION"]),
    triggerContext: z.enum([
      "BARE_CITY",
      "CITY_EXPLORATION",
      "FLIGHT_DESTINATION",
      "HOTEL_DESTINATION",
      "EXPLICIT_DESTINATION_COMMAND",
    ]),
  }).strict()).min(0).max(5),
  modelVersion: z.string().min(1).max(128),
  promptVersion: z.string().min(1).max(64),
}).strict().nullable();

export async function decideDestinationCueForTurn(params: {
  ctx: SkillContext;
  question: string;
  currentDestinations: string[];
  locale: "en" | "zh";
  messageSource?: "USER_TURN" | "ASSISTANT_REPLY";
  signal: AbortSignal;
}): Promise<ResolvedDestinationCueDecision | null> {
  if (destinationCuePreflight(params.question) !== "MODEL") return null;
  const gateway = modelGateway();
  if (!gateway.decideDestinationCue) return null;
  // Measured 2.6s-5.2s against the 2.5s this used to allow, so the budget was
  // losing races it should have won — and losing them silently. The call is
  // started before the reply's own model call and awaited after it, so the
  // wall clock overlaps rather than adds.
  const timeoutSignal = AbortSignal.timeout(9_000);
  const signal = AbortSignal.any([params.signal, timeoutSignal]);
  const result = await gateway.decideDestinationCue({
    question: params.question,
    currentDestinations: params.currentDestinations,
    locale: params.locale,
    messageSource: params.messageSource ?? "USER_TURN",
    signal,
    ctx: params.ctx.ctx,
  });
  if (!result || result.decision.isNeutralMultiCityList) return null;

  const current = new Set(params.currentDestinations.map(normalize));
  const seen = new Set<string>();
  const candidates: ResolvedDestinationCueDecision["candidates"] = [];
  const modelCandidates = [...result.decision.candidates].sort((a, b) => a.ordinal - b.ordinal);
  for (const candidate of modelCandidates) {
    // The text gate and structured output must both agree that this is an
    // explicit positive set command. Either side being weaker fails closed.
    if (candidate.intent !== "EXPLICIT_SET_DESTINATION"
      || candidate.triggerContext !== "EXPLICIT_DESTINATION_COMMAND") continue;
    let reference;
    try {
      reference = getLocationReferenceResolver().resolveDestinationReference({
        destinationId: candidate.mentionedText,
        cityName: candidate.mentionedText,
      });
    } catch {
      return null;
    }
    if (!reference) continue;
    const key = normalize(`${reference.cityName}|${reference.countryCode}`);
    if (current.has(normalize(reference.cityName)) || seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ordinal: candidates.length,
      canonicalCityName: reference.cityName,
      countryCode: reference.countryCode,
      candidateKeyHash: createHash("sha256").update(key).digest("hex"),
      intent: "EXPLICIT_SET_DESTINATION",
      triggerContext: "EXPLICIT_DESTINATION_COMMAND",
    });
  }
  if (candidates.length === 0) return null;
  return destinationCueDecisionOutputSchema.parse({
    candidates,
    modelVersion: result.modelVersion,
    promptVersion: result.promptVersion,
  });
}

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export const destinationCueDecisionSkill: Skill<
  z.infer<typeof destinationCueDecisionInputSchema>,
  z.infer<typeof destinationCueDecisionOutputSchema>
> = {
  name: "destination.cue.decide",
  agent: "personal",
  version: "2.0.0",
  allowedTools: ["chat:read"],
  timeoutMs: 9_000,
  needsConfirm: false,
  input: destinationCueDecisionInputSchema,
  output: destinationCueDecisionOutputSchema,
  handler(ctx, input, signal) {
    return decideDestinationCueForTurn({ ctx, ...input, signal });
  },
};
