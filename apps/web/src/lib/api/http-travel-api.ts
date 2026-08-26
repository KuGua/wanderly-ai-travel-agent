import { ApiClient, type GetAccessToken } from "./client";
import {
  conversationTurnRequestSchema,
  conversationTurnAcceptedResponseSchema,
  agentRunResponseSchema,
  agentStreamEventSchema,
  createThreadInputSchema,
  createThreadResponseSchema,
  ownerConversationResponseSchema,
  profileResponseSchema,
  tripsResponseSchema,
  threadsResponseSchema,
  updateProfileInputSchema,
  updateProfileResponseSchema,
  locationReferenceInputSchema,
  locationReferenceResponseSchema,
  type UpdateProfileInput,
  type ConversationTurnRequest,
  type CreateThreadInput,
} from "./contracts";
import type { TravelApi } from "./travel-api";

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

  getLocationReference(input: import("./contracts").LocationReferenceInput) {
    const body = locationReferenceInputSchema.parse(input);
    return this.client.request("/explore/location-reference", locationReferenceResponseSchema, {
      method: "POST", body: JSON.stringify(body),
    });
  }

  getThreads() {
    return this.client.request("/threads", threadsResponseSchema);
  }

  createThread(input: CreateThreadInput) {
    const body = createThreadInputSchema.parse(input);
    return this.client.request("/threads", createThreadResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    });
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
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
