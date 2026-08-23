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
    // Simple heuristic: pick best flight (non-red-eye if possible, cheapest)
    const bestFlight = params.flights
      .filter(f => !f.isRedEye)
      .sort((a, b) => a.priceUsd - b.priceUsd)[0] ?? params.flights[0];

    const bestStay = params.stays.sort((a, b) => a.pricePerNightUsd - b.pricePerNightUsd)[0];
    const bestGround = params.ground.filter(g => g.type === "airport_transfer")[0];

    return {
      destination: params.destination,
      flights: bestFlight ? [bestFlight] : [],
      stays: bestStay ? [bestStay] : [],
      ground: bestGround ? [bestGround] : [],
      generatedAt: new Date().toISOString(),
    };
  }

  async explainPlanDiff(params: {
    oldPlan: Record<string, unknown>;
    newPlan: unknown;
  }): Promise<PlanDiff> {
    return {
      added: ["New flight option due to price change"],
      removed: ["Old flight option (price increased)"],
      changed: ["Total estimated cost updated"],
    };
  }
}
