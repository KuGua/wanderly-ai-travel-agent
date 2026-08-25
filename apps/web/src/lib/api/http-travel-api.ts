import { ApiClient, type GetAccessToken } from "./client";
import {
  conversationTurnRequestSchema,
  conversationTurnResponseSchema,
  createThreadInputSchema,
  createThreadResponseSchema,
  ownerConversationResponseSchema,
  profileResponseSchema,
  tripsResponseSchema,
  threadsResponseSchema,
  updateProfileInputSchema,
  updateProfileResponseSchema,
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
      conversationTurnResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }
}
