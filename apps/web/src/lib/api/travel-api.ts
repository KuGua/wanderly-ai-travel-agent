import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateThreadResponse,
  CreateTripThreadInput,
  OwnerConversationResponse,
  ProfileResponse,
  ThreadsResponse,
  TripDetailResponse,
  TripsResponse,
  UpdateProfileInput,
  UpdateProfileResponse,
  LocationReferenceInput,
  LocationReferenceResponse,
  LocationIntroductionInput,
  LocationIntroductionResponse,
  AgentRun,
  AgentStreamEvent,
  ExplorationStartRequest,
  ExplorationStartResponse,
  TripActivationRequest,
  TripActivationResponse,
  UpdateTripTitleInput,
  UpdateTripTitleResponse,
  UpdateDraftTripBriefInput,
  UpdateDraftTripBriefResponse,
  TripConstraintProposal,
  TripConstraintsResponse,
  TripConstraintsOwnerResponse,
  TripConstraintProposalsResponse,
  CreateTripConstraintProposalRequest,
  ConfirmTripConstraintProposalRequest,
  UpsertTripConstraintFactRequest,
  ConfirmProposalResponse,
  UpsertFactResponse,
  CastAdoptionVoteRequest,
  AdoptionVoteResponse,
  AdoptionVoteListResponse,
  TripPlansListResponse,
  TripPlacesResponse,
  PlaceCandidateSearchRequest,
  PlaceCandidateSearchResponse,
  ProposeTripPlaceRequest,
  AdoptTripPlaceRequest,
  RevokeTripPlaceRequest,
  TripPlaceActionResponse,
} from "./contracts";

export interface TravelApi {
  getMyProfile(): Promise<ProfileResponse>;
  updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResponse>;
  getTrips(): Promise<TripsResponse>;
  getTrip(tripId: string): Promise<TripDetailResponse>;
  getLocationReference(input: LocationReferenceInput): Promise<LocationReferenceResponse>;
  getLocationIntroduction(input: LocationIntroductionInput, options?: { signal?: AbortSignal }): Promise<LocationIntroductionResponse>;
  getTripThreads(tripId: string): Promise<ThreadsResponse>;
  createTripThread(tripId: string, input: CreateTripThreadInput): Promise<CreateThreadResponse>;
  getOrCreateDefaultTripThread(tripId: string): Promise<CreateThreadResponse>;
  getOwnerConversation(threadId: string): Promise<OwnerConversationResponse>;
  submitConversationTurn(threadId: string, input: ConversationTurnRequest): Promise<ConversationTurnAcceptedResponse>;
  getAgentRun(runId: string): Promise<AgentRun>;
  cancelAgentRun(runId: string): Promise<AgentRun>;
  subscribeAgentRun(runId: string, signal: AbortSignal, onEvent: (event: AgentStreamEvent) => void): Promise<void>;
  startExploration(input: ExplorationStartRequest): Promise<ExplorationStartResponse>;
  activateTrip(tripId: string, input: TripActivationRequest): Promise<TripActivationResponse>;
  updateTripTitle(tripId: string, input: UpdateTripTitleInput): Promise<UpdateTripTitleResponse>;
  updateDraftTripBrief?(tripId: string, input: UpdateDraftTripBriefInput): Promise<UpdateDraftTripBriefResponse>;

  // ── Team Agent 协作编排 (Phase 5) ────────────────────────────────────────────
  // These are intentionally optional so existing partial mocks and consumers
  // can adopt them incrementally without touching the entire test suite.
  createConstraintProposal?(tripId: string, input: CreateTripConstraintProposalRequest, options?: { idempotencyKey?: string }): Promise<TripConstraintProposal>;
  listMyConstraintProposals?(tripId: string): Promise<TripConstraintProposalsResponse>;
  confirmConstraintProposal?(tripId: string, proposalId: string, input: ConfirmTripConstraintProposalRequest, options?: { idempotencyKey?: string }): Promise<ConfirmProposalResponse>;
  dismissConstraintProposal?(tripId: string, proposalId: string, options?: { idempotencyKey?: string }): Promise<{ dismissed: true; proposalId: string }>;
  upsertConstraintFact?(tripId: string, factId: string, input: UpsertTripConstraintFactRequest, options?: { idempotencyKey?: string }): Promise<UpsertFactResponse>;
  revokeConstraintFact?(tripId: string, factId: string, options?: { idempotencyKey?: string }): Promise<UpsertFactResponse>;
  listConstraintsForMembers?(tripId: string): Promise<TripConstraintsResponse>;
  listConstraintsForOwner?(tripId: string): Promise<TripConstraintsOwnerResponse>;
  castAdoptionVote?(planId: string, input: CastAdoptionVoteRequest, options?: { idempotencyKey?: string }): Promise<AdoptionVoteResponse>;
  listAdoptionVotes?(planId: string): Promise<AdoptionVoteListResponse>;
  listTripPlans?(tripId: string): Promise<TripPlansListResponse>;

  // ── Global POI & ground mobility (Phase 2) ──────────────────────────────────
  // Optional methods to preserve Phase-5 style incremental adoption. The web
  // calls each behind `enabled: !!api.<method>` to avoid breaking older mocks.
  listTripPlaces?(tripId: string): Promise<TripPlacesResponse>;
  searchPlaceCandidates?(tripId: string, input: PlaceCandidateSearchRequest, options?: { idempotencyKey?: string }): Promise<PlaceCandidateSearchResponse>;
  proposeTripPlace?(tripId: string, input: ProposeTripPlaceRequest, options?: { idempotencyKey?: string }): Promise<TripPlaceActionResponse>;
  adoptTripPlace?(tripId: string, input: AdoptTripPlaceRequest, options?: { idempotencyKey?: string }): Promise<TripPlaceActionResponse>;
  revokeTripPlace?(tripId: string, input: RevokeTripPlaceRequest, options?: { idempotencyKey?: string }): Promise<TripPlaceActionResponse>;
}
