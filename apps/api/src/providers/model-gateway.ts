import type { FlightOffer, StayOffer, GroundOffer, PlanDiff } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";
import type { ConversationPlace, ConversationResponseMode } from "../types/schemas.js";

export type ConversationIntent = "auto_intro" | "user_typed";

export interface ConversationHistoryMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ConversationReply {
  content: string;
  responseMode: ConversationResponseMode;
}

export type ConversationDeltaHandler = (delta: string) => void | Promise<void>;

/**
 * Application-layer interface for configured real-model interactions.
 * The model cannot access the database or execute irreversible operations.
 * Tests may inject a deterministic implementation through gateway-factory.
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
    intent?: ConversationIntent;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<ConversationReply>;

  streamConversationReply?(params: {
    question: string;
    place?: ConversationPlace;
    history: ConversationHistoryMessage[];
    intent?: ConversationIntent;
    onDelta: ConversationDeltaHandler;
    signal?: AbortSignal;
    ctx?: RequestContext;
  }): Promise<ConversationReply>;
}
