import { z } from "zod";

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
  renameThreadInputSchema,
  suggestThreadTitleInputSchema,
  suggestThreadTitleResponseSchema,
  threadSchema,
  memoryFactSchema,
  memoryNotesResponseSchema,
  preferenceCardResolveResponseSchema,
  preferenceCardSchema,
  profileMemoryResponseSchema,
  rememberHighlightResponseSchema,
  researchCommandRequestSchema,
  researchCommandAcceptedResponseSchema,
  latestResearchResultResponseSchema,
  soloAdoptPlanResponseSchema,
  tripMemoryFactSchema,
  tripMemoryGroupResponseSchema,
  tripMemoryOverridesResponseSchema,
  profileResponseSchema,
  resolveProposalResponseSchema,
  updateMemoryFactInputSchema,
  tripActivationRequestSchema,
  tripActivationResponseSchema,
  updateTripTitleInputSchema,
  updateTripTitleResponseSchema,
  updateDraftTripBriefInputSchema,
  updateDraftTripBriefResponseSchema,
  dismissDraftTripBriefProposalResponseSchema,
  destinationCueActionInputSchema,
  destinationCueActionResponseSchema,
  offerCueSchema,
  offerCueActionInputSchema,
  offerCueActionResponseSchema,
  personalOfferSelectionSchema,
  personalOfferSelectionListResponseSchema,
  tripSearchPreferencesInputSchema,
  tripSearchPreferencesResponseSchema,
  planningTaskAcceptedResponseSchema,
  quoteNationalityDecisionSchema,
  staySearchAuthorizationsResponseSchema,
  latestPlanningRunResponseSchema,
  tripPlanningRunDetailResponseSchema,
  latestPlanResponseSchema,
  tripDetailResponseSchema,
  invitationPreviewResponseSchema,
  acceptInvitationResponseSchema,
  declineInvitationResponseSchema,
  createTripInvitationInputSchema,
  tripInvitationCreateResponseSchema,
  tripsResponseSchema,
  threadsResponseSchema,
  updateProfileInputSchema,
  updateProfileResponseSchema,
  type UpdateMemoryFactInput,
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
  // ── Member conversation handoff (Phase 6) ─────────────────────────────
  constraintHandoffBatchResponseSchema,
  constraintHandoffConfirmRequestSchema,
  constraintHandoffConfirmResponseSchema,
  // ── Global POI & ground mobility (Phase 2) ──────────────────────────────────
  tripPlacesResponseSchema,
  placeCandidateSearchRequestSchema,
  placeCandidateSearchResponseSchema,
  proposeTripPlaceRequestSchema,
  adoptTripPlaceRequestSchema,
  revokeTripPlaceRequestSchema,
  tripPlaceActionResponseSchema,
  routeEvidenceListSchema,
  navigationRouteSearchRequestSchema,
  navigationRouteSearchResponseSchema,
  mobilityOfferListSchema,
  mobilitySearchRequestSchema,
  mobilitySearchResponseSchema,
  mobilityOfferSelectionRequestSchema,
  mobilityOfferSelectionResponseSchema,
  personalResearchAnswersRequestSchema,
  personalResearchConfirmRequestSchema,
  personalResearchConfirmAcceptedResponseSchema,
  personalResearchReadResponseSchema,
  type UpdateProfileInput,
  type ConversationTurnRequest,
  type CreateTripThreadInput,
  type ExplorationStartRequest,
  type TripActivationRequest,
  type UpdateTripTitleInput,
  type UpdateDraftTripBriefInput,
  type TripSearchPreferencesInput,
  type QuoteNationalityDecision,
  type PersonalResearchAnswersRequest,
  type PersonalResearchConfirmRequest,
  type PersonalResearchReadResponse,
  type PersonalResearchConfirmAcceptedResponse,
  type CreateTripConstraintProposalRequest,
  type ConfirmTripConstraintProposalRequest,
  type UpsertTripConstraintFactRequest,
  type CastAdoptionVoteRequest,
  type ConstraintHandoffBatchResponse,
  type ConstraintHandoffConfirmRequest,
  type ResearchCommandRequest,
  type ResearchCommandAcceptedResponse,
  type LatestResearchResultResponse,
  type SoloAdoptPlanResponse,
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

  getPreferenceCard(tripId: string) {
    return this.client.request(`/trips/${tripId}/preference-card`, preferenceCardSchema);
  }

  resolvePreferenceCard(tripId: string, adjustments: Array<{ fieldKey: string; value: unknown }>) {
    return this.client.request(`/trips/${tripId}/preference-card`, preferenceCardResolveResponseSchema, {
      method: "POST",
      body: JSON.stringify({ adjustments }),
    });
  }

  rememberHighlight(input: { highlight: string; sourceThreadId?: string | null; sourceMessageId?: string | null }) {
    return this.client.request("/profiles/me/memory/highlights", rememberHighlightResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getMemoryNotes() {
    return this.client.request("/profiles/me/memory/notes", memoryNotesResponseSchema);
  }

  async deleteMemoryNote(noteId: string) {
    await this.client.request(`/profiles/me/memory/notes/${noteId}`, z.unknown(), { method: "DELETE" });
  }

  getProfileMemory() {
    return this.client.request("/profiles/me/memory", profileMemoryResponseSchema);
  }

  updateMemoryFact(factId: string, input: UpdateMemoryFactInput) {
    const body = updateMemoryFactInputSchema.parse(input);
    return this.client.request(`/profiles/me/memory/facts/${factId}`, memoryFactSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteMemoryFact(factId: string) {
    // 204 No Content: nothing to parse, so the schema is a passthrough.
    await this.client.request(`/profiles/me/memory/facts/${factId}`, z.unknown(), {
      method: "DELETE",
    });
  }

  confirmMemoryProposal(proposalId: string) {
    return this.client.request(
      `/profiles/me/memory/proposals/${proposalId}/confirm`,
      resolveProposalResponseSchema,
      { method: "POST" },
    );
  }

  dismissMemoryProposal(proposalId: string) {
    return this.client.request(
      `/profiles/me/memory/proposals/${proposalId}/dismiss`,
      resolveProposalResponseSchema,
      { method: "POST" },
    );
  }

  getTripMemoryOverrides(tripId: string) {
    return this.client.request(`/trips/${tripId}/memory/me`, tripMemoryOverridesResponseSchema);
  }

  getTripMemoryGroupDecisions(tripId: string) {
    return this.client.request(`/trips/${tripId}/memory`, tripMemoryGroupResponseSchema);
  }

  saveTripMemoryOverride(tripId: string, fieldKey: string, value: unknown) {
    return this.client.request(
      `/trips/${tripId}/memory/me/overrides/${encodeURIComponent(fieldKey)}`,
      tripMemoryFactSchema,
      { method: "PUT", body: JSON.stringify({ value }) },
    );
  }

  saveTripMemoryGroupDecision(tripId: string, fieldKey: string, value: unknown) {
    return this.client.request(
      `/trips/${tripId}/memory/group-decisions/${encodeURIComponent(fieldKey)}`,
      tripMemoryFactSchema,
      { method: "PUT", body: JSON.stringify({ value }) },
    );
  }

  async deleteTripMemory(tripId: string, factId: string) {
    await this.client.request(`/trips/${tripId}/memory/${factId}`, z.unknown(), {
      method: "DELETE",
    });
  }

  getTrips() {
    return this.client.request("/trips", tripsResponseSchema);
  }

  getTrip(tripId: string) {
    return this.client.request("/trips/" + encodeURIComponent(tripId), tripDetailResponseSchema);
  }

  getInvitationPreview(inviteToken: string, locale?: "en" | "zh") {
    // The server redacts a system-generated Draft title and renders a generic
    // placeholder in its place; it needs the reader's own language to do that.
    const query = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    return this.client.request("/trip-invitations/" + encodeURIComponent(inviteToken) + query, invitationPreviewResponseSchema);
  }

  acceptInvitation(inviteToken: string) {
    return this.client.request("/trip-invitations/" + encodeURIComponent(inviteToken) + "/accept", acceptInvitationResponseSchema, { method: "POST" });
  }

  declineInvitation(inviteToken: string) {
    return this.client.request("/trip-invitations/" + encodeURIComponent(inviteToken) + "/decline", declineInvitationResponseSchema, { method: "POST" });
  }

  createTripInvitation(tripId: string, input: import("./contracts").CreateTripInvitationInput) {
    const body = createTripInvitationInputSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/invitations`,
      tripInvitationCreateResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
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

  renameThread(tripId: string, threadId: string, input: import("./contracts").RenameThreadInput) {
    const body = renameThreadInputSchema.parse(input);
    return this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/threads/" + encodeURIComponent(threadId) + "/title",
      threadSchema,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  }

  suggestThreadTitle(
    tripId: string,
    threadId: string,
    input: import("./contracts").SuggestThreadTitleInput,
  ) {
    const body = suggestThreadTitleInputSchema.parse(input);
    return this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/threads/" + encodeURIComponent(threadId) + "/title/suggest",
      suggestThreadTitleResponseSchema,
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

  async dismissResearchIntent(runId: string): Promise<void> {
    // The server returns 204 No Content; we ignore the empty body and
    // resolve with `void`. The mutation hook observes TanStack's
    // `onSuccess` so a successful dismiss invalidates the run query.
    await this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/dismiss-intent",
      z.unknown(),
      { method: "POST" },
    );
  }

  async getRouteEndpoints(tripId: string): Promise<Array<{ placeId: string; displayName: string }>> {
    const response = await this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/route-endpoints",
      z.object({ endpoints: z.array(z.object({ placeId: z.string().uuid(), displayName: z.string() }).strict()) }).strict(),
    ) as { endpoints: Array<{ placeId: string; displayName: string }> };
    return response.endpoints;
  }

  async saveRouteSelection(runId: string, input: { originPlaceId: string; destinationPlaceId: string; mode: "WALK" | "DRIVE" | "CYCLE" }): Promise<void> {
    await this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/route-selection",
      z.unknown(),
      { method: "PUT", body: JSON.stringify(input) },
    );
  }

  // ─── DRAFT Personal Research (docs/draft-personal-research-implementation.md) ──

  async getPersonalResearch(runId: string): Promise<PersonalResearchReadResponse> {
    return this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/personal-research",
      personalResearchReadResponseSchema,
    );
  }

  async savePersonalResearchAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void> {
    const body = personalResearchAnswersRequestSchema.parse(input);
    await this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/personal-research/answers",
      z.unknown(),
      { method: "PUT", body: JSON.stringify(body) },
    );
  }

  async confirmPersonalResearch(runId: string, input: PersonalResearchConfirmRequest): Promise<PersonalResearchConfirmAcceptedResponse> {
    const body = personalResearchConfirmRequestSchema.parse(input);
    return this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/personal-research/confirm",
      personalResearchConfirmAcceptedResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  async cancelPersonalResearch(runId: string): Promise<PersonalResearchReadResponse> {
    return this.client.request(
      "/agent-runs/" + encodeURIComponent(runId) + "/personal-research/cancel",
      personalResearchReadResponseSchema,
      { method: "POST" },
    );
  }

  subscribeAgentRun(
    runId: string,
    signal: AbortSignal,
    onEvent: (event: import("./contracts").AgentStreamEvent) => void,
    options?: { lastEventId?: string },
  ) {
    return this.client.stream(
      "/agent-runs/" + encodeURIComponent(runId) + "/events",
      signal,
      (eventName, data) => {
        const parsed = agentStreamEventSchema.safeParse({ ...asRecord(data), event: eventName });
        if (parsed.success) onEvent(parsed.data);
      },
      options,
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

  async deleteTrip(tripId: string) {
    // 204 No Content: nothing to parse, so the schema is a passthrough.
    await this.client.request("/trips/" + encodeURIComponent(tripId), z.unknown(), { method: "DELETE" });
  }

  updateDraftTripBrief(tripId: string, input: UpdateDraftTripBriefInput) {
    const body = updateDraftTripBriefInputSchema.parse(input);
    return this.client.request("/trips/" + encodeURIComponent(tripId) + "/draft-brief", updateDraftTripBriefResponseSchema, {
      method: "PATCH", body: JSON.stringify(body),
    });
  }

  dismissDraftTripBriefProposal(tripId: string) {
    return this.client.request(
      "/trips/" + encodeURIComponent(tripId) + "/draft-brief-proposal",
      dismissDraftTripBriefProposalResponseSchema,
      { method: "DELETE" },
    );
  }

  acceptDestinationCue(threadId: string, cueId: string, candidateId: string, input: import("./contracts").DestinationCueActionInput) {
    return this.destinationCueAction(threadId, cueId, candidateId, "accept", input);
  }

  dismissDestinationCue(threadId: string, cueId: string, candidateId: string, input: import("./contracts").DestinationCueActionInput) {
    return this.destinationCueAction(threadId, cueId, candidateId, "dismiss", input);
  }

  private destinationCueAction(
    threadId: string,
    cueId: string,
    candidateId: string,
    action: "accept" | "dismiss",
    input: import("./contracts").DestinationCueActionInput,
  ) {
    const body = destinationCueActionInputSchema.parse(input);
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/destination-cues/${encodeURIComponent(cueId)}/candidates/${encodeURIComponent(candidateId)}/${action}`,
      destinationCueActionResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  // ─── Flight / Hotel Offer Cue (docs/flight-offer-cue-model-draft.md,
  //     docs/hotel-offer-cue-model-draft.md) ────────────────────────────────
  listOfferCues(threadId: string, capability?: "flight" | "hotel") {
    const qs = capability ? `?capability=${encodeURIComponent(capability)}` : "";
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/offer-cues${qs}`,
      z.object({ cues: z.array(offerCueSchema) }).strict(),
      { method: "GET" },
    );
  }

  acceptFlightOfferCue(threadId: string, cueId: string, candidateId: string, input: import("./contracts").OfferCueActionInput) {
    return this.offerCueAction(threadId, cueId, candidateId, "flight", "accept", input);
  }

  dismissFlightOfferCue(threadId: string, cueId: string, candidateId: string, input: import("./contracts").OfferCueActionInput) {
    return this.offerCueAction(threadId, cueId, candidateId, "flight", "dismiss", input);
  }

  acceptHotelOfferCue(threadId: string, cueId: string, candidateId: string, input: import("./contracts").OfferCueActionInput) {
    return this.offerCueAction(threadId, cueId, candidateId, "hotel", "accept", input);
  }

  dismissHotelOfferCue(threadId: string, cueId: string, candidateId: string, input: import("./contracts").OfferCueActionInput) {
    return this.offerCueAction(threadId, cueId, candidateId, "hotel", "dismiss", input);
  }

  selectFlightOfferFromCard(threadId: string, candidateId: string, input: Omit<import("./contracts").OfferCueActionInput, "source">) {
    return this.acceptFlightOfferCue(threadId, candidateId, candidateId, { ...input, source: "RESULT_CARD_BUTTON" });
  }

  selectHotelOfferFromCard(threadId: string, candidateId: string, input: Omit<import("./contracts").OfferCueActionInput, "source">) {
    return this.acceptHotelOfferCue(threadId, candidateId, candidateId, { ...input, source: "RESULT_CARD_BUTTON" });
  }

  listOfferSelections(threadId: string) {
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/offer-selections`,
      personalOfferSelectionListResponseSchema,
      { method: "GET" },
    );
  }

  deleteOfferSelection(threadId: string, selectionId: string, input: { requestId: string; expectedVersion: number }) {
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/offer-selections/${encodeURIComponent(selectionId)}`,
      z.object({ selection: personalOfferSelectionSchema.nullable() }).strict(),
      { method: "DELETE", body: JSON.stringify(input) },
    );
  }

  private offerCueAction(
    threadId: string,
    cueId: string,
    candidateId: string,
    capability: "flight" | "hotel",
    action: "accept" | "dismiss",
    input: import("./contracts").OfferCueActionInput,
  ) {
    const body = offerCueActionInputSchema.parse(input);
    return this.client.request(
      `/threads/${encodeURIComponent(threadId)}/offer-cues/${encodeURIComponent(cueId)}/candidates/${encodeURIComponent(candidateId)}/${action}`,
      offerCueActionResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  saveTripSearchPreferences(tripId: string, input: TripSearchPreferencesInput) {
    const body = tripSearchPreferencesInputSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/search-preferences`,
      tripSearchPreferencesResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  startPlanning(tripId: string, quoteNationalityDecision?: QuoteNationalityDecision) {
    const decision = quoteNationalityDecision
      ? quoteNationalityDecisionSchema.parse(quoteNationalityDecision)
      : undefined;
    return this.client.request("/planning/generate", planningTaskAcceptedResponseSchema, {
      method: "POST", body: JSON.stringify({ tripId, ...(decision ? { quoteNationalityDecision: decision } : {}) }),
    });
  }

  listStaySearchAuthorizations(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/stay-search-provider-authorizations`,
      staySearchAuthorizationsResponseSchema,
    );
  }

  getLatestPlanningRun(tripId: string) {
    return this.client.request(`/planning/${encodeURIComponent(tripId)}/run/latest`, latestPlanningRunResponseSchema);
  }

  getTripPlanningRunDetail(tripId: string, runId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/runs/${encodeURIComponent(runId)}`,
      tripPlanningRunDetailResponseSchema,
    );
  }

  getLatestPlan(tripId: string) {
    return this.client.request(`/planning/${encodeURIComponent(tripId)}/latest`, latestPlanResponseSchema);
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

  getConstraintHandoffBatch(tripId: string, batchId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraint-handoffs/${encodeURIComponent(batchId)}`,
      constraintHandoffBatchResponseSchema,
    );
  }

  confirmConstraintHandoffBatch(
    tripId: string,
    batchId: string,
    input: ConstraintHandoffConfirmRequest,
    options?: { idempotencyKey?: string },
  ) {
    const body = constraintHandoffConfirmRequestSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/constraint-handoffs/${encodeURIComponent(batchId)}/confirm`,
      constraintHandoffConfirmResponseSchema,
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

  // ─── Phase 6 / Personal Trip Orchestrator ───────────────────────────────
  postResearchCommand(
    tripId: string,
    input: import("./contracts").ResearchCommandRequest,
    options?: { idempotencyKey?: string },
  ): Promise<import("./contracts").ResearchCommandAcceptedResponse> {
    const body = researchCommandRequestSchema.parse(input);
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/research`,
      researchCommandAcceptedResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(body),
        ...(options?.idempotencyKey ? { headers: { "Idempotency-Key": options.idempotencyKey } } : {}),
      },
    ) as Promise<import("./contracts").ResearchCommandAcceptedResponse>;
  }

  getLatestResearchResult(tripId: string): Promise<import("./contracts").LatestResearchResultResponse> {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/research/latest`,
      latestResearchResultResponseSchema,
    );
  }

  acceptSoloPlan(
    planId: string,
    options?: { idempotencyKey?: string },
  ): Promise<import("./contracts").SoloAdoptPlanResponse> {
    return this.client.request(
      `/plans/${encodeURIComponent(planId)}/accept-solo`,
      soloAdoptPlanResponseSchema,
      {
        method: "POST",
        ...(options?.idempotencyKey ? { headers: { "Idempotency-Key": options.idempotencyKey } } : {}),
      },
    ) as Promise<import("./contracts").SoloAdoptPlanResponse>;
  }

  // ─── Phase 3 navigation route evidence ──────────────────────────────────
  listRouteEvidence(tripId: string, planId?: string) {
    const query = planId ? `?planId=${encodeURIComponent(planId)}` : "";
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/route-evidence${query}`,
      routeEvidenceListSchema,
    );
  }

  searchRoute(tripId: string, planId: string, input: z.infer<typeof navigationRouteSearchRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/plans/${encodeURIComponent(planId)}/routes`,
      navigationRouteSearchResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  // ─── Phase 5 mobility offers ──────────────────────────────────────────
  listMobilityOffers(tripId: string) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/mobility-offers`,
      mobilityOfferListSchema,
    );
  }

  searchMobilityOffers(tripId: string, input: z.infer<typeof mobilitySearchRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/mobility-offers:search`,
      mobilitySearchResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
    );
  }

  selectMobilityOffer(tripId: string, input: z.infer<typeof mobilityOfferSelectionRequestSchema>, options?: { idempotencyKey?: string }) {
    return this.client.request(
      `/trips/${encodeURIComponent(tripId)}/mobility-offers:select`,
      mobilityOfferSelectionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...withIdempotencyKey(options?.idempotencyKey),
      },
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
