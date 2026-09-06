import { createHash } from "node:crypto";
import { z } from "zod";

import type { Skill, SkillContext } from "../../agents/contracts.js";
import { modelGateway } from "../../providers/gateway-factory.js";
import { getLocationReferenceResolver } from "../../location-reference/location-reference-resolver.js";

const EXPLICIT_DESTINATION_COMMAND =
  /(?:\b(?:set|make|mark|list)\b.{0,100}\b(?:as|to be)\s+(?:the\s+)?destination\b|(?:把|将).{1,100}(?:设|设置|定|列)(?:为|成)(?:(?:这|本)次旅行的?)?目的地|(?:把|将).{1,100}作为(?:(?:这|本)次旅行的?)?目的地|目的地\s*(?:设|设置|定|列|是|为))/iu;

// An assistant can introduce a city and then refer to it as "它" in the
// same visible reply. This is never accepted for a USER_TURN: only the
// assistant's own text, where the model has the full reply to resolve the
// antecedent from, may use this narrowly scoped form.
const ASSISTANT_PRONOUN_DESTINATION_COMMAND =
  /(?:把|将)\s*(?:它|该城市|这个城市|此城市)\s*(?:设|设置|定|列)(?:为|成)(?:(?:这|本)次旅行的?)?目的地|(?:把|将)\s*(?:它|该城市|这个城市|此城市)\s*作为(?:(?:这|本)次旅行的?)?目的地/iu;

// A bare city from a traveller is deliberately not a destination command.
// Once the assistant's *same visible reply* treats that one city as the
// current trip target and proceeds with planning, however, the next action is
// a destination confirmation — not an origin confirmation. Keep this marker
// assistant-only so a traveller's ordinary question cannot manufacture a cue.
const ASSISTANT_DESTINATION_ACKNOWLEDGMENT =
  /(?:确认(?:了)?(?:本次|当前|该)?目的地|确认目的地后|作为(?:本次|当前|该)?(?:旅行|行程)?的?目的地|(?:以|将|把).{0,100}(?:设|设置|定|列)(?:为|成)(?:(?:这|本)次旅行的?)?目的地)/iu;

// Shape only. Han script has no word delimiter, so every short Chinese
// sentence — 帮我看看, 太贵了, 第一班吧 — passes this and nothing about its
// form says whether it names a place. It is a cheap pre-filter that keeps
// long prose away from the catalogue lookup, never the decision itself.
const BARE_CITY_SHAPE = /^(?:[\p{Script=Han}]{2,12}|[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})$/u;
const EXPLICIT_ROUTE_TO_DESTINATION = /(?:从|由)\s*.+?\s*(?:去|到|往|飞往?|前往)\s*[^，。！？]+/u;
// 改从北京走 / 换成上海出发 state the origin role as plainly as 出发地改为北京
// does, and §3.2 of the remediation plan lists them as origin expressions. They
// must reach the origin parser and never the destination classifier.
const EXPLICIT_ORIGIN = /(?:(?:出发地|出发城市)\s*(?:是|为|改为|修改为|更新为|设为|设置为)|(?:把|将).*(?:出发地|出发城市).*(?:改|修改|更新|设|设置|定)|(?:改|换)(?:成|为|从)\s*.+?\s*(?:出发|走|起飞)|(?:从|由)\s*.+?\s*(?:出发|起飞)|.+?(?:出发|起飞)(?:[，。！？]|$))/u;

/**
 * True when the entire message is one city the reference catalogue can name.
 *
 * The shape test above cannot do this on its own: `^[\p{Script=Han}]{2,12}$`
 * matches 谢谢你 and 第一班吧 exactly as well as it matches 上海, which sent
 * essentially every short Chinese turn to the destination classifier — an
 * extra model call per turn, a false destination card, and the flight/hotel
 * confirmation phrases of §3.4/§3.5 landing in the wrong capability. The
 * catalogue is the same allow-list the cue would be validated against a moment
 * later, so asking it here only moves an existing check earlier.
 */
function isResolvableBareCity(text: string): boolean {
  const candidate = text.trim();
  if (!BARE_CITY_SHAPE.test(candidate)) return false;
  try {
    return getLocationReferenceResolver().resolveDestinationReference({
      destinationId: candidate,
      cityName: candidate,
    }) !== null;
  } catch {
    // The dataset is an allow-list, not an availability dependency for chat.
    // If it cannot load, decline the cue rather than guessing from shape.
    return false;
  }
}

export type DestinationCuePreflight = "MODEL" | "SKIP";

/**
 * Destination confirmation is an explicit action. A bare city can be an
 * origin, an example, or casual exploration, so it must not open a card.
 */
export function destinationCuePreflight(
  question?: string,
  messageSource: "USER_TURN" | "ASSISTANT_REPLY" = "USER_TURN",
): DestinationCuePreflight {
  if (!question) return "SKIP";
  // The broad Chinese command matcher below intentionally accepts arbitrary
  // text between 把/将 and 列为. A pronoun is the one exception: a user turn
  // has no server-owned antecedent in this classifier, so fail closed.
  if (messageSource === "USER_TURN" && ASSISTANT_PRONOUN_DESTINATION_COMMAND.test(question)) return "SKIP";
  if (EXPLICIT_DESTINATION_COMMAND.test(question)) return "MODEL";
  // A route owns two independent scopes: the origin parser receives its
  // left-hand city and Destination Cue classifies the right-hand city.
  if (messageSource === "USER_TURN" && EXPLICIT_ROUTE_TO_DESTINATION.test(question)) return "MODEL";
  if (messageSource === "USER_TURN" && EXPLICIT_ORIGIN.test(question)) return "SKIP";
  // A standalone city is a proposal, not a write: the model must resolve it
  // against the reference catalogue and the traveller still receives the
  // dedicated confirmation card. Phrases such as 从上海出发 fail this full-text
  // check and can only follow the origin/general-brief path.
  if (messageSource === "USER_TURN" && isResolvableBareCity(question)) return "MODEL";
  return messageSource === "ASSISTANT_REPLY"
    && (ASSISTANT_PRONOUN_DESTINATION_COMMAND.test(question) || ASSISTANT_DESTINATION_ACKNOWLEDGMENT.test(question))
    ? "MODEL"
    : "SKIP";
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
  if (destinationCuePreflight(params.question, params.messageSource ?? "USER_TURN") !== "MODEL") return null;
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
    const isExplicitCommand = candidate.intent === "EXPLICIT_SET_DESTINATION"
      && candidate.triggerContext === "EXPLICIT_DESTINATION_COMMAND";
    const isBareUserCity = (params.messageSource ?? "USER_TURN") === "USER_TURN"
      && isResolvableBareCity(params.question)
      && candidate.intent === "DESTINATION_INTEREST"
      && candidate.triggerContext === "BARE_CITY";
    const isRouteDestination = (params.messageSource ?? "USER_TURN") === "USER_TURN"
      && EXPLICIT_ROUTE_TO_DESTINATION.test(params.question)
      && candidate.intent === "DESTINATION_INTEREST"
      && candidate.triggerContext === "FLIGHT_DESTINATION";
    if (!isExplicitCommand && !isBareUserCity && !isRouteDestination) continue;
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
      intent: isBareUserCity || isRouteDestination ? "DESTINATION_INTEREST" : "EXPLICIT_SET_DESTINATION",
      triggerContext: isBareUserCity
        ? "BARE_CITY"
        : isRouteDestination
          ? "FLIGHT_DESTINATION"
          : "EXPLICIT_DESTINATION_COMMAND",
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
