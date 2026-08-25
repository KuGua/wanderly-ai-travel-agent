import type { FlightOffer, StayOffer, GroundOffer, PlanDiff } from "../types/domain.js";

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
}
