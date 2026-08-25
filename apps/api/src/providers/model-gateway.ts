import type { FlightOffer, StayOffer, GroundOffer, PlanDiff } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import type { ConversationPlace, ConversationResponseMode } from "../types/schemas.js";

export interface ConversationHistoryMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ConversationReply {
  content: string;
  responseMode: ConversationResponseMode;
}

/**
 * ModelGateway: Application-layer interface for AI model interactions.
 * The model cannot access the database or execute irreversible operations.
 */
export interface ModelGateway {
  generateStructuredPlan(params: {
    destination: string;
    flights: FlightOffer[];
    stays: StayOffer[];
    ground: GroundOffer[];
    memberPreferences: Record<string, unknown>;
    signal?: AbortSignal;
    ctx?: { correlationId: string };
  }): Promise<Record<string, unknown>>;

  explainPlanDiff(params: {
    oldPlan: Record<string, unknown>;
    newPlan: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<PlanDiff>;

  generateConversationReply(params: {
    question: string;
    place?: ConversationPlace;
    history: ConversationHistoryMessage[];
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<ConversationReply>;
}

/**
 * Mock ModelGateway: deterministic output, signal-aware for cancellation parity
 * with the real gateway. Aborts promptly when an already-aborted signal is
 * supplied so Skill timeout tests exercise the same fail path.
 */
export class MockModelGateway implements ModelGateway {
  async generateStructuredPlan(params: {
    destination: string;
    flights: FlightOffer[];
    stays: StayOffer[];
    ground: GroundOffer[];
    memberPreferences: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    if (params.signal?.aborted) {
      const err = new Error("MockModelGateway aborted");
      err.name = "AbortError";
      throw err;
    }

    const origins = [...new Set(params.flights.map(flight => flight.origin))].sort();
    const bestFlights = origins.map(origin => {
      const originFlights = params.flights.filter(flight => flight.origin === origin);
      const preferredFlights = originFlights.some(flight => !flight.isRedEye)
        ? originFlights.filter(flight => !flight.isRedEye)
        : originFlights;

      return [...preferredFlights].sort((a, b) =>
        a.priceUsd - b.priceUsd || a.id.localeCompare(b.id)
      )[0];
    });

    const bestStay = [...params.stays].sort((a, b) =>
      a.pricePerNightUsd - b.pricePerNightUsd || a.id.localeCompare(b.id)
    )[0];
    const bestGround = params.ground.filter(g => g.type === "airport_transfer")[0];
    const capturedAt = [
      ...bestFlights.map(flight => flight.capturedAt),
      bestStay?.capturedAt,
      bestGround?.capturedAt,
    ].filter((value): value is string => Boolean(value)).sort().at(-1);

    return {
      destination: params.destination,
      flights: bestFlights,
      stays: bestStay ? [bestStay] : [],
      ground: bestGround ? [bestGround] : [],
      generatedAt: capturedAt,
    };
  }

  async explainPlanDiff(): Promise<PlanDiff> {
    return {
      added: ["New flight option due to price change"],
      removed: ["Old flight option (price increased)"],
      changed: ["Total estimated cost updated"],
    };
  }

  async generateConversationReply(params: {
    question: string;
    place?: ConversationPlace;
    history: ConversationHistoryMessage[];
    signal?: AbortSignal;
  }): Promise<ConversationReply> {
    if (params.signal?.aborted) {
      const err = new Error("MockModelGateway aborted");
      err.name = "AbortError";
      throw err;
    }

    const place = params.place;
    const placeText = place
      ? place.sourceType === "INSPIRATION"
        ? `${place.name} is an unverified inspiration at ${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}.`
        : `${place.name} is available as a fixture-backed demo destination.`
      : "No destination is selected yet.";

    return {
      content:
        `${placeText} I can help you explore preferences and planning questions, `
        + "but this demo response does not claim live prices, inventory, visa requirements, or booking availability.",
      responseMode: "DEMO_FALLBACK",
    };
  }
}
