import { ApiClient, type GetAccessToken } from "./client";
import {
  conversationTurnRequestSchema,
  conversationTurnAcceptedResponseSchema,
  agentRunResponseSchema,
  agentStreamEventSchema,
  createThreadResponseSchema,
  createTripThreadInputSchema,
  explorationStartRequestSchema,
  explorationStartResponseSchema,
  ownerConversationResponseSchema,
  profileResponseSchema,
  tripActivationRequestSchema,
  tripActivationResponseSchema,
  updateTripTitleInputSchema,
  updateTripTitleResponseSchema,
  updateDraftTripBriefInputSchema,
  updateDraftTripBriefResponseSchema,
  tripDetailResponseSchema,
  tripsResponseSchema,
  threadsResponseSchema,
  updateProfileInputSchema,
  updateProfileResponseSchema,
  locationReferenceInputSchema,
  locationReferenceResponseSchema,
  type UpdateProfileInput,
  type ConversationTurnRequest,
  type CreateTripThreadInput,
  type ExplorationStartRequest,
  type TripActivationRequest,
  type UpdateTripTitleInput,
  type UpdateDraftTripBriefInput,
} from "./contracts";
import type { TravelApi } from "./travel-api";
import { fetchLocationIntroduction } from "./location-introduction-api";

export class HttpTravelApi implements TravelApi {
  private readonly client: ApiClient;

  constructor(baseUrl: string, fetchImplementation?: typeof fetch, getAccessToken?: GetAccessToken) {
    this.client = new ApiClient(`${baseUrl.replace(/\/$/, "")}/api/v1`, fetchImplementation, getAccessToken);
  }

  getMyProfile() {
    return this.client.request("/profiles/me", profileResponseSchema);
  }

  updateMyProfile(input: UpdateProfileInput) {
    const body = updateProfileInputSchema.parse(input);
    return this.client.request("/profiles/me", updateProfileResponseSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  getTrips() {
    return this.client.request("/trips", tripsResponseSchema);
  }

  getTrip(tripId: string) {
    return this.client.request("/trips/" + encodeURIComponent(tripId), tripDetailResponseSchema);
  }

  getLocationReference(input: import("./contracts").LocationReferenceInput) {
    const body = locationReferenceInputSchema.parse(input);
    return this.client.request("/explore/location-reference", locationReferenceResponseSchema, {
      method: "POST", body: JSON.stringify(body),
    });
  }

  getLocationIntroduction(input: import("./contracts").LocationIntroductionInput, options?: { signal?: AbortSignal }) {
    return fetchLocationIntroduction(this.client, input, options);
  }

  getTripThreads(tripId: string) {
    return this.client.request("/trips/" + encodeURIComponent(tripId) + "/threads", threadsResponseSchema);
  }

  createTripThread(tripId: string, input: CreateTripThreadInput) {
    const body = createTripThreadInputSchema.parse(input);
    return this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/threads",
      createThreadResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  getOrCreateDefaultTripThread(tripId: string) {
    return this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/threads/default",
      createThreadResponseSchema,
      { method: "POST" },
    );
  }

  getOwnerConversation(threadId: string) {
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/conversation`,
      ownerConversationResponseSchema,
    );
  }

  submitConversationTurn(threadId: string, input: ConversationTurnRequest) {
    const body = conversationTurnRequestSchema.parse(input);
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/turns`,
      conversationTurnAcceptedResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  getAgentRun(runId: string) {
    return this.client.request(
      "/agent-runs/" + encodeURIComponent(runId),
      agentRunResponseSchema,
    );
  }

  cancelAgentRun(runId: string) {
    return this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/cancel",
      agentRunResponseSchema,
      { method: "POST" },
    );
  }

  subscribeAgentRun(
    runId: string,
    signal: AbortSignal,
    onEvent: (event: import("./contracts").AgentStreamEvent) => void,
  ) {
    return this.client.stream(
      "/agent-runs/" + encodeURIComponent(runId) + "/events",
      signal,
      (eventName, data) => {
        const parsed = agentStreamEventSchema.safeParse({ ...asRecord(data), event: eventName });
        if (parsed.success) onEvent(parsed.data);
      },
    );
  }

  startExploration(input: ExplorationStartRequest) {
    const body = explorationStartRequestSchema.parse(input);
    return this.client.request(
      "/explorations/start",
      explorationStartResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  activateTrip(tripId: string, input: TripActivationRequest) {
    const body = tripActivationRequestSchema.parse(input);
    return this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/activate",
      tripActivationResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  updateTripTitle(tripId: string, input: UpdateTripTitleInput) {
    const body = updateTripTitleInputSchema.parse(input);
    return this.client.request("/trips/" + encodeURIComponent(tripId) + "/title", updateTripTitleResponseSchema, {
      method: "PATCH", body: JSON.stringify(body),
    });
  }

  updateDraftTripBrief(tripId: string, input: UpdateDraftTripBriefInput) {
    const body = updateDraftTripBriefInputSchema.parse(input);
    return this.client.request("/trips/" + encodeURIComponent(tripId) + "/draft-brief", updateDraftTripBriefResponseSchema, {
      method: "PATCH", body: JSON.stringify(body),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
