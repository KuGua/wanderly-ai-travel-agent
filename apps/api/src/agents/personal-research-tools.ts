/**
 * The personal research capabilities as tools a model may call, and the
 * dispatcher that runs them.
 *
 * Every definition here mirrors a typed draft in `types/schemas.ts`. The
 * schema stays the authority: arguments are parsed with it before an executor
 * sees them, so a JSON Schema that drifts produces a rejected call rather than
 * a malformed provider request. `personal-research-tools.test.ts` pins the two
 * together.
 *
 * What the model may not supply: `tripId`, `threadId`, `runId` and the owner.
 * Those come from the turn, through the closure — an id the model can write is
 * an id it can invent, and inventing one here would mean researching against
 * somebody else's trip.
 */
import { and, eq } from "drizzle-orm";

import {
  isPersonalResearchCapabilityAllowed,
  type PersonalResearchOperationCapability,
} from "../config/personal-research-allowed-capabilities.js";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import type { ModelToolDefinition, ModelToolDispatcher } from "../providers/model-gateway.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import { recordAudit } from "../services/audit-service.js";
import { executePersonalResearch } from "../services/personal-research-service.js";
import { personalResearchOwnerDraftSchema } from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import { requiresOwnerConfirmation } from "./personal-research-tool-policy.js";

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;

/**
 * `navigation.route` is absent on purpose. Its draft takes two trip-place
 * UUIDs, and nothing in the conversation context carries them, so the model
 * has no way to obtain an id it could pass — the tool could only ever fail.
 * It becomes offerable once place ids reach the prompt.
 *
 * `hotel.search` is absent because it is being taken through the shared
 * research path. `mobility.search` has no supplier credentials.
 */
export const PERSONAL_RESEARCH_TOOLS: readonly ModelToolDefinition[] = Object.freeze([
  {
    name: "places.search",
    description:
      "Find real places within a radius of a point — attractions, restaurants, hotels, transport hubs. "
      + "Returns names and how far away they are, not prices or availability. "
      + "Results are strictly inside radiusMeters, so widen it and call again if nothing comes back. "
      + "Pass the traveller's own words as `keyword` when they named a kind of place (\"ramen\", \"onsen\"); "
      + "leave it null when they only asked what is nearby.",
    parameters: {
      type: "object", additionalProperties: false,
      // `category`, `keyword` and `limit` are nullable in the draft, not
      // optional: the key has to be present even when its value is null.
      // Advertising them as optional made the model omit them and the draft
      // reject the call.
      required: ["latitude", "longitude", "radiusMeters", "category", "keyword", "limit"],
      properties: {
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        radiusMeters: { type: "integer", minimum: 100, maximum: 50000 },
        category: { type: ["string", "null"], enum: ["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER", null] },
        keyword: { type: ["string", "null"], minLength: 1, maxLength: 64 },
        limit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "accommodation.discovery",
    description:
      "Find what kinds of places to stay exist near a point. Returns how many candidates and "
      + "the dominant type. It does NOT quote prices — use hotel search for rates.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["latitude", "longitude", "radiusMeters", "checkIn", "checkOut", "occupancy"],
      properties: {
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        radiusMeters: { type: "integer", minimum: 100, maximum: 50000 },
        checkIn: DATE,
        checkOut: DATE,
        occupancy: {
          type: "object", additionalProperties: false, required: ["adults", "rooms"],
          properties: {
            adults: { type: "integer", minimum: 1, maximum: 8 },
            rooms: { type: "integer", minimum: 1, maximum: 8 },
          },
        },
      },
    },
  },
  {
    name: "activities.search",
    description:
      "Search bookable activities and attraction tickets for a destination and date range. "
      + "Returns how many were found and the price band. Spends supplier quota, so it needs the traveller's go-ahead.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["destinationCode", "startDate", "endDate", "category", "limit"],
      properties: {
        destinationCode: { type: "string", minLength: 1, maxLength: 64 },
        startDate: DATE,
        endDate: DATE,
        category: { type: ["string", "null"], maxLength: 64 },
        limit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "flight.search",
    description:
      "Search live flight offers between two airports. Returns how many offers and the price range. "
      + "Spends a metered supplier allowance, so it needs the traveller's go-ahead.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["originId", "destinationId", "tripType", "departureDate", "returnDate", "adults", "cabin", "currency"],
      properties: {
        originId: { type: "string", minLength: 3, maxLength: 3, description: "IATA airport code" },
        destinationId: { type: "string", minLength: 3, maxLength: 3, description: "IATA airport code" },
        tripType: { type: "string", enum: ["ONE_WAY", "ROUND_TRIP"] },
        departureDate: DATE,
        returnDate: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        adults: { type: "integer", minimum: 1, maximum: 9 },
        cabin: { type: "string", enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] },
        currency: { type: "string", minLength: 3, maxLength: 3 },
      },
    },
  },
]);

/** Tool name to the draft `kind` its arguments complete. */
const DRAFT_KIND: Record<string, string> = {
  "places.search": "PLACES_SEARCH",
  "accommodation.discovery": "ACCOMMODATION_DISCOVERY",
  "activities.search": "ACTIVITIES_SEARCH",
  "flight.search": "FLIGHT_SEARCH",
};

export type PersonalResearchToolContext = {
  ctx: RequestContext;
  ownerUserId: string;
  tripId: string;
  threadId: string;
  runId: string;
  /**
   * Whether the traveller authorised a metered search on this turn, detected
   * server-side from their own words.
   *
   * Without it a capability that needs confirmation could never run. Every
   * call answered NEEDS_CONFIRMATION, including the one right after the
   * traveller said yes, so `activities.search` sat in a loop asking
   * permission it had already been given — and the model, handed the same
   * answer twice, reported that it had found activities it had never looked
   * for.
   */
  userConfirmed: boolean;
  signal: AbortSignal;
};

export function createPersonalResearchDispatcher(
  context: PersonalResearchToolContext,
): ModelToolDispatcher {
  return async (call) => {
    const capability = call.name as PersonalResearchOperationCapability;

    if (!DRAFT_KIND[call.name]) return unavailable("UNKNOWN_TOOL");
    // The tool list is built from the same allow-list, so this is a second
    // reading rather than the first. It stands because the list is assembled
    // once at module load and a capability can be closed after that.
    if (!isPersonalResearchCapabilityAllowed(capability)) return unavailable("NOT_ALLOWED");

    const draft = personalResearchOwnerDraftSchema.safeParse({
      kind: DRAFT_KIND[call.name],
      ...(typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}),
    });
    if (!draft.success) {
      // The failing field paths go back so the model can correct itself.
      // Zod's messages can quote the offending value, which may be user text,
      // so only paths travel.
      const fields = [...new Set(draft.error.issues.map((issue) => issue.path.join(".") || "arguments"))].sort();
      return { outcome: "UNAVAILABLE", reason: "INVALID_ARGUMENTS", fields };
    }

    // Membership is re-read per call rather than trusted from the turn: a
    // conversation can outlive someone's place on the trip, and a tool call
    // is a fresh reason to research against it.
    const [membership] = await db.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
      eq(tripMembers.tripId, context.tripId),
      eq(tripMembers.userId, context.ownerUserId),
    )).limit(1);
    if (!membership) return unavailable("NOT_ALLOWED");

    if (requiresOwnerConfirmation(capability) && !context.userConfirmed) {
      // Not executed, and deliberately not an error. The model is told the
      // call is ready and needs a person's word, so it can put the request to
      // the traveller in its own reply instead of reporting a failure.
      return {
        outcome: "NEEDS_CONFIRMATION",
        capability,
        summary: "This search reaches a paid supplier. Restate what will be searched and ask the traveller to confirm before calling again.",
      };
    }

    const run = {
      id: context.runId,
      createdByUserId: context.ownerUserId,
      tripId: context.tripId,
      threadId: context.threadId,
    } as never;

    let result: unknown;
    try {
      // Through the persisting entry point, not the bare executor. Calling the
      // executor directly ran the search and then dropped what it found: no
      // `personal_research_evidence` row, so the answer had no provenance, the
      // TTL never applied, and the next turn in the same thread could not read
      // back what this one had just looked up. The traveller saw an agent that
      // forgot a supplier answer the moment it finished speaking.
      const executed = await executePersonalResearch({ run, draft: draft.data, signal: context.signal });
      // Signals to the turn that a supplier actually answered, which is what
      // lets the output safety filter admit prices and availability. Only a
      // real provider round trip counts: a refusal, a confirmation prompt or
      // an unavailable result would otherwise license the model to state
      // figures nothing produced.
      result = executed.outcome === "AVAILABLE"
        ? { ...executed.summary, providerDispatched: true }
        : explainToolFailure(executed.summary);
    } catch (error) {
      result = explainToolFailure(unavailable((error as { name?: string })?.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILURE"));
    }

    try {
      await recordAudit({
        ctx: context.ctx,
        action: "PERSONAL_RESEARCH_TOOL_DISPATCH",
        actorUserId: context.ownerUserId,
        tripId: context.tripId,
        // Capability and outcome only. The provider's answer is evidence, not
        // an audit record, and it is already persisted where evidence belongs.
        summary: { capability, outcome: String((result as { outcome?: unknown })?.outcome ?? "UNAVAILABLE") },
      });
    } catch (error) {
      // The search already happened and its evidence is already stored. Losing
      // that because the audit row would not write — and telling the model the
      // supplier failed, which is untrue — trades a real result for a
      // bookkeeping problem. Logged so the gap is visible rather than silent.
      logSafeRuntimeEvent(context.ctx, {
        component: "tool", event: "audit", operation: "personal_research.tool_dispatch",
        outcome: "failure", toolName: call.name,
        errorCode: (error as { code?: string })?.code ?? "AUDIT_WRITE_FAILED",
      });
    }

    return result;
  };
}

function unavailable(reason: string) {
  return { outcome: "UNAVAILABLE", reason } as const;
}

/**
 * What a failure code means, in words the model can pass on.
 *
 * A bare `SEARCH_CONSTRAINTS_INCOMPLETE` told the model only that something
 * went wrong, so it supplied a cause of its own: that the supplier "暂时不支持
 * 查询 2026 年的远期房源". No such limit exists. The real reason was a missing
 * per-trip supplier authorisation, and the traveller spent three turns
 * adjusting dates that were never the problem.
 */
const UNAVAILABLE_EXPLANATION: Record<string, string> = {
  NOT_CONFIGURED: "这项查询的供应商在本环境没有配置，这次查不了。",
  PROVIDER_NOT_APPROVED: "这项能力当前未开放。",
  SEARCH_CONSTRAINTS_INCOMPLETE: "服务端缺少发起这次查询所需的前置条件（例如该行程还没有完成供应商授权）。与日期或城市无关。",
  NO_RESULTS: "供应商这次没有返回结果。可以换个范围、日期或说法再试。",
  RATE_LIMITED: "供应商限流了，稍后可以再试。",
  UPSTREAM_TIMEOUT: "供应商这次没有及时响应。",
  UPSTREAM_FAILURE: "供应商这次调用失败了。",
  INVALID_PROVIDER_RESPONSE: "供应商返回的内容无法解析。",
  DUPLICATE_CALL: "本轮已经用同样的条件查过一次了。",
  INVALID_ARGUMENTS: "调用参数不符合这个工具的要求。",
  NOT_ALLOWED: "当前不允许调用这项能力。",
  UNKNOWN_TOOL: "没有这个工具。",
};

/** Attaches the plain-language reason to a failed result, leaving others as they are. */
export function explainToolFailure(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  if (value.outcome !== "UNAVAILABLE") return result;
  const code = typeof value.reason === "string"
    ? value.reason
    : (value.summary as { errorCode?: unknown } | undefined)?.errorCode;
  const explanation = typeof code === "string" ? UNAVAILABLE_EXPLANATION[code] : undefined;
  return explanation === undefined ? result : { ...value, reason: explanation, reasonCode: code };
}
