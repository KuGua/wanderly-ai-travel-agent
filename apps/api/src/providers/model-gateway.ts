import type { FlightOffer, StayOffer, GroundOffer, PlanDiff } from "../types/domain.js";

/**
 * ModelGateway: Application-layer interface for AI model interactions.
 * The model cannot access the database or execute irreversible operations.
 * Future: swap with OpenAI Agents SDK, Bedrock, etc.
 */
export interface ModelGateway {
  generateStructuredPlan(params: {
    destination: string;
    flights: FlightOffer[];
    stays: StayOffer[];
    ground: GroundOffer[];
    memberPreferences: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;

  explainPlanDiff(params: {
    oldPlan: Record<string, unknown>;
    newPlan: Record<string, unknown>;
  }): Promise<PlanDiff>;
}

/**
 * Mock ModelGateway: returns deterministic structured output.
 * In production, this would call an LLM API.
 */
export class MockModelGateway implements ModelGateway {
  async generateStructuredPlan(params: {
    destination: string;
    flights: FlightOffer[];
    stays: StayOffer[];
    ground: GroundOffer[];
    memberPreferences: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    // Simple deterministic heuristic: choose one non-red-eye/cheapest flight
    // per origin, then the cheapest stay and airport transfer.
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
}
