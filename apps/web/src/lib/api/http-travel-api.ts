import { ApiClient, type GetAccessToken } from "./client";
import { z } from "zod";
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
  // ── Team Agent 协作编排 (Phase 5) ─────────────────────────────────────────
  tripConstraintProposalSchema,
  tripConstraintProposalsResponseSchema,
  tripConstraintsResponseSchema,
  tripConstraintsOwnerResponseSchema,
  tripPlansListResponseSchema,
  createTripConstraintProposalRequestSchema,
  confirmTripConstraintProposalRequestSchema,
  upsertTripConstraintFactRequestSchema,
  castAdoptionVoteRequestSchema,
  adoptionVoteResponseSchema,
  adoptionVoteListResponseSchema,
  confirmProposalResponseSchema,
  upsertFactResponseSchema,
  // ── Global POI & ground mobility (Phase 2) ──────────────────────────────────
  tripPlacesResponseSchema,
  placeCandidateSearchRequestSchema,
  placeCandidateSearchResponseSchema,
  proposeTripPlaceRequestSchema,
  adoptTripPlaceRequestSchema,
  revokeTripPlaceRequestSchema,
  tripPlaceActionResponseSchema,
  researchResultSchema,
  type UpdateProfileInput,
  type ConversationTurnRequest,
  type CreateTripThreadInput,
  type ExplorationStartRequest,
  type TripActivationRequest,
  type UpdateTripTitleInput,
  type UpdateDraftTripBriefInput,
  type CreateTripConstraintProposalRequest,
  type ConfirmTripConstraintProposalRequest,
  type UpsertTripConstraintFactRequest,
  type CastAdoptionVoteRequest,
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

  // ── Team Agent 协作编排 (Phase 5) ─────────────────────────────────────────

  createConstraintProposal(
    tripId: string,
    input: CreateTripConstraintProposalRequest,
    options?: { idempotencyKey?: string },
  ) {
    const body = createTripConstraintProposalRequestSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraint-proposals`,
      tripConstraintProposalSchema,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  listMyConstraintProposals(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraint-proposals/me`,
      tripConstraintProposalsResponseSchema,
    );
  }

  confirmConstraintProposal(
    tripId: string,
    proposalId: string,
    input: ConfirmTripConstraintProposalRequest,
    options?: { idempotencyKey?: string },
  ) {
    const body = confirmTripConstraintProposalRequestSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraint-proposals/${encodeURIComponent(proposalId)}/confirm`,
      confirmProposalResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  dismissConstraintProposal(
    tripId: string,
    proposalId: string,
    options?: { idempotencyKey?: string },
  ) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraint-proposals/${encodeURIComponent(proposalId)}/dismiss`,
      dismissConstraintProposalResponseSchema,
      {
        method: "POST",
        body: "{}",
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  upsertConstraintFact(
    tripId: string,
    factId: string,
    input: UpsertTripConstraintFactRequest,
    options?: { idempotencyKey?: string },
  ) {
    const body = upsertTripConstraintFactRequestSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraints/${encodeURIComponent(factId)}`,
      upsertFactResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify(body),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  revokeConstraintFact(
    tripId: string,
    factId: string,
    options?: { idempotencyKey?: string },
  ) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraints/${encodeURIComponent(factId)}`,
      upsertFactResponseSchema,
      {
        method: "DELETE",
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  listConstraintsForMembers(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraints`,
      tripConstraintsResponseSchema,
    );
  }

  listConstraintsForOwner(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraints/me`,
      tripConstraintsOwnerResponseSchema,
    );
  }

  castAdoptionVote(
    planId: string,
    input: CastAdoptionVoteRequest,
    options?: { idempotencyKey?: string },
  ) {
    const body = castAdoptionVoteRequestSchema.parse(input);
    return this.client.request(
      `/plans/${encodeURIComponent(planId)}/adoption-votes`,
      adoptionVoteResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  listAdoptionVotes(planId: string) {
    return this.client.request(
      `/plans/${encodeURIComponent(planId)}/adoption-votes`,
      adoptionVoteListResponseSchema,
    );
  }

  listTripPlans(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/plans`,
      tripPlansListResponseSchema,
    );
  }

  // ─── Global POI & ground mobility (Phase 2) ──────────────────────────────────
  listTripPlaces(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/places`,
      tripPlacesResponseSchema,
    );
  }

  searchPlaceCandidates(tripId: string, input: z.infer<typeof placeCandidateSearchRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/places:search`,
      placeCandidateSearchResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  proposeTripPlace(tripId: string, input: z.infer<typeof proposeTripPlaceRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/places:propose`,
      tripPlaceActionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  adoptTripPlace(tripId: string, input: z.infer<typeof adoptTripPlaceRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/places:adopt`,
      tripPlaceActionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  revokeTripPlace(tripId: string, input: z.infer<typeof revokeTripPlaceRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/places:revoke`,
      tripPlaceActionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  // ─── Phase 4 non-blocking research summary ─────────────────────────────────
  getResearchResult(tripId: string, agentTaskRunId?: string) {
    const params = agentTaskRunId ? `?agentTaskRunId=${encodeURIComponent(agentTaskRunId)}` : "";
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/research-results${params}`,
      researchResultSchema,
    );
  }
}

function withIdempotencyKey(key: string | undefined): { headers: Record<string, string> } {
  if (!key) return { headers: {} };
  return { headers: { "idempotency-key": key } };
}

const dismissConstraintProposalResponseSchema = z.object({
  dismissed: z.literal(true),
  proposalId: z.string().uuid(),
}).strict();

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
