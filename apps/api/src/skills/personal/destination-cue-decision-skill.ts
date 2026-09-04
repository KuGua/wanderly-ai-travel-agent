import { createHash } from "node:crypto";
import { z } from "zod";

import type { Skill, SkillContext } from "../../agents/contracts.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import { getLocationReferenceResolver } from "../../location-reference/location-reference-resolver.js";

const EXPLICIT_DESTINATION = /(?:\b(?:set|make)\b.{0,100}\b(?:as|to be)\s+(?:the\s+)?destination\b|(?:把|将).{1,100}(?:设|设置|定)(?:为|成)(?:这次旅行的?)?目的地|目的地\s*(?:设|设置|定|是|为))/iu;
const FLIGHT_OR_HOTEL = /(?:\b(?:flights?|hotels?|stays?|accommodations?)\b|机票|航班|酒店|住宿|饭店)/iu;

export type DestinationCuePreflight = "MODEL" | "SKIP_FLIGHT_OR_HOTEL";

/** Deterministic precedence guard; an explicit destination command wins. */
export function destinationCuePreflight(question: string): DestinationCuePreflight {
  if (EXPLICIT_DESTINATION.test(question)) return "MODEL";
  return FLIGHT_OR_HOTEL.test(question)
    ? "SKIP_FLIGHT_OR_HOTEL"
    : "MODEL";
}

export interface ResolvedDestinationCueDecision {
  candidates: Array<{
    ordinal: number;
    canonicalCityName: string;
    countryCode: string;
    candidateKeyHash: string;
  }>;
  modelVersion: string;
  promptVersion: string;
}

export const destinationCueDecisionInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  currentDestinations: z.array(z.string().trim().min(1).max(128)).max(5),
  locale: z.enum(["en", "zh"]),
}).strict();

export const destinationCueDecisionOutputSchema = z.object({
  candidates: z.array(z.object({
    ordinal: z.number().int().min(0).max(4),
    canonicalCityName: z.string().min(1).max(128),
    countryCode: z.string().length(2),
    candidateKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).min(1).max(5),
  modelVersion: z.string().min(1).max(128),
  promptVersion: z.string().min(1).max(64),
}).strict().nullable();

export async function decideDestinationCueForTurn(params: {
  ctx: SkillContext;
  question: string;
  currentDestinations: string[];
  locale: "en" | "zh";
  signal: AbortSignal;
}): Promise<ResolvedDestinationCueDecision | null> {
  if (destinationCuePreflight(params.question) === "SKIP_FLIGHT_OR_HOTEL") return null;
  const gateway = modelGateway();
  if (!gateway.decideDestinationCue) return null;
  const timeoutSignal = AbortSignal.timeout(2_500);
  const signal = AbortSignal.any([params.signal, timeoutSignal]);
  const result = await gateway.decideDestinationCue({
    question: params.question,
    currentDestinations: params.currentDestinations,
    locale: params.locale,
    signal,
    ctx: params.ctx.ctx,
  });
  if (!result || result.decision.disposition !== "PROPOSE") return null;

  const current = new Set(params.currentDestinations.map(normalize));
  const seen = new Set<string>();
  const candidates: ResolvedDestinationCueDecision["candidates"] = [];
  for (const candidate of [...result.decision.candidates].sort((a, b) => a.ordinal - b.ordinal)) {
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
  version: "1.0.0",
  allowedTools: ["chat:read"],
  timeoutMs: 2_500,
  needsConfirm: false,
  input: destinationCueDecisionInputSchema,
  output: destinationCueDecisionOutputSchema,
  handler(ctx, input, signal) {
    return decideDestinationCueForTurn({ ctx, ...input, signal });
  },
};
